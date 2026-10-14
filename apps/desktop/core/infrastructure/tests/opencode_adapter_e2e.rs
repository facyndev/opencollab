//! E2E con la TUI real de OpenCode dentro de un PTY real (`#[ignore]`: depende
//! de la máquina, de tener `opencode` instalado y consume un turno mínimo).
//!
//! `cargo test -p infrastructure --test opencode_adapter_e2e -- --ignored --nocapture`
//!
//! Lanza OpenCode como lo hace la app (`agent_shell_profile` + args/env del
//! adaptador, incluida la clave del servidor), envía un prompt y comprueba que
//! los eventos SSE reales llegan traducidos. No toca la configuración del usuario.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use application::ports::{PtyPort, TerminalOutputSink, TerminalSize};
use application::{AgentAdapter, AgentEvent, AgentEventSink, AgentStatus};
use domain::TerminalId;
use infrastructure::{agent_shell_profile, OpenCodeAdapter, PortablePtyAdapter};

#[derive(Default)]
struct Output(Mutex<Vec<u8>>);
impl TerminalOutputSink for Output {
    fn output(&self, _: TerminalId, data: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(data);
    }
    fn exited(&self, _: TerminalId) {}
}

#[derive(Default)]
struct Events(Mutex<Vec<AgentEvent>>);
impl AgentEventSink for Events {
    fn emit(&self, _: TerminalId, event: AgentEvent) {
        self.0.lock().unwrap().push(event);
    }
}

/// Contesta lo que xterm.js contestaría (cursor, atributos y colores del terminal).
fn answer_queries(pty: &PortablePtyAdapter, terminal: TerminalId, out: &Output, seen: &mut usize) {
    let text = String::from_utf8_lossy(&out.0.lock().unwrap()).into_owned();
    let new = &text[(*seen).min(text.len())..];
    for _ in 0..new.matches("\x1b[6n").count() {
        let _ = pty.write(terminal, b"\x1b[1;1R");
    }
    if new.contains("\x1b[c") || new.contains("\x1b[0c") {
        let _ = pty.write(terminal, b"\x1b[?1;2c");
    }
    if new.contains("\x1b]11;?") {
        let _ = pty.write(terminal, b"\x1b]11;rgb:0000/0000/0000\x1b\\");
    }
    if new.contains("\x1b]10;?") {
        let _ = pty.write(terminal, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    }
    *seen = text.len();
}

fn pump(pty: &PortablePtyAdapter, terminal: TerminalId, out: &Output, seen: &mut usize, secs: u64) {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        answer_queries(pty, terminal, out, seen);
        thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "usa la TUI real de OpenCode"]
fn real_opencode_events_arrive_as_agent_events() {
    let work = std::env::temp_dir().join(format!("opencollab-oc-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();

    let adapter = OpenCodeAdapter::new();
    let launch = adapter.prepare().unwrap();
    let profile = agent_shell_profile(Some(&work), "opencode", &launch.args, &launch.env);
    let pty = PortablePtyAdapter::new();
    let terminal = TerminalId::new();
    let out = Arc::new(Output::default());
    pty.spawn(terminal, &profile, TerminalSize::default(), out.clone())
        .unwrap();
    let events = Arc::new(Events::default());
    adapter.bind(&launch.token, terminal, events.clone());

    let mut seen = 0;
    pump(&pty, terminal, &out, &mut seen, 15);
    pty.write(terminal, b"Run the shell command: echo hi")
        .unwrap();
    pump(&pty, terminal, &out, &mut seen, 1);
    pty.write(terminal, b"\r").unwrap();

    // Hasta ver `working` seguido de `idle` (fin del turno) o agotar el plazo.
    let deadline = Instant::now() + Duration::from_secs(120);
    let finished = |events: &[AgentEvent]| {
        let first_working = events.iter().position(|e| {
            matches!(
                e,
                AgentEvent::StatusChanged {
                    status: AgentStatus::Working
                }
            )
        });
        first_working.is_some_and(|i| {
            events[i..].iter().any(|e| {
                matches!(
                    e,
                    AgentEvent::StatusChanged {
                        status: AgentStatus::Idle
                    }
                )
            })
        })
    };
    while Instant::now() < deadline && !finished(&events.0.lock().unwrap()) {
        answer_queries(&pty, terminal, &out, &mut seen);
        thread::sleep(Duration::from_millis(200));
    }
    let collected = events.0.lock().unwrap().clone();
    println!("{collected:#?}");

    adapter.release(terminal);
    let _ = pty.kill(terminal);
    let _ = std::fs::remove_dir_all(&work);

    assert!(finished(&collected), "no se vio working -> idle");
}
