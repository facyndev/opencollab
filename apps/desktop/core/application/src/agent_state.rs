//! Estado de una terminal con agente, reducido a partir de `AgentEvent`s.
//!
//! Reglas del reductor (puro, sin I/O):
//!
//! - `status_changed(working)`: trabajando; limpia aprobación pendiente, error y
//!   "completado" (empieza un turno nuevo).
//! - `status_changed(idle)`: inactivo; limpia la herramienta en curso (no puede
//!   haber una con el agente quieto) pero conserva una aprobación pendiente.
//! - `tool_started`: trabajando con esa herramienta; empieza un turno nuevo.
//! - `tool_finished`: limpia la herramienta si es la actual (por nombre) y la
//!   aprobación pendiente (si la herramienta terminó, ya se resolvió).
//! - `approval_required`: registra la aprobación; no toca estado ni herramienta.
//! - `message`: guarda el último mensaje, truncado.
//! - `completed`: inactivo y completado; limpia herramienta y aprobación.
//! - `error`: inactivo con el error; limpia herramienta y aprobación.

use serde::Serialize;
use serde_json::Value;

use crate::agent_event::{AgentEvent, AgentStatus};

/// Largo máximo (en caracteres) del resumen de la entrada de una herramienta.
pub const INPUT_SUMMARY_MAX: usize = 120;
/// Largo máximo (en caracteres) del último mensaje que se conserva.
pub const MESSAGE_MAX: usize = 280;

/// Claves habituales donde las herramientas de los agentes llevan "lo que van a
/// hacer"; se prueban en orden. Es una heurística de presentación, no lógica de
/// un agente concreto.
const INPUT_KEYS: [&str; 6] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "description",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolActivity {
    pub name: String,
    /// Resumen de una línea de la entrada (p. ej. el comando de `Bash`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub request_id: String,
    pub description: String,
}

/// Estado de una terminal. `status` es `None` hasta que llega el primer evento.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub status: Option<AgentStatus>,
    pub tool: Option<ToolActivity>,
    pub approval: Option<PendingApproval>,
    pub last_message: Option<String>,
    pub completed: bool,
    pub error: Option<String>,
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

fn summarize_input(input: &Value) -> Option<String> {
    let text = match input {
        Value::String(s) => s.as_str(),
        Value::Object(map) => INPUT_KEYS.iter().find_map(|k| map.get(*k)?.as_str())?,
        _ => return None,
    };
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!one_line.is_empty()).then(|| truncate(&one_line, INPUT_SUMMARY_MAX))
}

impl AgentState {
    /// Aplica un evento y devuelve el estado nuevo.
    pub fn reduce(mut self, event: AgentEvent) -> Self {
        match event {
            AgentEvent::StatusChanged { status } => {
                self.status = Some(status);
                match status {
                    AgentStatus::Working => self.start_turn(),
                    AgentStatus::Idle => self.tool = None,
                }
            }
            AgentEvent::ToolStarted { tool, input } => {
                self.status = Some(AgentStatus::Working);
                self.completed = false;
                self.error = None;
                self.tool = Some(ToolActivity {
                    name: tool,
                    input: input.as_ref().and_then(summarize_input),
                });
            }
            AgentEvent::ToolFinished { tool } => {
                if self.tool.as_ref().is_some_and(|t| t.name == tool) {
                    self.tool = None;
                }
                self.approval = None;
            }
            AgentEvent::ApprovalRequired {
                request_id,
                description,
            } => {
                self.approval = Some(PendingApproval {
                    request_id,
                    description,
                });
            }
            AgentEvent::Message { content } => {
                self.last_message = Some(truncate(&content, MESSAGE_MAX));
            }
            AgentEvent::Completed => {
                self.finish();
                self.completed = true;
            }
            AgentEvent::Error { error } => {
                self.finish();
                self.error = Some(error);
            }
        }
        self
    }

    fn start_turn(&mut self) {
        self.approval = None;
        self.completed = false;
        self.error = None;
    }

