//! Traducción pura de los payloads de los hooks de Claude Code a `AgentEvent`s.
//!
//! Claude Code manda cada hook como un POST con el JSON del evento
//! (`hook_event_name`, `tool_name`, `tool_input`, ...). Acá no hay I/O: la
//! función recibe el JSON ya parseado y es tolerante a campos que falten.
//! Referencia: https://code.claude.com/docs/en/hooks

use application::{AgentEvent, AgentStatus};
use serde_json::Value;

/// Eventos de Claude Code a los que se engancha el adaptador.
pub const HOOK_EVENTS: [&str; 7] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "Stop",
    "StopFailure",
];

/// Tope de caracteres del último mensaje que se reenvía (el reductor lo acorta más).
const MESSAGE_CAP: usize = 2000;

/// Traductor por lanzamiento. Guarda lo mínimo para no duplicar la aprobación:
/// `PermissionRequest` trae la herramienta y `Notification(permission_prompt)`
/// solo un texto genérico, y llegan los dos para la misma aprobación.
#[derive(Debug, Default)]
pub struct ClaudeHookTranslator {
    approval_pending: bool,
}

fn str_field<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key)?.as_str().filter(|s| !s.is_empty())
}

/// Resumen de una línea de lo que va a hacer la herramienta (comando, archivo...).
fn tool_summary(input: Option<&Value>) -> Option<String> {
    let text = match input? {
        Value::String(s) => s.as_str(),
        Value::Object(map) => [
            "command",
            "file_path",
            "path",
            "pattern",
            "url",
            "description",
        ]
        .iter()
        .find_map(|k| map.get(*k)?.as_str())?,
        _ => return None,
    };
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!one_line.is_empty()).then_some(one_line)
}

impl ClaudeHookTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn translate(&mut self, payload: &Value) -> Vec<AgentEvent> {
        let Some(name) = str_field(payload, "hook_event_name") else {
            return Vec::new();
        };
        let tool = str_field(payload, "tool_name");
        match name {
            "UserPromptSubmit" => {
                self.approval_pending = false;
                vec![AgentEvent::StatusChanged {
                    status: AgentStatus::Working,
                }]
            }
            "PreToolUse" => match tool {
                Some(tool) => vec![AgentEvent::ToolStarted {
                    tool: tool.to_string(),
                    input: payload.get("tool_input").cloned(),
                }],
                None => Vec::new(),
            },
            "PermissionRequest" => {
                let Some(tool) = tool else {
                    return Vec::new();
                };
                self.approval_pending = true;
                let summary = tool_summary(payload.get("tool_input"));
                let description = match &summary {
                    Some(s) => format!("{tool}: {s}"),
                    None => tool.to_string(),
                };
                // Este hook no trae `tool_use_id`: el id sale de lo que se pide aprobar.
                let request_id = str_field(payload, "tool_use_id")
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{tool}:{}", summary.unwrap_or_default()));
                vec![AgentEvent::ApprovalRequired {
                    request_id,
                    description,
                }]
            }
            "Notification" => {
                if str_field(payload, "notification_type") != Some("permission_prompt")
                    || self.approval_pending
                {
                    return Vec::new();
                }
                self.approval_pending = true;
                vec![AgentEvent::ApprovalRequired {
                    request_id: "notification".into(),
                    description: str_field(payload, "message")
                        .unwrap_or("Needs your permission")
                        .to_string(),
                }]
            }
            "PostToolUse" => {
                self.approval_pending = false;
                match tool {
                    Some(tool) => vec![AgentEvent::ToolFinished {
                        tool: tool.to_string(),
                    }],
                    None => Vec::new(),
                }
            }
            // Fin de turno (no del proceso): mensaje final y vuelta a inactivo.
            "Stop" => {
                self.approval_pending = false;
                let mut events = Vec::new();
                if let Some(message) = str_field(payload, "last_assistant_message") {
                    events.push(AgentEvent::Message {
                        content: message.chars().take(MESSAGE_CAP).collect(),
                    });
                }
                events.push(AgentEvent::StatusChanged {
                    status: AgentStatus::Idle,
                });
                events
            }
            "StopFailure" => {
                self.approval_pending = false;
                let kind = str_field(payload, "error_type").unwrap_or("unknown");
                let error = match str_field(payload, "error_message") {
                    Some(m) => format!("{kind}: {m}"),
                    None => kind.to_string(),
                };
                vec![AgentEvent::Error { error }]
            }
            _ => Vec::new(),
        }
    }
}

