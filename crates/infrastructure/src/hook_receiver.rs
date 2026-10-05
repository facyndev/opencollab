//! Receptor local de los hooks HTTP de Claude Code.
//!
//! Un solo listener por app, en `127.0.0.1` y puerto aleatorio. Cada lanzamiento
//! de Claude Code tiene su propio secreto (`token`) metido en la URL de sus
//! hooks (`/hook/<token>`): sin un token registrado la respuesta es 401, así que
//! otro proceso local que adivine el puerto no puede inyectar estado. Sin
//! runtime async: un hilo por conexión, con plazos de lectura/escritura y tope de
//! conexiones simultáneas. Nunca se hace esperar al agente: la respuesta es `{}`.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use application::ports::PortError;
use application::AgentEventSink;
use domain::TerminalId;
use serde_json::Value;

use crate::claude_hooks::ClaudeHookTranslator;

/// Tope del encabezado HTTP.
const MAX_HEADER: usize = 16 * 1024;
/// Tope del cuerpo: los payloads de hooks son pequeños (el más grande trae el
/// último mensaje del asistente o la entrada de una herramienta).
const MAX_BODY: usize = 256 * 1024;
/// Conexiones atendidas a la vez; el resto se rechaza con 503.
const MAX_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

struct Route {
    /// `None` entre `register` y `bind`: los eventos se aceptan pero se descartan.
    target: Option<(TerminalId, Arc<dyn AgentEventSink>)>,
    translator: ClaudeHookTranslator,
}

type Routes = Arc<Mutex<HashMap<String, Route>>>;

pub struct HookReceiver {
    port: u16,
    routes: Routes,
}

impl HookReceiver {
    /// Abre el listener y lanza el hilo que acepta conexiones.
    pub fn start() -> Result<Arc<Self>, PortError> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| PortError::new(format!("no se pudo abrir el receptor de hooks: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| PortError::new(e.to_string()))?
            .port();
        let routes: Routes = Arc::default();
        let accept_routes = routes.clone();
        thread::spawn(move || {
            let active = Arc::new(AtomicUsize::new(0));
            for stream in listener.incoming().flatten() {
                if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::SeqCst);
                    let _ = respond(&stream, 503, "Service Unavailable");
                    continue;
                }
                let (routes, active) = (accept_routes.clone(), active.clone());
                thread::spawn(move || {
                    let _ = handle(stream, &routes);
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Ok(Arc::new(Self { port, routes }))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Da de alta un lanzamiento: desde ahora su token se acepta.
    pub fn register(&self, token: &str) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.insert(
                token.to_string(),
                Route {
                    target: None,
                    translator: ClaudeHookTranslator::new(),
                },
            );
        }
    }

    /// Con la terminal creada: los eventos de ese token van a `sink`.
    pub fn bind(&self, token: &str, terminal: TerminalId, sink: Arc<dyn AgentEventSink>) {
        if let Ok(mut routes) = self.routes.lock() {
            if let Some(route) = routes.get_mut(token) {
                route.target = Some((terminal, sink));
            }
        }
    }

    /// Da de baja el token (la terminal se cerró): vuelve a responder 401.
    pub fn unregister(&self, token: &str) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(token);
        }
    }
}

fn respond(mut stream: &TcpStream, status: u16, reason: &str) -> io::Result<()> {
    let body = if status == 200 { "{}" } else { "" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())
}

/// Lee hasta el fin del encabezado. Devuelve el encabezado y los bytes del
/// cuerpo que ya llegaron en la misma lectura.
fn read_head(stream: &mut TcpStream) -> io::Result<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            return Ok((head, buf[end + 4..].to_vec()));
        }
        if buf.len() > MAX_HEADER {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "encabezado largo",
            ));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn handle(mut stream: TcpStream, routes: &Routes) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let (head, mut body) = read_head(&mut stream)?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split_whitespace();
    let (method, path) = (request_line.next(), request_line.next());
    if method != Some("POST") {
        return respond(&stream, 405, "Method Not Allowed");
    }
    let Some(token) = path.and_then(|p| p.strip_prefix("/hook/")) else {
        return respond(&stream, 404, "Not Found");
    };
    // Autenticación antes de leer el cuerpo.
    let known = routes.lock().is_ok_and(|r| r.contains_key(token));
    if !known {
        return respond(&stream, 401, "Unauthorized");
    }
    let length = lines.find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())?
    });
    let Some(length) = length else {
        return respond(&stream, 411, "Length Required");
    };
    if length > MAX_BODY {
        return respond(&stream, 413, "Payload Too Large");
    }
    let mut chunk = [0u8; 4096];
    while body.len() < length {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return respond(&stream, 400, "Bad Request");
    };
    dispatch(routes, token, &payload);
    respond(&stream, 200, "OK")
}

