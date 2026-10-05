//! Traductores de eventos crudos de hooks de agentes a [`SubagentChange`].
//!
//! Cada agente expone los subagentes con un formato distinto (ver
//! `odd/tasks/subagent-adapters.md` §Por qué así); estos traductores
//! interpretan el JSON crudo que el receptor HTTP local entrega al hub
//! [`TrackSubagents`]. Reglas comunes:
//!
//! - El JSON se parsea defensivamente con `serde_json`: campos opcionales con
//!   `Option` y `#[serde(default)]`, nunca `unwrap` ni `panic`.
//! - Un payload que no es JSON o al que le faltan los ids obligatorios es un
//!   error de parseo → `Err(PortError)`. El receptor lo descarta en silencio
//!   (los hooks nunca bloquean al agente).
//! - Un JSON válido pero irrelevante (p. ej. `tool.execute.after` de una
//!   herramienta que no es `task`) devuelve `Ok(vec![])`: no pasó nada malo,
//!   simplemente no hay cambios.
//!
//! [`SubagentChange`]: application::SubagentChange
//! [`TrackSubagents`]: application::TrackSubagents

use application::agent_detection::KnownAgent;
use application::ports::{PortError, SubagentEventTranslator};
use application::{SubagentChange, SubagentStatus};

/// Fixtures de payloads documentados (solo tests): ejemplos del JSON crudo
/// que cada hook/plugin va a entregar al receptor. Cada constante lleva su
/// suposición documentada porque los formatos reales pueden diferir (ver
/// `odd/tasks/subagent-adapters.md` §Por qué así); si difieren, se mapea acá
/// sin tocar `application`.
#[cfg(test)]
mod fixtures {
    /// Hook `SubagentStart` de Claude Code 2.1.x.
    ///
    /// Suposición documentada: el hook `command` recibe por stdin el JSON del
    /// evento con `hook_event_name`, `session_id` (la sesión principal, que se
    /// usa como padre), `agent_id`, y opcionales `agent_type` (kind) y
    /// `description` (label).
    pub const CLAUDE_START: &str = r#"{
  "session_id": "sess-principal-1",
  "hook_event_name": "SubagentStart",
  "agent_id": "a6f3c9",
  "agent_type": "Explore",
  "description": "buscar usos de foo en el repo"
}"#;

    /// Hook `SubagentStop` de Claude Code 2.1.x, caso de éxito.
    ///
    /// Suposición documentada: el Stop trae los mismos ids que el Start (para
    /// que el hub haga merge last-write-wins) y nada más; la ausencia de
    /// `success: false` / `error` significa éxito.
    pub const CLAUDE_STOP: &str = r#"{
  "session_id": "sess-principal-1",
  "hook_event_name": "SubagentStop",
  "agent_id": "a6f3c9"
}"#;

    /// Hook `SubagentStop` de Claude Code 2.1.x, caso de error.
    ///
    /// Suposición documentada: el fallo se señala con `success: false` o con un
    /// campo `error` no nulo; se aceptan ambas formas por robustez.
    pub const CLAUDE_STOP_ERROR: &str = r#"{
  "session_id": "sess-principal-1",
  "hook_event_name": "SubagentStop",
  "agent_id": "a6f3c9",
  "success": false,
  "error": "el subagente fue cancelado por el usuario"
}"#;

    /// Evento `session.created` con `parentID` del plugin `opencollab.ts` de
    /// OpenCode 1.18 (inicio / anidamiento).
    ///
    /// Suposición documentada: el plugin emite este JSON propio (no es un formato
    /// de OpenCode, es el contrato que el instalador de T5 va a desplegar) con
    /// `sessionID` del subagente y `parentID` de la sesión padre. Sin `parentID`
    /// el subagente queda como raíz de la terminal.
    pub const OPENCODE_SESSION_CREATED: &str = r#"{
  "event": "session.created",
  "sessionID": "ses-hija-7",
  "parentID": "ses-padre-2"
}"#;

    /// `tool.execute.after` de `task` del plugin `opencollab.ts` (fin con éxito).
    ///
    /// Suposición documentada: el plugin emite este JSON propio; `tool`
    /// distingue la herramienta que terminó y `error` nulo significa éxito.
    /// Eventos de otras herramientas se ignoran (`Ok(vec![])`).
    pub const OPENCODE_TASK_AFTER: &str = r#"{
  "event": "tool.execute.after",
  "tool": "task",
  "sessionID": "ses-hija-7"
}"#;

    /// `tool.execute.after` de `task` con error (fin fallido).
    pub const OPENCODE_TASK_AFTER_ERROR: &str = r#"{
  "event": "tool.execute.after",
  "tool": "task",
  "sessionID": "ses-hija-7",
  "error": "task failed: timeout after 120s"
}"#;

    /// Hook `SubagentStart` de Codex 0.160 (`async: true` en `~/.codex/hooks.json`).
    ///
    /// Suposición documentada: análogo al de Claude Code; el hook recibe por
    /// stdin un JSON con `event`, `agent_id`, `session_id` (padre) y opcionales
    /// `agent_type` / `description`.
    pub const CODEX_START: &str = r#"{
  "event": "SubagentStart",
  "agent_id": "cx-42",
  "session_id": "codex-main",
  "agent_type": "build",
  "description": "compilar el workspace"
}"#;

    /// Hook `SubagentStop` de Codex 0.160 (éxito por ausencia de error).
    pub const CODEX_STOP: &str = r#"{
  "event": "SubagentStop",
  "agent_id": "cx-42",
  "session_id": "codex-main"
}"#;

    /// Hook `SubagentStop` de Codex 0.160 con error.
    pub const CODEX_STOP_ERROR: &str = r#"{
  "event": "SubagentStop",
  "agent_id": "cx-42",
  "session_id": "codex-main",
  "error": "spawn_agent failed: model unavailable"
}"#;
}

