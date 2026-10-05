//! Detección de agentes contra procesos reales: lanza cada CLI instalado dentro
//! de un PTY real y verifica que el detector lo reconozca. Depende de lo que
//! haya instalado en la máquina, por eso está `#[ignore]`:
//!
//!     cargo test -p infrastructure --test agent_detection_e2e -- --ignored --nocapture

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use application::agent_detection::detect_agent;
use application::ports::{ProcessInspector, PtyPort, TerminalOutputSink, TerminalSize};
use application::KnownAgent;
use domain::{AgentProfile, TerminalId};
use infrastructure::{PortablePtyAdapter, SysinfoProcessInspector};

#[derive(Default)]
struct Sink(Mutex<Vec<u8>>);

impl TerminalOutputSink for Sink {
    fn output(&self, _terminal: TerminalId, data: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(data);
    }
    fn exited(&self, _terminal: TerminalId) {}
}

fn installed(command: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(command)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Lanza `command` dentro de una shell en un PTY y espera a que el detector lo vea.
fn detect_running(command: &str) -> Option<KnownAgent> {
    let profile = if cfg!(windows) {
        AgentProfile::new("shell", "powershell.exe")
            .unwrap()
            .with_args(["-NoLogo", "-NoProfile", "-Command", command])
    } else {
        AgentProfile::new("shell", "sh")
            .unwrap()
            .with_args(["-c", command])
    };

    let pty = PortablePtyAdapter::new();
    let inspector = SysinfoProcessInspector::new();
    let terminal = TerminalId::new();
    let sink = Arc::new(Sink::default());
    pty.spawn(
        terminal,
        &profile,
        TerminalSize {
            cols: 120,
            rows: 40,
        },
        sink.clone(),
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut answered = 0;
    let mut detected = None;
    while Instant::now() < deadline {
        // Contestar consultas de posición de cursor (ConPTY y algunas TUIs las hacen).
        let queries = sink
            .0
            .lock()
            .unwrap()
            .windows(4)
            .filter(|w| *w == b"\x1b[6n")
            .count();
        while answered < queries {
            let _ = pty.write(terminal, b"\x1b[1;1R");
            answered += 1;
        }

        let Some(pid) = pty.process_id(terminal) else {
            break; // la shell terminó
        };
        detected = detect_agent(&inspector.snapshot().unwrap(), pid);
        if detected.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
    let _ = pty.kill(terminal);
    detected
}

#[test]
#[ignore = "depende de los CLIs instalados en la máquina"]
fn detects_installed_agents_in_a_real_pty() {
    let cases = [
        ("claude", KnownAgent::ClaudeCode),
        ("opencode", KnownAgent::OpenCode),
        ("codex", KnownAgent::Codex),
        ("agy", KnownAgent::AntigravityCli),
    ];
    let mut checked = 0;
    for (command, expected) in cases {
        if !installed(command) {
            println!("{command}: no instalado, se omite");
            continue;
        }
        let detected = detect_running(command);
        println!("{command}: detectado {detected:?}");
        assert_eq!(detected, Some(expected), "{command}");
        checked += 1;
    }
    assert!(checked > 0, "no hay ningún agente instalado para probar");
}

#[test]
#[ignore = "lanza procesos reales"]
fn a_plain_shell_command_is_not_an_agent() {
    let command = if cfg!(windows) {
        "ping -n 5 127.0.0.1"
    } else {
        "sleep 5"
    };
    assert_eq!(detect_running(command), None);
}
