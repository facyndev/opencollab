//! Contrato de eventos de un agente: lo único que un adaptador produce y que el
//! resto de la app consume, sin importar de qué CLI vengan.
//!
//! Espeja el tipo de TypeScript del diseño (`feature agent-adapters`):
//! `status_changed | tool_started | tool_finished | approval_required | message
//! | completed | error`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Qué está haciendo el agente. Mínimo a propósito: "necesita aprobación" no es
/// un estado sino un dato aparte (`AgentState::approval`), porque el agente
/// sigue "trabajando" mientras espera y una aprobación puede convivir con una
/// herramienta en curso.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Working,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    StatusChanged {
        status: AgentStatus,
    },
    ToolStarted {
        tool: String,
        /// Entrada cruda de la herramienta (opaca); el reductor la resume.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<Value>,
    },
    ToolFinished {
        tool: String,
    },
    ApprovalRequired {
        request_id: String,
        description: String,
    },
    Message {
        content: String,
    },
    Completed,
    Error {
        error: String,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_with_a_snake_case_type_tag_and_camel_case_fields() {
        let event = AgentEvent::ApprovalRequired {
            request_id: "r1".into(),
            description: "run rm".into(),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "type": "approval_required", "requestId": "r1", "description": "run rm" })
        );
        assert_eq!(
            serde_json::to_value(AgentEvent::StatusChanged {
                status: AgentStatus::Working
            })
            .unwrap(),
            json!({ "type": "status_changed", "status": "working" })
        );
        assert_eq!(
            serde_json::to_value(AgentEvent::Completed).unwrap(),
            json!({ "type": "completed" })
        );
    }

    #[test]
    fn deserializes_a_tool_started_with_and_without_input() {
        let with: AgentEvent = serde_json::from_value(
            json!({ "type": "tool_started", "tool": "Bash", "input": { "command": "ls" } }),
        )
        .unwrap();
        assert_eq!(
            with,
            AgentEvent::ToolStarted {
                tool: "Bash".into(),
                input: Some(json!({ "command": "ls" }))
            }
        );
        let without: AgentEvent =
            serde_json::from_value(json!({ "type": "tool_started", "tool": "Bash" })).unwrap();
        assert_eq!(
            without,
            AgentEvent::ToolStarted {
                tool: "Bash".into(),
                input: None
            }
        );
    }
}