fn parse_error(what: &str) -> PortError {
    PortError::new(format!("payload de subagente inválido: {what}"))
}

fn parse_json(payload: &str) -> Result<serde_json::Value, PortError> {
    serde_json::from_str(payload).map_err(|e| parse_error(&e.to_string()))
}

/// `true` si el JSON de fin indica fallo (`success: false` o `error` no nulo).
fn stop_failed(value: &serde_json::Value) -> bool {
    if value.get("success") == Some(&serde_json::Value::Bool(false)) {
        return true;
    }
    match value.get("error") {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn required_id(value: &serde_json::Value, field: &str) -> Result<String, PortError> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| parse_error(&format!("falta '{field}'")))
}

fn optional_text(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Traductor de los hooks `SubagentStart` / `SubagentStop` de Claude Code.
pub struct ClaudeCodeTranslator;

impl SubagentEventTranslator for ClaudeCodeTranslator {
    fn agent(&self) -> KnownAgent {
        KnownAgent::ClaudeCode
    }

    fn translate(&self, payload: &str) -> Result<Vec<SubagentChange>, PortError> {
        let value = parse_json(payload)?;
        let event = value
            .get("hook_event_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| parse_error("falta 'hook_event_name'"))?;
        let subagent_id = required_id(&value, "agent_id")?;
        // La sesión principal actúa como padre; si falta, el subagente queda
        // como raíz (el árbol trata a los padres desconocidos como raíces).
        let parent_id = optional_text(&value, "session_id");
        match event {
            "SubagentStart" => Ok(vec![SubagentChange {
                subagent_id,
                parent_id,
                kind: optional_text(&value, "agent_type"),
                label: optional_text(&value, "description"),
                status: SubagentStatus::Running,
            }]),
            "SubagentStop" => Ok(vec![SubagentChange {
                subagent_id,
                parent_id,
                kind: None,
                label: None,
                status: if stop_failed(&value) {
                    SubagentStatus::Failed
                } else {
                    SubagentStatus::Completed
                },
            }]),
            other => Err(parse_error(&format!(
                "evento de Claude Code desconocido: '{other}'"
            ))),
        }
    }
}

/// Traductor del plugin `opencollab.ts` de OpenCode.
pub struct OpenCodeTranslator;

impl SubagentEventTranslator for OpenCodeTranslator {
    fn agent(&self) -> KnownAgent {
        KnownAgent::OpenCode
    }

    fn translate(&self, payload: &str) -> Result<Vec<SubagentChange>, PortError> {
        let value = parse_json(payload)?;
        let event = value
            .get("event")
            .and_then(|v| v.as_str())
            .ok_or_else(|| parse_error("falta 'event'"))?;
        match event {
            "session.created" => {
                let subagent_id = required_id(&value, "sessionID")?;
                Ok(vec![SubagentChange {
                    subagent_id,
                    parent_id: optional_text(&value, "parentID"),
                    kind: Some("task".to_string()),
                    label: None,
                    status: SubagentStatus::Running,
                }])
            }
            "tool.execute.after" => {
                // Solo el fin de `task` cierra un subagente; el resto de las
                // herramientas no generan cambios.
                if value.get("tool").and_then(|v| v.as_str()) != Some("task") {
                    return Ok(vec![]);
                }
                let subagent_id = required_id(&value, "sessionID")?;
                Ok(vec![SubagentChange {
                    subagent_id,
                    parent_id: None,
                    kind: None,
                    label: None,
                    status: if stop_failed(&value) {
                        SubagentStatus::Failed
                    } else {
                        SubagentStatus::Completed
                    },
                }])
            }
            other => Err(parse_error(&format!(
                "evento de OpenCode desconocido: '{other}'"
            ))),
        }
    }
}

/// Traductor de los hooks `SubagentStart` / `SubagentStop` de Codex.
pub struct CodexTranslator;

impl SubagentEventTranslator for CodexTranslator {
    fn agent(&self) -> KnownAgent {
        KnownAgent::Codex
    }

    fn translate(&self, payload: &str) -> Result<Vec<SubagentChange>, PortError> {
        let value = parse_json(payload)?;
        let event = value
            .get("event")
            .and_then(|v| v.as_str())
            .ok_or_else(|| parse_error("falta 'event'"))?;
        let subagent_id = required_id(&value, "agent_id")?;
        let parent_id = optional_text(&value, "session_id");
        match event {
            "SubagentStart" => Ok(vec![SubagentChange {
                subagent_id,
                parent_id,
                kind: optional_text(&value, "agent_type"),
                label: optional_text(&value, "description"),
                status: SubagentStatus::Running,
            }]),
            "SubagentStop" => Ok(vec![SubagentChange {
                subagent_id,
                parent_id,
                kind: None,
                label: None,
                status: if stop_failed(&value) {
                    SubagentStatus::Failed
                } else {
                    SubagentStatus::Completed
                },
            }]),
            other => Err(parse_error(&format!(
                "evento de Codex desconocido: '{other}'"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use application::agent_detection::KnownAgent;
    use application::ports::SubagentEventTranslator;
    use application::{RawSubagentEvent, SubagentStatus, TrackSubagents};

    use super::fixtures::*;
    use super::{ClaudeCodeTranslator, CodexTranslator, OpenCodeTranslator};

    #[test]
    fn claude_start_maps_running_with_parent_kind_label() {
        let changes = ClaudeCodeTranslator.translate(CLAUDE_START).unwrap();
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.subagent_id, "a6f3c9");
        assert_eq!(c.parent_id.as_deref(), Some("sess-principal-1"));
        assert_eq!(c.kind.as_deref(), Some("Explore"));
        assert_eq!(c.label.as_deref(), Some("buscar usos de foo en el repo"));
        assert_eq!(c.status, SubagentStatus::Running);
    }

    #[test]
    fn claude_stop_maps_completed_preserving_ids() {
        let changes = ClaudeCodeTranslator.translate(CLAUDE_STOP).unwrap();
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.subagent_id, "a6f3c9");
        assert_eq!(c.parent_id.as_deref(), Some("sess-principal-1"));
        assert_eq!(c.status, SubagentStatus::Completed);
    }

    #[test]
    fn claude_stop_error_maps_failed() {
        let changes = ClaudeCodeTranslator.translate(CLAUDE_STOP_ERROR).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].subagent_id, "a6f3c9");
        assert_eq!(changes[0].status, SubagentStatus::Failed);
    }

    #[test]
    fn claude_nested_start_keeps_subagent_parent() {
        let payload = r#"{
          "session_id": "sess-principal-1",
          "hook_event_name": "SubagentStart",
          "agent_id": "nieto-1",
          "agent_type": "Plan",
          "description": "plan anidado"
        }"#;
        // El padre real lo resuelve el hub por ids: el Stop posterior del
        // mismo id conserva kind/label del Start (merge last-write-wins).
        let start = &ClaudeCodeTranslator.translate(payload).unwrap()[0];
        assert_eq!(start.parent_id.as_deref(), Some("sess-principal-1"));
        let stop = &ClaudeCodeTranslator
            .translate(
                r#"{"session_id": "sess-principal-1", "hook_event_name": "SubagentStop", "agent_id": "nieto-1"}"#,
            )
            .unwrap()[0];
        assert_eq!(stop.subagent_id, start.subagent_id);
        assert_eq!(stop.status, SubagentStatus::Completed);
        assert!(stop.label.is_none());
    }

    #[test]
    fn claude_agent_matches_catalog() {
        assert_eq!(ClaudeCodeTranslator.agent(), KnownAgent::ClaudeCode);
    }

    #[test]
    fn claude_invalid_payload_is_port_error() {
        assert!(ClaudeCodeTranslator.translate("no es json").is_err());
        assert!(ClaudeCodeTranslator
            .translate(r#"{"hook_event_name": "SubagentStart"}"#)
            .is_err());
        assert!(ClaudeCodeTranslator
            .translate(r#"{"hook_event_name": "OtraCosa", "agent_id": "x"}"#)
            .is_err());
    }

    #[test]
    fn opencode_session_created_maps_running_nested() {
        let changes = OpenCodeTranslator
            .translate(OPENCODE_SESSION_CREATED)
            .unwrap();
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.subagent_id, "ses-hija-7");
        assert_eq!(c.parent_id.as_deref(), Some("ses-padre-2"));
        assert_eq!(c.status, SubagentStatus::Running);
    }

    #[test]
    fn opencode_session_without_parent_is_root() {
        let changes = OpenCodeTranslator
            .translate(r#"{"event": "session.created", "sessionID": "sola"}"#)
            .unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].parent_id.is_none());
        assert_eq!(changes[0].status, SubagentStatus::Running);
    }

    #[test]
    fn opencode_task_after_maps_completed() {
        let changes = OpenCodeTranslator.translate(OPENCODE_TASK_AFTER).unwrap();
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.subagent_id, "ses-hija-7");
        assert_eq!(c.status, SubagentStatus::Completed);
    }

    #[test]
    fn opencode_task_after_error_maps_failed() {
        let changes = OpenCodeTranslator
            .translate(OPENCODE_TASK_AFTER_ERROR)
            .unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].subagent_id, "ses-hija-7");
        assert_eq!(changes[0].status, SubagentStatus::Failed);
    }

    #[test]
    fn opencode_other_tool_is_ignored() {
        let changes = OpenCodeTranslator
            .translate(
                r#"{"event": "tool.execute.after", "tool": "read", "sessionID": "ses-hija-7"}"#,
            )
            .unwrap();
        assert!(changes.is_empty());
    }

    #[test]
    fn opencode_agent_matches_catalog() {
        assert_eq!(OpenCodeTranslator.agent(), KnownAgent::OpenCode);
    }

    #[test]
    fn opencode_invalid_payload_is_port_error() {
        assert!(OpenCodeTranslator.translate("{").is_err());
        assert!(OpenCodeTranslator
            .translate(r#"{"event": "session.created"}"#)
            .is_err());
    }

    #[test]
    fn codex_start_maps_running() {
        let changes = CodexTranslator.translate(CODEX_START).unwrap();
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.subagent_id, "cx-42");
        assert_eq!(c.parent_id.as_deref(), Some("codex-main"));
        assert_eq!(c.kind.as_deref(), Some("build"));
        assert_eq!(c.label.as_deref(), Some("compilar el workspace"));
        assert_eq!(c.status, SubagentStatus::Running);
    }

    #[test]
    fn codex_stop_maps_completed() {
        let changes = CodexTranslator.translate(CODEX_STOP).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].subagent_id, "cx-42");
        assert_eq!(changes[0].status, SubagentStatus::Completed);
    }

    #[test]
    fn codex_stop_error_maps_failed() {
        let changes = CodexTranslator.translate(CODEX_STOP_ERROR).unwrap();
        assert_eq!(changes[0].status, SubagentStatus::Failed);
    }

    #[test]
    fn codex_agent_matches_catalog() {
        assert_eq!(CodexTranslator.agent(), KnownAgent::Codex);
    }

    #[test]
    fn codex_invalid_payload_is_port_error() {
        assert!(CodexTranslator.translate("").is_err());
        assert!(CodexTranslator
            .translate(r#"{"event": "SubagentStart"}"#)
            .is_err());
    }

    #[test]
    fn hub_integration_with_real_translators() {
        use std::sync::Arc;
        let hub = TrackSubagents::new(vec![
            Arc::new(ClaudeCodeTranslator),
            Arc::new(OpenCodeTranslator),
            Arc::new(CodexTranslator),
        ]);
        let terminal = domain::TerminalId::new();
        for (agent, payload) in [
            (KnownAgent::ClaudeCode, CLAUDE_START),
            (KnownAgent::OpenCode, OPENCODE_SESSION_CREATED),
            (KnownAgent::Codex, CODEX_START),
        ] {
            let snap = hub
                .handle(RawSubagentEvent {
                    terminal,
                    agent,
                    payload: payload.into(),
                })
                .unwrap()
                .unwrap();
            assert!(!snap.is_empty());
        }
        let snap = hub.snapshot(terminal);
        assert_eq!(snap.len(), 3);
        // El fin por un traductor real cambia el estado en el hub.
        hub.handle(RawSubagentEvent {
            terminal,
            agent: KnownAgent::ClaudeCode,
            payload: CLAUDE_STOP.into(),
        })
        .unwrap();
        let done = hub
            .snapshot(terminal)
            .into_iter()
            .find(|s| s.id == "a6f3c9")
            .unwrap();
        assert_eq!(done.status, SubagentStatus::Completed);
        // La etiqueta del Start sobrevive al Stop sin etiqueta.
        assert_eq!(done.label.as_deref(), Some("buscar usos de foo en el repo"));
    }
}
