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
//! método distinto de POST; `413` cuerpo demasiado grande. Escucha solo en
//! `127.0.0.1` con puerto aleatorio. Solo parsea HTTP y reenvía al `sink`:
//! la interpretación del payload es de `application`.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use application::{KnownAgent, RawSubagentEvent};
use domain::TerminalId;
use uuid::Uuid;

const MAX_BODY: usize = 1024 * 1024;
const MAX_HEAD: usize = 16 * 1024;
/// Un cliente lento o mudo no debe retener su hilo indefinidamente.
const IO_TIMEOUT: Duration = Duration::from_secs(2);

type Sink = dyn Fn(RawSubagentEvent) + Send + Sync;

/// Servidor en un hilo propio; se detiene con [`HookReceiver::shutdown`] o al
/// soltarlo.
pub struct HookReceiver {
    url: String,
    token: String,
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl HookReceiver {
    /// Abre `127.0.0.1:0` y empieza a entregar cada evento aceptado a `sink`.
    pub fn start(sink: impl Fn(RawSubagentEvent) + Send + Sync + 'static) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let addr = listener.local_addr()?;
        let token = Uuid::new_v4().simple().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let sink: Arc<Sink> = Arc::new(sink);

        let thread = {
            let (stop, token) = (stop.clone(), token.clone());
            thread::Builder::new()
                .name("hook-receiver".into())
                .spawn(move || accept_loop(listener, stop, token, sink))?
        };
        Ok(Self {
            url: format!("http://{addr}/hook"),
            token,
            addr,
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

    /// Detiene el hilo y libera el puerto.
    pub fn shutdown(self) {}
}

impl Drop for HookReceiver {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Despierta el `accept` bloqueado para que vea la bandera.
        let _ = TcpStream::connect_timeout(&self.addr, IO_TIMEOUT);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, token: String, sink: Arc<Sink>) {
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let (token, sink) = (token.clone(), sink.clone());
        // Un hilo por conexión: un cliente lento no frena a los demás.
        let _ = thread::Builder::new()
            .name("hook-connection".into())
            .spawn(move || handle_connection(stream, &token, sink.as_ref()));
    }
}

fn handle_connection(mut stream: TcpStream, token: &str, sink: &Sink) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let status = match process(&mut stream, token, sink) {
        Ok(()) => 204,
        Err(status) => status,
    };
    let reason = match status {
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Payload Too Large",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.flush();
}

/// Valida el pedido y entrega el evento. `Err` lleva el código HTTP a responder.
fn process(stream: &mut TcpStream, token: &str, sink: &Sink) -> Result<(), u16> {
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

    if !bearer.is_some_and(|given| same_token(&given, token)) {
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

    sink(RawSubagentEvent {
        terminal,
        agent,
        payload,
    });
    Ok(())
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

    #[test]
    fn shutdown_stops_accepting_connections() {
        let (receiver, _rx) = start();
        let address = addr(&receiver);
        receiver.shutdown();
        assert!(TcpStream::connect(address).is_err());
    }
}
