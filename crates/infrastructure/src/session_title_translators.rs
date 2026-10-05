//! Traductores de eventos crudos de hooks de agentes a títulos de sesión.
//!
//! Interpretan el JSON crudo que el receptor HTTP local entrega:
//! - Claude Code y Codex: capturan el prompt del usuario (`prompt` o `description`).
//! - OpenCode: captura `title` emitido por el plugin (`session.created`/`session.updated`).

use application::agent_detection::KnownAgent;
use application::ports::{PortError, SessionTitleTranslator};
use serde_json::Value;

fn parse_json(payload: &str) -> Result<Value, PortError> {
    serde_json::from_str(payload).map_err(|e| PortError::new(format!("payload JSON inválido: {e}")))
}

fn clean_title(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    if first_line.is_empty() {
        return None;
    }
    let title = if first_line.chars().count() > 100 {
        let truncated: String = first_line.chars().take(100).collect();
        format!("{truncated}...")
    } else {
        first_line.to_string()
    };
    Some(title)
}

pub struct ClaudeCodeTranslator;

impl SessionTitleTranslator for ClaudeCodeTranslator {
    fn agent(&self) -> KnownAgent {
        KnownAgent::ClaudeCode
    }

    fn translate(&self, payload: &str) -> Result<Option<String>, PortError> {
        let value = parse_json(payload)?;
        if let Some(prompt) = value.get("prompt").and_then(Value::as_str) {
            return Ok(clean_title(prompt));
        }
        if let Some(desc) = value.get("description").and_then(Value::as_str) {
            return Ok(clean_title(desc));
        }
        Ok(None)
    }
}

pub struct OpenCodeTranslator;

impl SessionTitleTranslator for OpenCodeTranslator {
    fn agent(&self) -> KnownAgent {
        KnownAgent::OpenCode
    }

    fn translate(&self, payload: &str) -> Result<Option<String>, PortError> {
        let value = parse_json(payload)?;
        if let Some(title) = value.get("title").and_then(Value::as_str) {
            return Ok(clean_title(title));
        }
        if let Some(title) = value
            .pointer("/properties/info/title")
            .and_then(Value::as_str)
        {
            return Ok(clean_title(title));
        }
        if let Some(prompt) = value.get("prompt").and_then(Value::as_str) {
            return Ok(clean_title(prompt));
        }
        Ok(None)
    }
}

pub struct CodexTranslator;

impl SessionTitleTranslator for CodexTranslator {
    fn agent(&self) -> KnownAgent {
        KnownAgent::Codex
    }

    fn translate(&self, payload: &str) -> Result<Option<String>, PortError> {
        let value = parse_json(payload)?;
        if let Some(prompt) = value.get("prompt").and_then(Value::as_str) {
            return Ok(clean_title(prompt));
        }
        if let Some(desc) = value.get("description").and_then(Value::as_str) {
            return Ok(clean_title(desc));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use application::{RawSessionEvent, TrackAgentSessionTitle};
    use domain::TerminalId;
    use std::sync::Arc;

    #[test]
    fn claude_extracts_and_cleans_prompt() {
        let translator = ClaudeCodeTranslator;
        assert_eq!(
            translator
                .translate(r#"{"prompt": "  arreglar bug de login  \nsegunda linea"}"#)
                .unwrap(),
            Some("arreglar bug de login".to_string())
        );

        let long = "a".repeat(150);
        let translated = translator
            .translate(&format!(r#"{{"prompt": "{long}"}}"#))
            .unwrap()
            .unwrap();
        assert_eq!(translated.len(), 103); // 100 + "..."
        assert!(translated.ends_with("..."));
    }

    #[test]
    fn opencode_extracts_title_or_nested_info() {
        let translator = OpenCodeTranslator;
        assert_eq!(
            translator
                .translate(r#"{"title": "Refactor auth"}"#)
                .unwrap(),
            Some("Refactor auth".to_string())
        );
        assert_eq!(
            translator
                .translate(r#"{"properties": {"info": {"title": "Build UI"}}}"#)
                .unwrap(),
            Some("Build UI".to_string())
        );
    }

    #[test]
    fn codex_extracts_prompt() {
        let translator = CodexTranslator;
        assert_eq!(
            translator
                .translate(r#"{"prompt": "agregar endpoint"}"#)
                .unwrap(),
            Some("agregar endpoint".to_string())
        );
    }

    #[test]
    fn empty_or_irrelevant_payload_returns_none() {
        let translator = ClaudeCodeTranslator;
        assert_eq!(translator.translate(r#"{"other": "data"}"#).unwrap(), None);
        assert_eq!(translator.translate(r#"{"prompt": "   "}"#).unwrap(), None);
    }

    #[test]
    fn malformed_json_returns_error() {
        let translator = ClaudeCodeTranslator;
        assert!(translator.translate(r#"not a json"#).is_err());
    }

    #[test]
    fn integration_with_tracker() {
        let tracker = TrackAgentSessionTitle::new(vec![
            Arc::new(ClaudeCodeTranslator),
            Arc::new(OpenCodeTranslator),
        ]);
        let terminal = TerminalId::new();

        let updated = tracker
            .handle(RawSessionEvent {
                terminal_id: terminal,
                agent: KnownAgent::OpenCode,
                payload: r#"{"title": "Nueva sesión"}"#.into(),
            })
            .unwrap();

        assert_eq!(updated, Some("Nueva sesión".to_string()));
        assert_eq!(tracker.title(terminal), Some("Nueva sesión".to_string()));
    }
}
