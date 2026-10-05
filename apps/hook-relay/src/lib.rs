//! Lógica del sidecar `opencollab-hook`, que Claude Code y Codex invocan como
//! hook de tipo `command`: lee el payload por stdin y lo reenvía al receptor
//! HTTP local de OpenCollab (contrato en `infrastructure::hook_receiver`).
//!
//! Regla de oro: nunca estorbar al agente. Todo error se ignora, no se imprime
//! nada y el proceso sale siempre con código 0. Solo se habla con
//! `http://127.0.0.1:<puerto>/...`, así el token jamás sale de la máquina.
//! Sin dependencias pesadas: solo `std::net`.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::Duration;

use application::{HookEndpoint, KnownAgent};

/// Mismo tope que el receptor; un payload mayor se descarta en silencio.
pub const MAX_BODY: usize = 1024 * 1024;
/// Presupuesto por operación (conexión, escritura, lectura de la respuesta).
pub const IO_TIMEOUT: Duration = Duration::from_millis(500);

/// Variables de entorno que OpenCollab inyecta en cada terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEnv {
    pub url: String,
    pub token: String,
    pub terminal: String,
}

impl HookEnv {
    /// `None` si falta alguna variable o está vacía (corriendo fuera de OpenCollab).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let get = |name: &str| lookup(name).filter(|v| !v.is_empty());
        Some(Self {
            url: get(HookEndpoint::ENV_URL)?,
            token: get(HookEndpoint::ENV_TOKEN)?,
            terminal: get(HookEndpoint::ENV_TERMINAL_ID)?,
        })
    }
}

/// Pedido HTTP ya serializado y su destino.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub addr: SocketAddrV4,
    pub bytes: Vec<u8>,
}

/// Valor seguro para un encabezado: visible, sin saltos de línea ni controles.
fn header_safe(value: &str) -> bool {
    value.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// Separa `http://127.0.0.1:<puerto>/<ruta>`; rechaza todo lo que no sea loopback.
fn parse_loopback_url(url: &str) -> Option<(SocketAddrV4, &str)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = rest.split_once('/')?;
    let addr: SocketAddrV4 = authority.parse().ok()?;
    if *addr.ip() != Ipv4Addr::LOCALHOST || addr.port() == 0 {
        return None;
    }
    let path = path.trim_end_matches('/');
    let valid = path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b));
    valid.then_some((addr, path))
}

/// Arma el pedido (función pura). `None` si el agente es desconocido, la URL
/// no es loopback `http` o algún valor podría inyectar encabezados.
pub fn build_request(agent: &str, env: &HookEnv, body: &[u8]) -> Option<Request> {
    let agent = KnownAgent::from_id(agent)?.id();
    let (addr, path) = parse_loopback_url(&env.url)?;
    if !header_safe(&env.token) || !header_safe(&env.terminal) {
        return None;
    }
    let head = format!(
        concat!(
            "POST /{}/{} HTTP/1.1\r\n",
            "Host: {}\r\n",
            "Authorization: Bearer {}\r\n",
            "X-OpenCollab-Terminal: {}\r\n",
            "Content-Length: {}\r\n",
            "Connection: close\r\n\r\n"
        ),
        path,
        agent,
        addr,
        env.token,
        env.terminal,
        body.len()
    );
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body);
    Some(Request { addr, bytes })
}

/// Envía el pedido con `timeout` por operación y devuelve el código de estado.
pub fn send(request: &Request, timeout: Duration) -> io::Result<u16> {
    let mut stream = TcpStream::connect_timeout(&SocketAddr::V4(request.addr), timeout)?;
    stream.set_write_timeout(Some(timeout))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.write_all(&request.bytes)?;
    let mut response = [0u8; 64];
    let n = stream.read(&mut response)?;
    // "HTTP/1.1 204 ..." -> el código está en la segunda palabra.
    std::str::from_utf8(&response[..n])
        .ok()
        .and_then(|s| s.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "respuesta ilegible"))
}

