//! Adaptador de OpenCode: servidor local (`--port`) + cliente SSE de `/event`.
//!
//! `opencode --port <p> --hostname 127.0.0.1` mantiene la TUI y además expone su
//! API HTTP. El servidor se protege con `OPENCODE_SERVER_PASSWORD` (autenticación
//! básica, usuario `opencode`) que se genera por lanzamiento y viaja solo por el
//! entorno del proceso. `bind` arranca un hilo que se conecta a `GET /event`
//! (reintenta mientras la TUI arranca), traduce cada evento con
//! [`OpenCodeTranslator`] y se detiene al cerrar la terminal.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use application::ports::PortError;
use application::{
    AgentAdapter, AgentEvent, AgentEventSink, AgentStatus, KnownAgent, LaunchAugmentation,
};
use domain::TerminalId;
use serde_json::Value;

use crate::opencode_events::OpenCodeTranslator;
use crate::sse::{basic_auth, parse_response_head, sse_data, ChunkDecoder, LineSplitter};

const USERNAME: &str = "opencode";
const PASSWORD_ENV: &str = "OPENCODE_SERVER_PASSWORD";
/// Tope de una línea del stream: los eventos de partes con salida de
/// herramientas pueden ser grandes, pero no ilimitados.
const MAX_LINE: usize = 1024 * 1024;
/// Plazo de lectura: también es cada cuánto se mira si hay que detenerse.
const READ_TIMEOUT: Duration = Duration::from_secs(1);

/// Cuánto insistir antes de rendirse.
#[derive(Clone, Copy)]
struct Patience {
    /// Desde `bind` hasta la primera conexión (la TUI tarda en levantar el servidor).
    first_connection: Duration,
    /// Tras perder una conexión ya establecida.
    reconnect: Duration,
    retry_every: Duration,
}

const PATIENCE: Patience = Patience {
    first_connection: Duration::from_secs(90),
    reconnect: Duration::from_secs(10),
    retry_every: Duration::from_millis(300),
};

#[derive(Default)]
pub struct OpenCodeAdapter {
    /// Terminal -> señal de parada de su hilo SSE.
    streams: Mutex<HashMap<TerminalId, Arc<AtomicBool>>>,
}

impl OpenCodeAdapter {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Puerto libre de localhost. Hay una ventana mínima entre soltarlo y que
/// OpenCode lo tome; si alguien lo gana, OpenCode falla al arrancar y se nota.
fn free_port() -> Result<u16, PortError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| PortError::new(format!("no hay puerto local libre: {e}")))?;
    Ok(listener
        .local_addr()
        .map_err(|e| PortError::new(e.to_string()))?
        .port())
}

impl AgentAdapter for OpenCodeAdapter {
    fn agent(&self) -> KnownAgent {
        KnownAgent::OpenCode
    }

    fn prepare(&self) -> Result<LaunchAugmentation, PortError> {
        let port = free_port()?;
        let password = uuid::Uuid::new_v4().simple().to_string();
        Ok(LaunchAugmentation {
            args: vec![
                "--port".into(),
                port.to_string(),
                "--hostname".into(),
                "127.0.0.1".into(),
            ],
            env: vec![(PASSWORD_ENV.into(), password.clone())],
            // `puerto:clave`: lo único que `bind` necesita para conectarse.
            token: format!("{port}:{password}"),
        })
    }

    fn bind(&self, token: &str, terminal: TerminalId, events: Arc<dyn AgentEventSink>) {
        let Some((port, password)) = token
            .split_once(':')
            .and_then(|(p, pw)| Some((p.parse::<u16>().ok()?, pw.to_string())))
        else {
            return;
        };
        let stop = Arc::new(AtomicBool::new(false));
        if let Ok(mut streams) = self.streams.lock() {
            streams.insert(terminal, stop.clone());
        }
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        thread::spawn(move || run_stream(addr, &password, terminal, events, &stop, PATIENCE));
    }