/// JSON de `--settings` con un hook HTTP por evento hacia `url`. El `timeout`
/// (segundos) es corto a propósito: el agente nunca debe esperar a la app.
pub fn settings_json(url: &str, timeout_secs: u32) -> String {
    let hooks: serde_json::Map<String, Value> = HOOK_EVENTS
        .iter()
        .map(|event| {
            (
                (*event).to_string(),
                serde_json::json!([{
                    "hooks": [{ "type": "http", "url": url, "timeout": timeout_secs }]
                }]),
            )
        })
        .collect();
    serde_json::json!({ "hooks": hooks }).to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn translate(payload: Value) -> Vec<AgentEvent> {
        ClaudeHookTranslator::new().translate(&payload)
    }

    #[test]
    fn user_prompt_starts_working() {
        assert_eq!(
            translate(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "hi" })),
            vec![AgentEvent::StatusChanged {
                status: AgentStatus::Working
            }]
        );
    }

    #[test]
    fn pre_tool_use_starts_a_tool_with_its_input() {
        let input = json!({ "command": "echo hi", "description": "Print hi" });
        assert_eq!(
            translate(json!({
                "hook_event_name": "PreToolUse", "tool_name": "Bash",
                "tool_input": input, "tool_use_id": "toolu_1"
            })),
            vec![AgentEvent::ToolStarted {
                tool: "Bash".into(),
                input: Some(input)
            }]
        );
    }

    #[test]
    fn permission_request_asks_for_approval_with_the_command() {
        assert_eq!(
            translate(json!({
                "hook_event_name": "PermissionRequest", "tool_name": "Bash",
                "tool_input": { "command": "touch  probe.txt" },
                "permission_suggestions": []
            })),
            vec![AgentEvent::ApprovalRequired {
                request_id: "Bash:touch probe.txt".into(),
                description: "Bash: touch probe.txt".into()
            }]
        );
    }

    #[test]
    fn permission_request_prefers_the_tool_use_id() {
        let events = translate(json!({
            "hook_event_name": "PermissionRequest", "tool_name": "Edit",
            "tool_input": { "file_path": "a.rs" }, "tool_use_id": "toolu_9"
        }));
        assert_eq!(
            events,
            vec![AgentEvent::ApprovalRequired {
                request_id: "toolu_9".into(),
                description: "Edit: a.rs".into()
            }]
        );
    }

    #[test]
    fn permission_notification_after_a_request_is_not_duplicated() {
        let mut t = ClaudeHookTranslator::new();
        t.translate(&json!({
            "hook_event_name": "PermissionRequest", "tool_name": "Bash",
            "tool_input": { "command": "ls" }
        }));
        let notification = json!({
            "hook_event_name": "Notification", "notification_type": "permission_prompt",
            "message": "Claude needs your permission"
        });
        assert_eq!(t.translate(&notification), vec![]);
        // Resuelta la aprobación, una notificación nueva vuelve a contar.
        t.translate(&json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash" }));
        assert_eq!(t.translate(&notification).len(), 1);
    }

    #[test]
    fn permission_notification_alone_asks_for_approval() {
        assert_eq!(
            translate(json!({
                "hook_event_name": "Notification", "notification_type": "permission_prompt",
                "message": "Claude needs your permission"
            })),
            vec![AgentEvent::ApprovalRequired {
                request_id: "notification".into(),
                description: "Claude needs your permission".into()
            }]
        );
    }

    #[test]
    fn other_notifications_are_ignored() {
        assert_eq!(
            translate(json!({
                "hook_event_name": "Notification", "notification_type": "idle_prompt",
                "message": "waiting"
            })),
            vec![]
        );
    }

    #[test]
    fn post_tool_use_finishes_the_tool() {
        assert_eq!(
            translate(
                json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash",
                "tool_response": {}, "duration_ms": 12 })
            ),
            vec![AgentEvent::ToolFinished {
                tool: "Bash".into()
            }]
        );
    }

    #[test]
    fn stop_reports_the_message_and_goes_idle_without_completing() {
        assert_eq!(
            translate(json!({ "hook_event_name": "Stop", "last_assistant_message": "done" })),
            vec![
                AgentEvent::Message {
                    content: "done".into()
                },
                AgentEvent::StatusChanged {
                    status: AgentStatus::Idle
                }
            ]
        );
        // Sin mensaje: solo inactivo.
        assert_eq!(
            translate(json!({ "hook_event_name": "Stop" })),
            vec![AgentEvent::StatusChanged {
                status: AgentStatus::Idle
            }]
        );
    }

    #[test]
    fn stop_truncates_a_huge_message() {
        let huge = "x".repeat(10_000);
        let events =
            translate(json!({ "hook_event_name": "Stop", "last_assistant_message": huge }));
        match &events[0] {
            AgentEvent::Message { content } => assert_eq!(content.chars().count(), 2000),
            other => panic!("se esperaba un mensaje, vino {other:?}"),
        }
    }

    #[test]
    fn stop_failure_becomes_an_error() {
        assert_eq!(
            translate(json!({ "hook_event_name": "StopFailure",
                "error_type": "rate_limit", "error_message": "Slow down" })),
            vec![AgentEvent::Error {
                error: "rate_limit: Slow down".into()
            }]
        );
        assert_eq!(
            translate(json!({ "hook_event_name": "StopFailure" })),
            vec![AgentEvent::Error {
                error: "unknown".into()
            }]
        );
    }

    #[test]
    fn malformed_or_unknown_payloads_produce_nothing() {
        assert_eq!(translate(json!({})), vec![]);
        assert_eq!(translate(json!("text")), vec![]);
        assert_eq!(
            translate(json!({ "hook_event_name": "PreToolUse" })),
            vec![]
        );
        assert_eq!(
            translate(json!({ "hook_event_name": "SessionStart" })),
            vec![]
        );
    }

    #[test]
    fn settings_hook_every_event_over_http_with_a_short_timeout() {
        let settings: Value =
            serde_json::from_str(&settings_json("http://127.0.0.1:1234/hook/tok", 2)).unwrap();
        let hooks = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for event in HOOK_EVENTS {
            let hook = &hooks[event][0]["hooks"][0];
            assert_eq!(hook["type"], "http");
            assert_eq!(hook["url"], "http://127.0.0.1:1234/hook/tok");
            assert_eq!(hook["timeout"], 2);
        }
    }
}
