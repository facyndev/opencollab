//! Piezas puras del wiring de subagentes: DTOs del wire hacia el frontend,
//! mapeos de estado y el decorador que exige el binario `opencollab-hook`.
//! Los DTOs viven acá (no en `application`/`domain`, que no conocen serde).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use application::ports::{HookInstaller, PortError};
use application::{
    HookStatus, KnownAgent, RawSubagentEvent, Subagent, SubagentStatus, TrackSubagents,
};
use domain::TerminalId;
use serde::Serialize;

pub const TERMINAL_SUBAGENTS_EVENT: &str = "terminal-subagents";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub agent: &'static str,
    pub kind: Option<String>,
    pub label: Option<String>,
    /// `running` | `completed` | `failed`.
    pub status: &'static str,
}

fn subagent_dto(s: &Subagent) -> SubagentDto {
    SubagentDto {
        id: s.id.clone(),
        parent_id: s.parent_id.clone(),
        agent: s.agent.id(),
        kind: s.kind.clone(),
        label: s.label.clone(),
        status: match s.status {
            SubagentStatus::Running => "running",
            SubagentStatus::Completed => "completed",
            SubagentStatus::Failed => "failed",
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSubagentsPayload {
    pub terminal_id: String,
    pub subagents: Vec<SubagentDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatusDto {
    pub agent: &'static str,
    /// `unsupported` | `notInstalled` | `installed` | `error`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn subagents_payload(terminal: TerminalId, subagents: &[Subagent]) -> TerminalSubagentsPayload {
    TerminalSubagentsPayload {
        terminal_id: terminal.to_string(),
        subagents: subagents.iter().map(subagent_dto).collect(),
    }
}

pub fn hook_status_dto(agent: KnownAgent, status: Result<HookStatus, PortError>) -> HookStatusDto {
    match status {
        Ok(status) => HookStatusDto {
            agent: agent.id(),
            status: match status {
                HookStatus::Unsupported => "unsupported",
                HookStatus::NotInstalled => "notInstalled",
                HookStatus::Installed => "installed",
            },
            error: None,
        },
        Err(e) => HookStatusDto {
            agent: agent.id(),
            status: "error",
            error: Some(e.0),
        },
    }
}

/// Id de agente recibido del frontend (`KnownAgent::id`).
pub fn parse_agent(id: &str) -> Result<KnownAgent, String> {
    KnownAgent::from_id(id).ok_or_else(|| format!("agente desconocido: {id}"))
}

/// `opencollab-hook` (con `.exe` en Windows) dentro de `dir`.
pub fn hook_binary_path(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "opencollab-hook.exe"
    } else {
        "opencollab-hook"
    })
}

/// Lo que hace el sink del receptor: aplica el evento en el hub y devuelve el
/// payload a emitir si el árbol cambió. Los errores se loguean y se ignoran.
pub fn apply_hook_event(
    hub: &TrackSubagents,
    event: RawSubagentEvent,
) -> Option<TerminalSubagentsPayload> {
    let terminal = event.terminal;
    match hub.handle(event) {
        Ok(Some(snapshot)) => Some(subagents_payload(terminal, &snapshot)),
        Ok(None) => None,
        Err(e) => {
            eprintln!("evento de hook ignorado: {e}");
            None
        }
    }
}

/// La terminal se cerró: descarta su árbol. Devuelve un payload vacío solo si
/// tenía subagentes (para que la UI los limpie).
pub fn forget_terminal(
    hub: &TrackSubagents,
    terminal: TerminalId,
) -> Option<TerminalSubagentsPayload> {
    let had_subagents = !hub.snapshot(terminal).is_empty();
    hub.forget(terminal);
    had_subagents.then(|| subagents_payload(terminal, &[]))
}

/// Decorador: `install` falla con un mensaje claro si falta el binario del
/// hook; `status` y `uninstall` siempre funcionan.
pub struct RequireHookBinary {
    inner: Arc<dyn HookInstaller>,
    binary: PathBuf,
}

impl RequireHookBinary {
    pub fn new(inner: Arc<dyn HookInstaller>, binary: PathBuf) -> Self {
        Self { inner, binary }
    }
}

impl HookInstaller for RequireHookBinary {
    fn agent(&self) -> KnownAgent {
        self.inner.agent()
    }
    fn status(&self) -> Result<HookStatus, PortError> {
        self.inner.status()
    }
    fn install(&self) -> Result<(), PortError> {
        if !self.binary.is_file() {
            return Err(PortError::new(format!(
                "no se encontró opencollab-hook junto a la app ({})",
                self.binary.display()
            )));
        }
        self.inner.install()
    }
    fn uninstall(&self) -> Result<(), PortError> {
        self.inner.uninstall()
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::mpsc;
    use std::time::Duration;

    use application::ports::SubagentEventTranslator;
    use infrastructure::{ClaudeCodeTranslator, CodexTranslator, HookReceiver, OpenCodeTranslator};
    use serde_json::json;

    use super::*;

    fn hub() -> TrackSubagents {
        let translators: Vec<Arc<dyn SubagentEventTranslator>> = vec![
            Arc::new(ClaudeCodeTranslator),
            Arc::new(OpenCodeTranslator),
            Arc::new(CodexTranslator),
        ];
        TrackSubagents::new(translators)
    }

    fn sub(id: &str, status: SubagentStatus) -> Subagent {
        Subagent {
            id: id.into(),
            parent_id: Some("p".into()),
            agent: KnownAgent::ClaudeCode,
            kind: Some("Explore".into()),
            label: None,
            status,
        }
    }

    const CLAUDE_START: &str = r#"{"session_id":"s","hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"Explore","description":"buscar foo"}"#;

    fn raw(terminal: TerminalId, payload: &str) -> RawSubagentEvent {
        RawSubagentEvent {
            terminal,
            agent: KnownAgent::ClaudeCode,
            payload: payload.into(),
        }
    }

    #[test]
    fn payload_serializes_camel_case_with_string_ids_and_status() {
        let terminal = TerminalId::new();
        let value = serde_json::to_value(subagents_payload(
            terminal,
            &[
                sub("a", SubagentStatus::Running),
                sub("b", SubagentStatus::Completed),
                sub("c", SubagentStatus::Failed),
            ],
        ))
        .unwrap();
        assert_eq!(value["terminalId"], json!(terminal.to_string()));
        assert_eq!(
            value["subagents"][0],
            json!({"id":"a","parentId":"p","agent":"claude-code","kind":"Explore","label":null,"status":"running"})
        );
        assert_eq!(value["subagents"][1]["status"], "completed");
        assert_eq!(value["subagents"][2]["status"], "failed");
    }

    #[test]
    fn hook_status_maps_every_variant_and_error() {
        let ok = |s| hook_status_dto(KnownAgent::Codex, Ok(s));
        assert_eq!(ok(HookStatus::Unsupported).status, "unsupported");
        assert_eq!(ok(HookStatus::NotInstalled).status, "notInstalled");
        assert_eq!(ok(HookStatus::Installed).status, "installed");
        let err = hook_status_dto(KnownAgent::OpenCode, Err(PortError::new("roto")));
        assert_eq!((err.agent, err.status), ("opencode", "error"));
        assert_eq!(err.error.as_deref(), Some("roto"));
    }

    #[test]
    fn hook_status_json_omits_error_when_absent() {
        let value = serde_json::to_value(hook_status_dto(
            KnownAgent::Codex,
            Ok(HookStatus::Installed),
        ))
        .unwrap();
        assert_eq!(value, json!({"agent":"codex","status":"installed"}));
    }

    #[test]
    fn parse_agent_accepts_known_ids_and_rejects_others() {
        for agent in KnownAgent::ALL {
            assert_eq!(parse_agent(agent.id()), Ok(agent));
        }
        assert!(parse_agent("nope").is_err());
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("opencollab-desktop-{}", TerminalId::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hook_binary_path_is_inside_the_given_dir() {
        let dir = temp_dir();
        let path = hook_binary_path(&dir);
        assert_eq!(path.parent(), Some(dir.as_path()));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let expected = if cfg!(windows) {
            "opencollab-hook.exe"
        } else {
            "opencollab-hook"
        };
        assert_eq!(name, expected);
    }

    struct Fake {
        installs: std::sync::Mutex<u32>,
    }
    impl HookInstaller for Fake {
        fn agent(&self) -> KnownAgent {
            KnownAgent::ClaudeCode
        }
        fn status(&self) -> Result<HookStatus, PortError> {
            Ok(HookStatus::NotInstalled)
        }
        fn install(&self) -> Result<(), PortError> {
            *self.installs.lock().unwrap() += 1;
            Ok(())
        }
        fn uninstall(&self) -> Result<(), PortError> {
            Ok(())
        }
    }

    fn fake() -> Arc<Fake> {
        Arc::new(Fake {
            installs: Default::default(),
        })
    }

    #[test]
    fn install_without_binary_fails_clearly_but_status_and_uninstall_work() {
        let dir = temp_dir();
        let fake = fake();
        let wrapped = RequireHookBinary::new(fake.clone(), hook_binary_path(&dir));
        let err = wrapped.install().unwrap_err();
        assert!(err
            .0
            .contains("no se encontró opencollab-hook junto a la app"));
        assert_eq!(*fake.installs.lock().unwrap(), 0);
        assert_eq!(wrapped.status(), Ok(HookStatus::NotInstalled));
        assert_eq!(wrapped.uninstall(), Ok(()));
        assert_eq!(wrapped.agent(), KnownAgent::ClaudeCode);
    }

    #[test]
    fn install_with_binary_delegates() {
        let dir = temp_dir();
        let bin = hook_binary_path(&dir);
        std::fs::write(&bin, b"").unwrap();
        let fake = fake();
        RequireHookBinary::new(fake.clone(), bin).install().unwrap();
        assert_eq!(*fake.installs.lock().unwrap(), 1);
    }

    #[test]
    fn apply_hook_event_returns_payload_only_when_tree_changes() {
        let hub = hub();
        let terminal = TerminalId::new();
        let first = apply_hook_event(&hub, raw(terminal, CLAUDE_START)).unwrap();
        assert_eq!(first.terminal_id, terminal.to_string());
        assert_eq!(first.subagents.len(), 1);
        assert_eq!(first.subagents[0].status, "running");
        assert_eq!(first.subagents[0].label.as_deref(), Some("buscar foo"));
        assert_eq!(apply_hook_event(&hub, raw(terminal, CLAUDE_START)), None);
    }

    #[test]
    fn apply_hook_event_swallows_hub_errors() {
        let hub = hub();
        assert_eq!(
            apply_hook_event(&hub, raw(TerminalId::new(), "no es json")),
            None
        );
        let no_translator = TrackSubagents::new(vec![]);
        assert_eq!(
            apply_hook_event(&no_translator, raw(TerminalId::new(), CLAUDE_START)),
            None
        );
    }

    #[test]
    fn forget_terminal_emits_empty_only_if_it_had_subagents() {
        let hub = hub();
        let terminal = TerminalId::new();
        assert_eq!(forget_terminal(&hub, terminal), None);
        apply_hook_event(&hub, raw(terminal, CLAUDE_START)).unwrap();
        let cleared = forget_terminal(&hub, terminal).unwrap();
        assert_eq!(cleared.terminal_id, terminal.to_string());
        assert!(cleared.subagents.is_empty());
        assert!(hub.snapshot(terminal).is_empty());
    }

    #[test]
    fn real_receiver_feeds_hub_and_produces_payload_for_the_right_terminal() {
        let hub = Arc::new(hub());
        let (tx, rx) = mpsc::channel();
        let receiver = {
            let hub = hub.clone();
            HookReceiver::start(move |event| {
                if let Some(p) = apply_hook_event(&hub, event) {
                    let _ = tx.send(p);
                }
            })
            .unwrap()
        };
        let terminal = TerminalId::new();
        let addr = receiver
            .url()
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap()
            .to_owned();
        let request = format!(
            "POST /hook/claude-code HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {}\r\nX-OpenCollab-Terminal: {terminal}\r\nContent-Length: {}\r\n\r\n{CLAUDE_START}",
            receiver.token(),
            CLAUDE_START.len()
        );
        let mut stream = TcpStream::connect(&addr).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        assert!(response.starts_with("HTTP/1.1 204"), "{response}");
        let payload = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(payload.terminal_id, terminal.to_string());
        assert_eq!(payload.subagents[0].id, "a1");
    }
}