    fn release(&self, terminal: TerminalId) {
        let stop = self
            .streams
            .lock()
            .ok()
            .and_then(|mut s| s.remove(&terminal));
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

enum Outcome {
    /// Nunca se pudo conectar.
    Unreachable,
    /// Hubo conexión y terminó (el servidor cerró o se cortó).
    Streamed,
    /// 401 u otra respuesta definitiva: no tiene sentido reintentar.
    Fatal,
}

fn run_stream(
    addr: SocketAddr,
    password: &str,
    terminal: TerminalId,
    events: Arc<dyn AgentEventSink>,
    stop: &AtomicBool,
    patience: Patience,
) {
    let mut translator = OpenCodeTranslator::new();
    let mut last_progress = Instant::now();
    let mut connected_once = false;
    while !stop.load(Ordering::SeqCst) {
        match stream_once(addr, password, terminal, &events, &mut translator, stop) {
            Outcome::Fatal => return,
            Outcome::Streamed => {
                connected_once = true;
                last_progress = Instant::now();
                // El servidor se fue (OpenCode salió): el agente ya no trabaja.
                events.emit(
                    terminal,
                    AgentEvent::StatusChanged {
                        status: AgentStatus::Idle,
                    },
                );
            }
            Outcome::Unreachable => {}
        }
        let limit = if connected_once {
            patience.reconnect
        } else {
            patience.first_connection
        };
        if last_progress.elapsed() >= limit {
            return;
        }
        sleep_unless_stopped(patience.retry_every, stop);
    }
}

fn sleep_unless_stopped(total: Duration, stop: &AtomicBool) {
    let step = Duration::from_millis(50);
    let mut slept = Duration::ZERO;
    while slept < total && !stop.load(Ordering::SeqCst) {
        thread::sleep(step);
        slept += step;
    }
}

fn stream_once(
    addr: SocketAddr,
    password: &str,
    terminal: TerminalId,
    events: &Arc<dyn AgentEventSink>,
    translator: &mut OpenCodeTranslator,
    stop: &AtomicBool,
) -> Outcome {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return Outcome::Unreachable;
    };
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let request = format!(
        "GET /event HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\nAuthorization: {}\r\nConnection: close\r\n\r\n",
        basic_auth(USERNAME, password)
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Outcome::Unreachable;
    }

    let mut head_buf = Vec::new();
    let mut decoder: Option<ChunkDecoder> = None;
    let mut lines = LineSplitter::new(MAX_LINE);
    let mut headed = false;
    let mut chunk = [0u8; 8192];
    while !stop.load(Ordering::SeqCst) {
        let n = match stream.read(&mut chunk) {
            Ok(0) => return Outcome::Streamed,
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(_) => {
                return if headed {
                    Outcome::Streamed
                } else {
                    Outcome::Unreachable
                }
            }
        };
        let mut body: &[u8] = &chunk[..n];
        let owned;
        if !headed {
            head_buf.extend_from_slice(body);
            let Some(head) = parse_response_head(&head_buf) else {
                if head_buf.len() > 16 * 1024 {
                    return Outcome::Fatal;
                }
                continue;
            };
            if head.status != 200 {
                return Outcome::Fatal;
            }
            headed = true;
            if head.chunked {
                decoder = Some(ChunkDecoder::default());
            }
            owned = head_buf[head.len..].to_vec();
            body = &owned;
        }
        let decoded;
        if let Some(decoder) = decoder.as_mut() {
            decoded = decoder.feed(body);
            body = &decoded;
        }
        for line in lines.feed(body) {
            let Some(data) = sse_data(&line) else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            for event in translator.translate(&event) {
                events.emit(terminal, event);
            }
        }
        if decoder.as_ref().is_some_and(ChunkDecoder::finished) {
            return Outcome::Streamed;
        }
    }
    Outcome::Streamed
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};

    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<AgentEvent>>);
    impl AgentEventSink for Recorder {
        fn emit(&self, _: TerminalId, event: AgentEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    const FAST: Patience = Patience {
        first_connection: Duration::from_secs(5),
        reconnect: Duration::from_millis(300),
        retry_every: Duration::from_millis(20),
    };

    /// Servidor SSE falso: exige la clave, responde en `chunked` y parte un
    /// evento a la mitad. Devuelve el encabezado `Authorization` que recibió.
    fn fake_server(password: &'static str) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut auth = String::new();
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.strip_prefix("Authorization: ") {
                    auth = v.trim().to_string();
                }
            }
            assert!(request_line.starts_with("GET /event "));
            if auth != basic_auth(USERNAME, password) {
                stream
                    .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                    .unwrap();
                return;
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            let heartbeat = "data: {\"type\":\"server.heartbeat\",\"properties\":{}}\n\n";
            let busy = "data: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"s\",\"status\":{\"type\":\"busy\"}}}\n\n";
            let write_chunk = |stream: &mut TcpStream, data: &str| {
                write!(stream, "{:x}\r\n{data}\r\n", data.len()).unwrap();
                stream.flush().unwrap();
            };
            write_chunk(&mut stream, heartbeat);
            // Un evento partido en dos bloques.
            let (a, b) = busy.split_at(30);
            write_chunk(&mut stream, a);
            thread::sleep(Duration::from_millis(30));
            write_chunk(&mut stream, b);
            thread::sleep(Duration::from_millis(100));
            stream.write_all(b"0\r\n\r\n").unwrap();
        });
        (addr, handle)
    }

    fn wait_for(sink: &Recorder, count: usize) {
        for _ in 0..200 {
            if sink.0.lock().unwrap().len() >= count {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("eventos recibidos: {:?}", sink.0.lock().unwrap());
    }

    #[test]
    fn prepare_picks_a_localhost_port_and_a_password_per_launch() {
        let adapter = OpenCodeAdapter::new();
        let (a, b) = (adapter.prepare().unwrap(), adapter.prepare().unwrap());
        assert_eq!(a.args[0], "--port");
        assert_eq!(
            a.args[2..],
            ["--hostname".to_string(), "127.0.0.1".to_string()]
        );
        let port: u16 = a.args[1].parse().unwrap();
        assert!(port > 0);
        let (env_key, password) = &a.env[0];
        assert_eq!(env_key, PASSWORD_ENV);
        assert!(password.len() >= 32);
        assert_eq!(a.token, format!("{port}:{password}"));
        assert_ne!(a.env[0].1, b.env[0].1, "clave distinta por lanzamiento");
    }

    #[test]
    fn the_stream_authenticates_decodes_chunks_and_translates_events() {
        let (addr, server) = fake_server("pw");
        let sink = Arc::new(Recorder::default());
        let stop = Arc::new(AtomicBool::new(false));
        let events: Arc<dyn AgentEventSink> = sink.clone();
        let stop2 = stop.clone();
        let worker = thread::spawn(move || {
            run_stream(addr, "pw", TerminalId::new(), events, &stop2, FAST);
        });
        wait_for(&sink, 1);
        // El evento partido llegó entero; luego el servidor cierra y el hilo avisa idle.
        wait_for(&sink, 2);
        worker.join().unwrap();
        server.join().unwrap();
        assert_eq!(
            *sink.0.lock().unwrap(),
            vec![
                AgentEvent::StatusChanged {
                    status: AgentStatus::Working
                },
                AgentEvent::StatusChanged {
                    status: AgentStatus::Idle
                },
            ]
        );
    }

    #[test]
    fn a_wrong_password_gives_up_without_events() {
        let (addr, server) = fake_server("right");
        let sink = Arc::new(Recorder::default());
        let events: Arc<dyn AgentEventSink> = sink.clone();
        run_stream(
            addr,
            "wrong",
            TerminalId::new(),
            events,
            &AtomicBool::new(false),
            FAST,
        );
        server.join().unwrap();
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn it_gives_up_when_nothing_ever_listens_and_stops_on_release() {
        // Puerto cerrado: sin servidor, con poca paciencia termina solo.
        let closed = {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            l.local_addr().unwrap()
        };
        let sink: Arc<dyn AgentEventSink> = Arc::new(Recorder::default());
        let impatient = Patience {
            first_connection: Duration::from_millis(100),
            ..FAST
        };
        let started = Instant::now();
        run_stream(
            closed,
            "pw",
            TerminalId::new(),
            sink.clone(),
            &AtomicBool::new(false),
            impatient,
        );
        assert!(started.elapsed() < Duration::from_secs(3));

        // Con la señal de parada ya puesta no entra al ciclo.
        let stop = AtomicBool::new(true);
        let started = Instant::now();
        run_stream(closed, "pw", TerminalId::new(), sink, &stop, FAST);
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn release_signals_the_stream_of_that_terminal_only() {
        let adapter = OpenCodeAdapter::new();
        let (a, b) = (TerminalId::new(), TerminalId::new());
        let (flag_a, flag_b) = (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        );
        {
            let mut streams = adapter.streams.lock().unwrap();
            streams.insert(a, flag_a.clone());
            streams.insert(b, flag_b.clone());
        }
        adapter.release(a);
        assert!(flag_a.load(Ordering::SeqCst));
        assert!(!flag_b.load(Ordering::SeqCst));
        adapter.release(a);
    }

    #[test]
    fn bind_ignores_a_malformed_token() {
        let adapter = OpenCodeAdapter::new();
        let sink: Arc<dyn AgentEventSink> = Arc::new(Recorder::default());
        adapter.bind("garbage", TerminalId::new(), sink);
        assert!(adapter.streams.lock().unwrap().is_empty());
    }
}
