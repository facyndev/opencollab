//! Receptor HTTP local de los hooks de los agentes.
//!
//! Esquema (lo siguen el sidecar `opencollab-hook` y el plugin de OpenCode):
//!
//! ```text
//! POST /hook/<agente>            <agente> = KnownAgent::id (claude-code, opencode, codex…)
//! Authorization: Bearer <token>  el de OPENCOLLAB_HOOK_TOKEN
//! X-OpenCollab-Terminal: <uuid>  el de OPENCOLLAB_TERMINAL_ID
//! Content-Length: <n>            cuerpo = payload crudo del agente (máx. 1 MiB)
//! ```
//!
//! Respuestas: `204` aceptado; `400` pedido malformado o terminal inválida;
//! `401` token ausente o incorrecto; `404` ruta o agente desconocido; `405`
//! método distinto de POST; `413` cuerpo demasiado grande; `503` receptor
//! detenido o tope de 32 conexiones simultáneas alcanzado. Escucha solo en
//! `127.0.0.1` con puerto aleatorio; el `accept` es no bloqueante (así
//! `shutdown` nunca se cuelga) y tras `shutdown` el `sink` no se invoca más. Solo parsea HTTP y reenvía al `sink`:
//! la interpretación del payload es de `application`.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use application::{KnownAgent, RawSubagentEvent};
use domain::TerminalId;
use uuid::Uuid;

const MAX_BODY: usize = 1024 * 1024;
const MAX_HEAD: usize = 16 * 1024;
/// Un cliente lento o mudo no debe retener su hilo indefinidamente.
const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// Tope de conexiones atendidas a la vez; las que sobran reciben `503`.
const MAX_CONNECTIONS: usize = 32;
/// Cada cuánto el hilo de `accept` mira la bandera de parada.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

type Sink = dyn Fn(RawSubagentEvent) + Send + Sync;

/// Parámetros internos del servidor; los tests los achican.
#[derive(Clone, Copy)]
struct Config {
    io_timeout: Duration,
    max_connections: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            io_timeout: IO_TIMEOUT,
            max_connections: MAX_CONNECTIONS,
        }
    }
}

/// Estado compartido entre el hilo de `accept` y los de cada conexión.
struct Shared {
    token: String,
    sink: Arc<Sink>,
    io_timeout: Duration,
    max_connections: usize,
    /// Conexiones en curso (las cuenta el `accept`, las libera cada hilo).
    active: AtomicUsize,
    /// Compuerta del `sink`: se mira y se usa bajo el mismo candado, así que
    /// una vez cerrada por `shutdown` ya no hay entrega posible ni en vuelo.
    open: Mutex<bool>,
}

impl Shared {
    fn deliver(&self, event: RawSubagentEvent) -> Result<(), u16> {
        let open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if !*open {
            return Err(503);
        }
        (self.sink)(event);
        Ok(())
    }

