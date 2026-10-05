//! Pruebas de integración: el sidecar contra un `HookReceiver` real.

use std::io::Write;
use std::net::TcpListener;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use application::{HookEndpoint, KnownAgent, RawSessionEvent};
use domain::TerminalId;
use infrastructure::HookReceiver;

fn start() -> (HookReceiver, Receiver<RawSessionEvent>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let receiver = HookReceiver::start(move |event| {
        let _ = tx.lock().unwrap().send(event);
    })
    .unwrap();
    (receiver, rx)
}

/// Entorno mínimo para que el binario arranque en Windows sin heredar nada más.
fn base_command(args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_opencollab-hook"));
    cmd.args(args).env_clear();
    for key in ["SystemRoot", "PATH"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd
}

fn run_bin(mut cmd: Command, stdin: &[u8]) -> Output {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Sin entorno o sin argumentos el binario sale sin leer stdin: si ya cerró
    // la tubería, la escritura falla (broken pipe) y eso no es un error del test.
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

fn with_endpoint(cmd: &mut Command, url: &str, token: &str, terminal: TerminalId) {
    cmd.env(HookEndpoint::ENV_URL, url)
        .env(HookEndpoint::ENV_TOKEN, token)
        .env(HookEndpoint::ENV_TERMINAL_ID, terminal.to_string());
}

fn assert_silent_success(out: &Output) {
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
}

#[test]
fn lib_delivers_event_to_receiver() {
    let (receiver, rx) = start();
    let terminal = TerminalId::new();
    let vars = [
        (HookEndpoint::ENV_URL, receiver.url().to_string()),
        (HookEndpoint::ENV_TOKEN, receiver.token().to_string()),
        (HookEndpoint::ENV_TERMINAL_ID, terminal.to_string()),
    ];
    let lookup = |name: &str| {
        vars.iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
    };
    hook_relay::run(Some("claude-code".into()), lookup, &b"{\"x\":1}"[..]);
    let event = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(event.terminal_id, terminal);
    assert_eq!(event.agent, KnownAgent::ClaudeCode);
    assert_eq!(event.payload, "{\"x\":1}");
}

#[test]
fn binary_delivers_event_and_exits_zero() {
    let (receiver, rx) = start();
    let terminal = TerminalId::new();
    let mut cmd = base_command(&["codex"]);
    with_endpoint(&mut cmd, receiver.url(), receiver.token(), terminal);
    let out = run_bin(cmd, b"{\"hook\":\"SubagentStart\"}");
    assert_silent_success(&out);
    let event = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(event.terminal_id, terminal);
    assert_eq!(event.agent, KnownAgent::Codex);
    assert_eq!(event.payload, "{\"hook\":\"SubagentStart\"}");
}

#[test]
fn binary_with_wrong_token_delivers_nothing_and_exits_zero() {
    let (receiver, rx) = start();
    let mut cmd = base_command(&["codex"]);
    with_endpoint(&mut cmd, receiver.url(), "incorrecto", TerminalId::new());
    assert_silent_success(&run_bin(cmd, b"{}"));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn binary_over_size_limit_delivers_nothing() {
    let (receiver, rx) = start();
    let mut cmd = base_command(&["claude-code"]);
    with_endpoint(
        &mut cmd,
        receiver.url(),
        receiver.token(),
        TerminalId::new(),
    );
    let out = run_bin(cmd, &vec![b'a'; 1024 * 1024 + 1]);
    assert_silent_success(&out);
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn binary_without_env_is_silent_noop() {
    assert_silent_success(&run_bin(base_command(&["claude-code"]), b"{}"));
}

#[test]
fn binary_without_args_exits_zero() {
    let (receiver, rx) = start();
    let mut cmd = base_command(&[]);
    with_endpoint(
        &mut cmd,
        receiver.url(),
        receiver.token(),
        TerminalId::new(),
    );
    assert_silent_success(&run_bin(cmd, b"{}"));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn binary_with_unknown_agent_exits_zero() {
    let (receiver, rx) = start();
    let mut cmd = base_command(&["no-such-agent"]);
    with_endpoint(
        &mut cmd,
        receiver.url(),
        receiver.token(),
        TerminalId::new(),
    );
    assert_silent_success(&run_bin(cmd, b"{}"));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn binary_against_closed_port_exits_zero_quickly() {
    // Reserva un puerto libre y lo suelta: nadie escucha ahí.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut cmd = base_command(&["claude-code"]);
    with_endpoint(
        &mut cmd,
        &format!("http://127.0.0.1:{port}/hook"),
        "tok",
        TerminalId::new(),
    );
    let started = Instant::now();
    let out = run_bin(cmd, b"{}");
    assert_silent_success(&out);
    assert!(started.elapsed() < Duration::from_secs(2));
}
