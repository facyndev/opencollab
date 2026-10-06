//! E2E con el CLI real de Claude Code (`#[ignore]`: depende de la máquina, de
//! tener `claude` instalado con sesión iniciada y consume un turno mínimo).
//!
//! `cargo test -p infrastructure --test claude_adapter_e2e -- --ignored --nocapture`
//!
//! Lanza `claude -p` con el `--settings` que arma el adaptador y comprueba que
//! los hooks reales llegan traducidos. No toca la configuración del usuario.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use application::{AgentAdapter, AgentEvent, AgentEventSink, AgentStatus};
use domain::TerminalId;
use infrastructure::{ClaudeCodeAdapter, HookReceiver};

#[derive(Default)]
struct Recorder(Mutex<Vec<AgentEvent>>);
impl AgentEventSink for Recorder {
    fn emit(&self, _: TerminalId, event: AgentEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[test]
#[ignore = "usa el CLI real de Claude Code"]
fn real_claude_hooks_arrive_as_agent_events() {
    let dir = std::env::temp_dir().join(format!("opencollab-e2e-{}", std::process::id()));
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let adapter = ClaudeCodeAdapter::in_dir(HookReceiver::start().unwrap(), dir.join("settings"));
    let launch = adapter.prepare().unwrap();
    let sink = Arc::new(Recorder::default());
    let terminal = TerminalId::new();
    adapter.bind(&launch.token, terminal, sink.clone());

    let status = Command::new("cmd")
        .args(["/c", "claude", "-p", "Run the shell command: echo hi"])
        .args(["--allowedTools", "Bash"])
        .args(&launch.args)
        .current_dir(&work)
        .stdin(Stdio::null())
        .status()
        .expect("no se pudo lanzar claude");
    assert!(status.success());

    let events = sink.0.lock().unwrap().clone();
    println!("{events:#?}");
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::StatusChanged {
            status: AgentStatus::Working
        }
    )));
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ToolStarted { tool, .. } if tool == "Bash")));
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ToolFinished { tool } if tool == "Bash")));
    assert!(matches!(
        events.last(),
        Some(AgentEvent::StatusChanged {
            status: AgentStatus::Idle
        })
    ));

    adapter.release(terminal);
    let _ = std::fs::remove_dir_all(dir);
}