    fn close(&self) {
        // Espera a una entrega en curso (si la hay) y cierra la compuerta.
        *self.open.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

/// Libera el cupo de la conexión al terminar su hilo, pase lo que pase.
struct Slot(Arc<Shared>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Servidor en un hilo propio; se detiene con [`HookReceiver::shutdown`] o al
/// soltarlo.
pub struct HookReceiver {
    url: String,
    token: String,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl HookReceiver {
    /// Abre `127.0.0.1:0` y empieza a entregar cada evento aceptado a `sink`.
    pub fn start(sink: impl Fn(RawSubagentEvent) + Send + Sync + 'static) -> io::Result<Self> {
        Self::start_with(Config::default(), sink)
    }

    fn start_with(
        config: Config,
        sink: impl Fn(RawSubagentEvent) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        // Sin `accept` bloqueante: el hilo sondea y siempre ve la bandera.
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let token = Uuid::new_v4().simple().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            token: token.clone(),
            sink: Arc::new(sink),
            io_timeout: config.io_timeout,
            max_connections: config.max_connections,
            active: AtomicUsize::new(0),
            open: Mutex::new(true),
        });

        let thread = {
            let (stop, shared) = (stop.clone(), shared.clone());
            thread::Builder::new()
                .name("hook-receiver".into())
                .spawn(move || accept_loop(listener, stop, shared))?
        };
        Ok(Self {
            url: format!("http://{addr}/hook"),
            token,
            shared,
            stop,
            thread: Some(thread),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Detiene el hilo y libera el puerto. Al volver, el `sink` no se invoca
    /// más; las conexiones en vuelo terminan solas por su timeout de E/S.
    pub fn shutdown(self) {}
}

impl Drop for HookReceiver {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.shared.close();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, shared: Arc<Shared>) {
    while !stop.load(Ordering::SeqCst) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(_) => {
                thread::sleep(POLL_INTERVAL);
                continue;
            }
        };
        // El socket aceptado hereda el modo no bloqueante en algunas
        // plataformas: se vuelve a bloqueante con los timeouts de E/S.
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        if shared.active.fetch_add(1, Ordering::SeqCst) >= shared.max_connections {
            shared.active.fetch_sub(1, Ordering::SeqCst);
            reject(stream, &shared);
            continue;
        }
        let slot = Slot(shared.clone());
        // Un hilo por conexión: un cliente lento no frena a los demás.
        let spawned = thread::Builder::new()
            .name("hook-connection".into())
            .spawn({
                let shared = shared.clone();
                move || handle_connection(stream, &shared, slot)
            });
        // Si no hubo hilo, el cierre del closure soltó el `Slot` y el socket.
        drop(spawned);
    }
}

/// Sobrecarga: responde `503` sin leer el pedido y cierra.
fn reject(mut stream: TcpStream, shared: &Shared) {
    let _ = stream.set_write_timeout(Some(shared.io_timeout));
    respond(&mut stream, 503);
}

fn handle_connection(mut stream: TcpStream, shared: &Shared, slot: Slot) {
    let _ = stream.set_read_timeout(Some(shared.io_timeout));
    let _ = stream.set_write_timeout(Some(shared.io_timeout));
    let status = match process(&mut stream, shared) {
        Ok(()) => 204,
        Err(status) => status,
    };
    // El cupo se libera antes de responder: cuando el cliente ve la respuesta
    // (y abre la siguiente conexión) ya no cuenta como ocupado.
    drop(slot);
    respond(&mut stream, status);
}

fn respond(stream: &mut TcpStream, status: u16) {
    let reason = match status {
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "Payload Too Large",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.flush();
}

/// Valida el pedido y entrega el evento. `Err` lleva el código HTTP a responder.
fn process(stream: &mut TcpStream, shared: &Shared) -> Result<(), u16> {
    let (head, mut body) = read_head(stream)?;
    let head = std::str::from_utf8(&head).map_err(|_| 400u16)?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(path), Some(_version)) = (
        request_line.next(),
        request_line.next(),
        request_line.next(),
    ) else {
        return Err(400);
    };

    let agent = path
        .strip_prefix("/hook/")
        .and_then(KnownAgent::from_id)
        .ok_or(404u16)?;
    if method != "POST" {
        return Err(405);
    }

    let (mut bearer, mut terminal, mut length) = (None, None, None);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(400);
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "authorization" => bearer = value.strip_prefix("Bearer ").map(str::to_owned),
            "x-opencollab-terminal" => terminal = Some(value.to_owned()),
            "content-length" => length = Some(value.parse::<usize>().map_err(|_| 400u16)?),
            _ => {}
        }
    }

    if !bearer.is_some_and(|given| same_token(&given, &shared.token)) {
        return Err(401);
    }
    let terminal: TerminalId = terminal.ok_or(400u16)?.parse().map_err(|_| 400u16)?;
    let length = length.ok_or(400u16)?;
    if length > MAX_BODY {
        return Err(413);
    }

    // Lo que ya llegó junto al encabezado cuenta; el resto se lee del socket.
    body.truncate(length);
    let already = body.len();
    body.resize(length, 0);
    stream
        .read_exact(&mut body[already..])
        .map_err(|_| 400u16)?;
    let payload = String::from_utf8(body).map_err(|_| 400u16)?;

    shared.deliver(RawSubagentEvent {
        terminal,
        agent,
        payload,
    })
}

/// Lee hasta el fin de los encabezados. Devuelve (encabezados, bytes de cuerpo
/// ya leídos).
fn read_head(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), u16> {
    const END: &[u8] = b"\r\n\r\n";
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(pos) = buf.windows(END.len()).position(|w| w == END) {
            let body = buf.split_off(pos + END.len());
            buf.truncate(pos);
            return Ok((buf, body));
        }
        if buf.len() > MAX_HEAD {
            return Err(400);
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return Err(400),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// Comparación sin cortocircuito para no filtrar el token por tiempos.
fn same_token(given: &str, expected: &str) -> bool {
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::mpsc::{channel, Receiver};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    use application::{KnownAgent, RawSubagentEvent};
    use domain::TerminalId;

    use super::*;

    fn start() -> (HookReceiver, Receiver<RawSubagentEvent>) {
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let receiver = HookReceiver::start(move |event| {
            let _ = tx.lock().unwrap().send(event);
        })
        .unwrap();
        (receiver, rx)
    }

    fn addr(receiver: &HookReceiver) -> String {
        receiver
            .url()
            .trim_start_matches("http://")
            .trim_end_matches("/hook")
            .to_string()
    }

    /// Manda bytes crudos y devuelve el código de estado de la respuesta.
    fn raw(receiver: &HookReceiver, request: &[u8]) -> u16 {
        let mut stream = TcpStream::connect(addr(receiver)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0)
    }

    fn post(path: &str, token: &str, terminal: &str, body: &str) -> Vec<u8> {
        format!(
            "POST {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n\
             X-OpenCollab-Terminal: {terminal}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn valid_event_reaches_the_sink() {
        let (receiver, rx) = start();
        let terminal = TerminalId::new();
        let request = post(
            "/hook/claude-code",
            receiver.token(),
            &terminal.to_string(),
            r#"{"a":1}"#,
        );
        assert_eq!(raw(&receiver, &request), 204);
        let event = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.terminal, terminal);
        assert_eq!(event.agent, KnownAgent::ClaudeCode);
        assert_eq!(event.payload, r#"{"a":1}"#);
    }

    #[test]
    fn url_points_to_the_bound_loopback_port() {
        let (receiver, _rx) = start();
        assert!(receiver.url().starts_with("http://127.0.0.1:"));
        assert!(receiver.url().ends_with("/hook"));
        assert!(!receiver.token().is_empty());
    }

    #[test]
    fn wrong_or_missing_token_is_401_and_delivers_nothing() {
        let (receiver, rx) = start();
        let t = TerminalId::new().to_string();
        assert_eq!(raw(&receiver, &post("/hook/codex", "malo", &t, "{}")), 401);
        let no_auth = format!(
            "POST /hook/codex HTTP/1.1\r\nX-OpenCollab-Terminal: {t}\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        assert_eq!(raw(&receiver, no_auth.as_bytes()), 401);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn unknown_path_or_agent_is_404() {
        let (receiver, rx) = start();
        let t = TerminalId::new().to_string();
        let token = receiver.token().to_string();
        assert_eq!(raw(&receiver, &post("/otra", &token, &t, "{}")), 404);
        assert_eq!(
            raw(&receiver, &post("/hook/desconocido", &token, &t, "{}")),
            404
        );
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn missing_or_invalid_terminal_header_is_400() {
        let (receiver, _rx) = start();
        let token = receiver.token().to_string();
        assert_eq!(
            raw(&receiver, &post("/hook/codex", &token, "no-es-uuid", "{}")),
            400
        );
    }

    #[test]
    fn oversized_body_is_413() {
        let (receiver, rx) = start();
        let head = format!(
            "POST /hook/codex HTTP/1.1\r\nAuthorization: Bearer {}\r\n\
             X-OpenCollab-Terminal: {}\r\nContent-Length: 5000000\r\n\r\nxx",
            receiver.token(),
            TerminalId::new()
        );
        assert_eq!(raw(&receiver, head.as_bytes()), 413);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn garbage_is_400_and_server_keeps_working() {
        let (receiver, rx) = start();
        assert_eq!(raw(&receiver, b"\x00\xff basura sin sentido\r\n\r\n"), 400);
        assert_eq!(raw(&receiver, b"GET\r\n\r\n"), 400);
        let request = post(
            "/hook/opencode",
            receiver.token(),
            &TerminalId::new().to_string(),
            "{}",
        );
        assert_eq!(raw(&receiver, &request), 204);
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn non_post_method_is_405() {
        let (receiver, _rx) = start();
        let request = format!(
            "GET /hook/codex HTTP/1.1\r\nAuthorization: Bearer {}\r\n\r\n",
            receiver.token()
        );
        assert_eq!(raw(&receiver, request.as_bytes()), 405);
    }

    fn start_with(config: Config) -> (HookReceiver, Receiver<RawSubagentEvent>) {
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let receiver = HookReceiver::start_with(config, move |event| {
            let _ = tx.lock().unwrap().send(event);
        })
        .unwrap();
        (receiver, rx)
    }

    fn quick(io_timeout_ms: u64, max_connections: usize) -> Config {
        Config {
            io_timeout: Duration::from_millis(io_timeout_ms),
            max_connections,
        }
    }

    fn status_of(stream: &mut TcpStream) -> u16 {
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0)
    }

    fn connect(receiver: &HookReceiver) -> TcpStream {
        let stream = TcpStream::connect(addr(receiver)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
    }

    fn head(receiver: &HookReceiver, length: usize) -> String {
        format!(
            "POST /hook/codex HTTP/1.1\r\nAuthorization: Bearer {}\r\n\
             X-OpenCollab-Terminal: {}\r\nContent-Length: {length}\r\n\r\n",
            receiver.token(),
            TerminalId::new()
        )
    }

    #[test]
    fn body_split_across_writes_is_delivered_whole() {
        let (receiver, rx) = start();
        let mut stream = connect(&receiver);
        stream.write_all(head(&receiver, 9).as_bytes()).unwrap();
        for part in ["abc", "def", "ghi"] {
            thread::sleep(Duration::from_millis(30));
            stream.write_all(part.as_bytes()).unwrap();
        }
        assert_eq!(status_of(&mut stream), 204);
        let event = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.payload, "abcdefghi");
    }

    #[test]
    fn missing_content_length_is_400() {
        let (receiver, rx) = start();
        let request = format!(
            "POST /hook/codex HTTP/1.1\r\nAuthorization: Bearer {}\r\n\
             X-OpenCollab-Terminal: {}\r\n\r\n{{}}",
            receiver.token(),
            TerminalId::new()
        );
        assert_eq!(raw(&receiver, request.as_bytes()), 400);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn body_shorter_than_declared_is_400() {
        let (receiver, rx) = start_with(quick(150, 8));
        // El cliente no cierra: la respuesta llega por el timeout de lectura.
        let mut stream = connect(&receiver);
        let request = format!("{}abc", head(&receiver, 10));
        stream.write_all(request.as_bytes()).unwrap();
        assert_eq!(status_of(&mut stream), 400);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn missing_terminal_header_is_400() {
        let (receiver, rx) = start();
        let request = format!(
            "POST /hook/codex HTTP/1.1\r\nAuthorization: Bearer {}\r\n\
             Content-Length: 2\r\n\r\n{{}}",
            receiver.token()
        );
        assert_eq!(raw(&receiver, request.as_bytes()), 400);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn sink_is_never_called_after_shutdown_returns() {
        let (receiver, rx) = start();
        let mut stream = connect(&receiver);
        stream.write_all(head(&receiver, 2).as_bytes()).unwrap();
        // Dejar que el hilo de la conexión tome el pedido antes de cerrar.
        thread::sleep(Duration::from_millis(100));
        receiver.shutdown();
        // El cuerpo llega con el receptor ya detenido.
        let _ = stream.write_all(b"{}");
        let _ = status_of(&mut stream);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn connections_over_the_cap_get_503() {
        let (receiver, rx) = start_with(quick(2000, 2));
        let (_idle1, _idle2) = (connect(&receiver), connect(&receiver));
        let mut third = connect(&receiver);
        assert_eq!(status_of(&mut third), 503);
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn slots_are_released_when_connections_finish() {
        let (receiver, rx) = start_with(quick(2000, 1));
        for _ in 0..3 {
            let request = post(
                "/hook/codex",
                receiver.token(),
                &TerminalId::new().to_string(),
                "{}",
            );
            assert_eq!(raw(&receiver, &request), 204);
            rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
    }

    #[test]
    fn slot_is_free_once_the_client_sees_the_response() {
        let (receiver, rx) = start_with(quick(2000, 1));
        // `raw` lee hasta EOF: para entonces el cupo ya tiene que estar libre,
        // si no el siguiente cliente recibe un 503 falso.
        for _ in 0..200 {
            let request = post(
                "/hook/codex",
                receiver.token(),
                &TerminalId::new().to_string(),
                "{}",
            );
            assert_eq!(raw(&receiver, &request), 204);
            assert_eq!(receiver.shared.active.load(Ordering::SeqCst), 0);
            rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
    }

    #[test]
    fn shutdown_is_prompt_with_an_idle_connection_open() {
        let (receiver, _rx) = start();
        let _idle = connect(&receiver);
        let started = std::time::Instant::now();
        receiver.shutdown();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn shutdown_stops_accepting_connections() {
        let (receiver, _rx) = start();
        let address = addr(&receiver);
        receiver.shutdown();
        assert!(TcpStream::connect(address).is_err());
    }
}