    fn finish(&mut self) {
        self.status = Some(AgentStatus::Idle);
        self.tool = None;
        self.approval = None;
        self.completed = false;
        self.error = None;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent_event::{AgentEvent, AgentStatus};

    fn apply(events: impl IntoIterator<Item = AgentEvent>) -> AgentState {
        events
            .into_iter()
            .fold(AgentState::default(), AgentState::reduce)
    }

    fn tool_started(tool: &str, input: Option<serde_json::Value>) -> AgentEvent {
        AgentEvent::ToolStarted {
            tool: tool.into(),
            input,
        }
    }

    fn approval(id: &str) -> AgentEvent {
        AgentEvent::ApprovalRequired {
            request_id: id.into(),
            description: "run rm".into(),
        }
    }

    #[test]
    fn starts_unknown() {
        let s = AgentState::default();
        assert_eq!(s.status, None);
        assert!(s.tool.is_none() && s.approval.is_none() && s.last_message.is_none());
        assert!(!s.completed && s.error.is_none());
    }

    #[test]
    fn status_changed_sets_the_status() {
        let s = apply([AgentEvent::StatusChanged {
            status: AgentStatus::Idle,
        }]);
        assert_eq!(s.status, Some(AgentStatus::Idle));
    }

    #[test]
    fn tool_started_makes_it_working_and_summarizes_the_input() {
        let s = apply([tool_started("Bash", Some(json!({ "command": "echo hi" })))]);
        assert_eq!(s.status, Some(AgentStatus::Working));
        let tool = s.tool.unwrap();
        assert_eq!(tool.name, "Bash");
        assert_eq!(tool.input.as_deref(), Some("echo hi"));
    }

    #[test]
    fn input_summary_accepts_plain_strings_and_ignores_unknown_shapes() {
        let s = apply([tool_started("Bash", Some(json!("ls -la")))]);
        assert_eq!(s.tool.unwrap().input.as_deref(), Some("ls -la"));
        let s = apply([tool_started("X", Some(json!({ "weird": 1 })))]);
        assert_eq!(s.tool.unwrap().input, None);
        let s = apply([tool_started("X", None)]);
        assert_eq!(s.tool.unwrap().input, None);
    }

    #[test]
    fn input_summary_is_truncated_to_one_short_line() {
        let long = "x".repeat(500);
        let s = apply([tool_started(
            "Bash",
            Some(json!({ "command": format!("a\n{long}") })),
        )]);
        let input = s.tool.unwrap().input.unwrap();
        assert!(!input.contains('\n'));
        assert_eq!(input.chars().count(), INPUT_SUMMARY_MAX);
        assert!(input.ends_with('…'));
    }

    #[test]
    fn tool_finished_clears_the_matching_tool_and_the_approval() {
        let s = apply([
            tool_started("Bash", None),
            approval("r1"),
            AgentEvent::ToolFinished {
                tool: "Bash".into(),
            },
        ]);
        assert!(s.tool.is_none());
        assert!(s.approval.is_none());
    }

    #[test]
    fn tool_finished_of_another_tool_keeps_the_current_one() {
        let s = apply([
            tool_started("Bash", None),
            AgentEvent::ToolFinished {
                tool: "Read".into(),
            },
        ]);
        assert_eq!(s.tool.unwrap().name, "Bash");
    }

    #[test]
    fn approval_required_records_the_request_without_touching_the_tool() {
        let s = apply([tool_started("Bash", None), approval("r1")]);
        let a = s.approval.unwrap();
        assert_eq!(
            (a.request_id.as_str(), a.description.as_str()),
            ("r1", "run rm")
        );
        assert!(s.tool.is_some());
    }

    #[test]
    fn working_clears_the_approval_and_the_finished_flags() {
        let s = apply([
            approval("r1"),
            AgentEvent::Error {
                error: "boom".into(),
            },
            AgentEvent::StatusChanged {
                status: AgentStatus::Working,
            },
        ]);
        assert!(s.approval.is_none() && s.error.is_none() && !s.completed);
    }

    #[test]
    fn idle_clears_the_tool_but_keeps_a_pending_approval() {
        let s = apply([
            tool_started("Bash", None),
            approval("r1"),
            AgentEvent::StatusChanged {
                status: AgentStatus::Idle,
            },
        ]);
        assert!(s.tool.is_none());
        assert!(s.approval.is_some());
    }

    #[test]
    fn message_keeps_the_last_one_truncated() {
        let s = apply([
            AgentEvent::Message {
                content: "first".into(),
            },
            AgentEvent::Message {
                content: "second".into(),
            },
        ]);
        assert_eq!(s.last_message.as_deref(), Some("second"));
        let s = apply([AgentEvent::Message {
            content: "y".repeat(1000),
        }]);
        let m = s.last_message.unwrap();
        assert_eq!(m.chars().count(), MESSAGE_MAX);
        assert!(m.ends_with('…'));
    }

    #[test]
    fn completed_goes_idle_and_clears_tool_and_approval() {
        let s = apply([
            tool_started("Bash", None),
            approval("r1"),
            AgentEvent::Completed,
        ]);
        assert_eq!(s.status, Some(AgentStatus::Idle));
        assert!(s.completed);
        assert!(s.tool.is_none() && s.approval.is_none());
    }

    #[test]
    fn error_goes_idle_records_the_message_and_is_not_completed() {
        let s = apply([
            tool_started("Bash", None),
            AgentEvent::Completed,
            AgentEvent::Error {
                error: "exit 2".into(),
            },
        ]);
        assert_eq!(s.status, Some(AgentStatus::Idle));
        assert_eq!(s.error.as_deref(), Some("exit 2"));
        assert!(!s.completed && s.tool.is_none());
    }

    #[test]
    fn a_new_tool_starts_a_new_turn() {
        let s = apply([AgentEvent::Completed, tool_started("Bash", None)]);
        assert!(!s.completed);
        assert_eq!(s.status, Some(AgentStatus::Working));
    }
}