/// Punto de entrada: ignora todo error (el agente nunca debe enterarse).
pub fn run(agent: Option<String>, lookup: impl Fn(&str) -> Option<String>, stdin: impl Read) {
    let (Some(agent), Some(env)) = (agent, HookEnv::from_lookup(lookup)) else {
        return;
    };
    let mut body = Vec::new();
    // `+ 1` distingue "justo en el tope" de "se pasó".
    if stdin
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .is_err()
        || body.len() > MAX_BODY
    {
        return;
    }
    if let Some(request) = build_request(&agent, &env, &body) {
        let _ = send(&request, IO_TIMEOUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(url: &str) -> HookEnv {
        HookEnv {
            url: url.into(),
            token: "tok".into(),
            terminal: "term-1".into(),
        }
    }

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    const FULL: [(&str, &str); 3] = [
        ("OPENCOLLAB_HOOK_URL", "http://127.0.0.1:1/hook"),
        ("OPENCOLLAB_HOOK_TOKEN", "tok"),
        ("OPENCOLLAB_TERMINAL_ID", "t"),
    ];

    #[test]
    fn env_complete_is_read() {
        let e = HookEnv::from_lookup(lookup(&FULL)).unwrap();
        assert_eq!(e.token, "tok");
        assert_eq!(e.terminal, "t");
    }

    #[test]
    fn env_missing_or_empty_variable_gives_none() {
        for skip in 0..3 {
            let pairs: Vec<_> = FULL
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != skip)
                .map(|(_, p)| *p)
                .collect();
            assert!(HookEnv::from_lookup(lookup(&pairs)).is_none());
            let mut empty = FULL;
            empty[skip].1 = "";
            assert!(HookEnv::from_lookup(lookup(&empty)).is_none());
        }
    }

    #[test]
    fn rejects_non_loopback_https_or_malformed_urls() {
        for url in [
            "https://127.0.0.1:80/hook",
            "http://example.com:80/hook",
            "http://192.168.1.5:80/hook",
            "http://localhost:80/hook",
            "http://127.0.0.1/hook",
            "http://127.0.0.1:abc/hook",
            "http://127.0.0.1:80",
            "http://user@127.0.0.1:80/hook",
            "http://127.0.0.1.evil.com:80/hook",
            "127.0.0.1:80/hook",
            "",
        ] {
            assert!(
                build_request("claude-code", &env(url), b"{}").is_none(),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_unknown_agent() {
        let e = env("http://127.0.0.1:80/hook");
        assert!(build_request("nope", &e, b"{}").is_none());
        assert!(build_request("../x", &e, b"{}").is_none());
        assert!(build_request("", &e, b"{}").is_none());
    }

    #[test]
    fn rejects_header_injection_in_env() {
        let mut e = env("http://127.0.0.1:80/hook");
        e.token = "a\r\nX: y".into();
        assert!(build_request("codex", &e, b"{}").is_none());
        let mut e = env("http://127.0.0.1:80/hook");
        e.terminal = "a\nb".into();
        assert!(build_request("codex", &e, b"{}").is_none());
    }

    #[test]
    fn builds_well_formed_request() {
        let e = env("http://127.0.0.1:4242/hook/");
        let r = build_request("claude-code", &e, b"{\"a\":1}").unwrap();
        assert_eq!(r.addr, "127.0.0.1:4242".parse().unwrap());
        let text = String::from_utf8(r.bytes).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.split("\r\n");
        assert_eq!(lines.next().unwrap(), "POST /hook/claude-code HTTP/1.1");
        let rest: Vec<_> = lines.collect();
        assert!(rest.contains(&"Authorization: Bearer tok"));
        assert!(rest.contains(&"X-OpenCollab-Terminal: term-1"));
        assert!(rest.contains(&"Content-Length: 7"));
        assert!(rest.contains(&"Connection: close"));
        assert!(rest.contains(&"Host: 127.0.0.1:4242"));
        assert_eq!(body, "{\"a\":1}");
    }

    #[test]
    fn run_without_agent_or_env_does_nothing() {
        run(None, |_| None, io::empty());
        run(Some("codex".into()), |_| None, io::empty());
    }
}