/// Traduce el payload y lo entrega fuera del candado de las rutas.
fn dispatch(routes: &Routes, token: &str, payload: &Value) {
    let delivery = {
        let Ok(mut routes) = routes.lock() else {
            return;
        };
        let Some(route) = routes.get_mut(token) else {
            return;
        };
        let events = route.translator.translate(payload);
        route
            .target
            .as_ref()
            .map(|(terminal, sink)| (*terminal, sink.clone(), events))
    };
    if let Some((terminal, sink, events)) = delivery {
        for event in events {
            sink.emit(terminal, event);
        }
    }
}

#[cfg(test)]
mod tests {
    use application::{AgentEvent, AgentStatus};
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(TerminalId, AgentEvent)>>);
    impl AgentEventSink for Recorder {
        fn emit(&self, terminal: TerminalId, event: AgentEvent) {
            self.0.lock().unwrap().push((terminal, event));
        }
    }

    /// Manda un pedido crudo y devuelve el código de estado y el cuerpo.
    fn request(port: u16, raw: &str) -> (u16, String) {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status = response.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    fn post(port: u16, path: &str, body: &str) -> (u16, String) {
        request(
            port,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    fn bound() -> (Arc<HookReceiver>, Arc<Recorder>, TerminalId) {
        let receiver = HookReceiver::start().unwrap();
        let sink = Arc::new(Recorder::default());
        let terminal = TerminalId::new();
        receiver.register("tok");
        receiver.bind("tok", terminal, sink.clone());
        (receiver, sink, terminal)
    }

    #[test]
    fn a_registered_token_delivers_translated_events_and_answers_empty_json() {
        let (receiver, sink, terminal) = bound();
        let body = json!({ "hook_event_name": "UserPromptSubmit", "prompt": "hi" }).to_string();
        let (status, response) = post(receiver.port(), "/hook/tok", &body);
        assert_eq!((status, response.as_str()), (200, "{}"));
        assert_eq!(
            *sink.0.lock().unwrap(),
            vec![(
                terminal,
                AgentEvent::StatusChanged {
                    status: AgentStatus::Working
                }
            )]
        );
    }

    #[test]
    fn an_unknown_token_is_rejected_and_delivers_nothing() {
        let (receiver, sink, _) = bound();
        let body = json!({ "hook_event_name": "UserPromptSubmit" }).to_string();
        assert_eq!(post(receiver.port(), "/hook/wrong", &body).0, 401);
        assert_eq!(post(receiver.port(), "/hook/", &body).0, 401);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unregistered_token_stops_working() {
        let (receiver, sink, _) = bound();
        receiver.unregister("tok");
        let body = json!({ "hook_event_name": "UserPromptSubmit" }).to_string();
        assert_eq!(post(receiver.port(), "/hook/tok", &body).0, 401);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn events_before_bind_are_accepted_but_dropped() {
        let receiver = HookReceiver::start().unwrap();
        receiver.register("tok");
        let body = json!({ "hook_event_name": "UserPromptSubmit" }).to_string();
        assert_eq!(post(receiver.port(), "/hook/tok", &body).0, 200);
    }

    #[test]
    fn oversized_bodies_are_rejected_before_being_read() {
        let (receiver, sink, _) = bound();
        let raw = format!(
            "POST /hook/tok HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert_eq!(request(receiver.port(), &raw).0, 413);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn other_methods_paths_and_bad_bodies_are_refused() {
        let (receiver, _, _) = bound();
        let port = receiver.port();
        assert_eq!(request(port, "GET /hook/tok HTTP/1.1\r\n\r\n").0, 405);
        assert_eq!(post(port, "/other/tok", "{}").0, 404);
        assert_eq!(post(port, "/hook/tok", "not json").0, 400);
        assert_eq!(
            request(port, "POST /hook/tok HTTP/1.1\r\n\r\n").0,
            411,
            "sin Content-Length"
        );
    }

    #[test]
    fn a_body_split_across_writes_is_reassembled() {
        let (receiver, sink, _) = bound();
        let body = json!({ "hook_event_name": "Stop" }).to_string();
        let head = format!(
            "POST /hook/tok HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, receiver.port())).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        stream.flush().unwrap();
        thread::sleep(Duration::from_millis(50));
        stream.write_all(body.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }
}
