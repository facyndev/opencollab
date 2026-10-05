//! Gestión del título o prompt de la sesión del agente que corre en cada terminal.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use domain::TerminalId;

use crate::agent_detection::KnownAgent;
use crate::error::AppError;
use crate::ports::SessionTitleTranslator;

/// Endpoint del receptor local de hooks, inyectado en el PTY de cada terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEndpoint {
    pub url: String,
    pub token: String,
}

impl HookEndpoint {
    pub const ENV_TERMINAL_ID: &'static str = "OPENCOLLAB_TERMINAL_ID";
    pub const ENV_URL: &'static str = "OPENCOLLAB_HOOK_URL";
    pub const ENV_TOKEN: &'static str = "OPENCOLLAB_HOOK_TOKEN";

    pub fn new(url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            token: token.into(),
        }
    }
}

/// Evento crudo de sesión recibido desde el hook de un agente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSessionEvent {
    pub terminal_id: TerminalId,
    pub agent: KnownAgent,
    pub payload: String,
}

/// Mantiene en memoria el título o prompt activo de la sesión de cada terminal.
pub struct TrackAgentSessionTitle {
    translators: Vec<Arc<dyn SessionTitleTranslator>>,
    titles: Mutex<HashMap<TerminalId, String>>,
}

impl TrackAgentSessionTitle {
    pub fn new(translators: Vec<Arc<dyn SessionTitleTranslator>>) -> Self {
        Self {
            translators,
            titles: Mutex::new(HashMap::new()),
        }
    }

    /// Procesa un evento crudo de hook. Devuelve `Some(title)` si el título de
    /// la terminal cambió a un valor nuevo o diferente.
    pub fn handle(&self, event: RawSessionEvent) -> Result<Option<String>, AppError> {
        let translator = self
            .translators
            .iter()
            .find(|t| t.agent() == event.agent)
            .ok_or(AppError::NoSessionTitleTranslator(event.agent))?;

        let Some(title) = translator.translate(&event.payload)? else {
            return Ok(None);
        };

        let mut lock = self.titles.lock().unwrap();
        if lock.get(&event.terminal_id).map(String::as_str) == Some(&title) {
            return Ok(None);
        }
        lock.insert(event.terminal_id, title.clone());
        Ok(Some(title))
    }

    /// Título actual de la terminal, si tiene uno registrado.
    pub fn title(&self, terminal: TerminalId) -> Option<String> {
        self.titles.lock().unwrap().get(&terminal).cloned()
    }

    /// Al cerrar una terminal, descarta su título. Devuelve `true` si había uno.
    pub fn forget(&self, terminal: TerminalId) -> bool {
        self.titles.lock().unwrap().remove(&terminal).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::PortError;

    struct FakeTranslator {
        agent: KnownAgent,
        title: Option<String>,
        fail: bool,
    }

    impl FakeTranslator {
        fn success(agent: KnownAgent, title: impl Into<String>) -> Arc<Self> {
            Arc::new(Self {
                agent,
                title: Some(title.into()),
                fail: false,
            })
        }

        fn ignore(agent: KnownAgent) -> Arc<Self> {
            Arc::new(Self {
                agent,
                title: None,
                fail: false,
            })
        }

        fn failing(agent: KnownAgent) -> Arc<Self> {
            Arc::new(Self {
                agent,
                title: None,
                fail: true,
            })
        }
    }

    impl SessionTitleTranslator for FakeTranslator {
        fn agent(&self) -> KnownAgent {
            self.agent
        }

        fn translate(&self, _payload: &str) -> Result<Option<String>, PortError> {
            if self.fail {
                return Err(PortError::new("payload corrupto"));
            }
            Ok(self.title.clone())
        }
    }

    fn event(terminal_id: TerminalId, agent: KnownAgent, payload: &str) -> RawSessionEvent {
        RawSessionEvent {
            terminal_id,
            agent,
            payload: payload.to_string(),
        }
    }

    #[test]
    fn handle_updates_title_and_returns_it() {
        let terminal = TerminalId::new();
        let tracker = TrackAgentSessionTitle::new(vec![FakeTranslator::success(
            KnownAgent::ClaudeCode,
            "arreglar bug de auth",
        )]);

        let result = tracker
            .handle(event(terminal, KnownAgent::ClaudeCode, "{}"))
            .unwrap();

        assert_eq!(result, Some("arreglar bug de auth".to_string()));
        assert_eq!(
            tracker.title(terminal),
            Some("arreglar bug de auth".to_string())
        );
    }

    #[test]
    fn handle_with_same_title_returns_none() {
        let terminal = TerminalId::new();
        let tracker = TrackAgentSessionTitle::new(vec![FakeTranslator::success(
            KnownAgent::ClaudeCode,
            "mismo titulo",
        )]);

        assert_eq!(
            tracker
                .handle(event(terminal, KnownAgent::ClaudeCode, "{}"))
                .unwrap(),
            Some("mismo titulo".to_string())
        );
        assert_eq!(
            tracker
                .handle(event(terminal, KnownAgent::ClaudeCode, "{}"))
                .unwrap(),
            None
        );
    }

    #[test]
    fn handle_fails_for_agent_without_translator() {
        let tracker = TrackAgentSessionTitle::new(vec![]);
        let err = tracker
            .handle(event(TerminalId::new(), KnownAgent::Codex, "{}"))
            .unwrap_err();
        assert_eq!(err, AppError::NoSessionTitleTranslator(KnownAgent::Codex));
    }

    #[test]
    fn handle_surfaces_translator_error() {
        let tracker = TrackAgentSessionTitle::new(vec![FakeTranslator::failing(KnownAgent::OpenCode)]);
        let err = tracker
            .handle(event(TerminalId::new(), KnownAgent::OpenCode, "{}"))
            .unwrap_err();
        assert!(matches!(err, AppError::Port(_)));
    }

    #[test]
    fn handle_returns_none_when_translator_returns_none() {
        let tracker = TrackAgentSessionTitle::new(vec![FakeTranslator::ignore(KnownAgent::OpenCode)]);
        let result = tracker
            .handle(event(TerminalId::new(), KnownAgent::OpenCode, "{}"))
            .unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn forget_removes_title_and_reports_truthful_status() {
        let terminal = TerminalId::new();
        let tracker = TrackAgentSessionTitle::new(vec![FakeTranslator::success(
            KnownAgent::ClaudeCode,
            "tarea temporal",
        )]);

        tracker
            .handle(event(terminal, KnownAgent::ClaudeCode, "{}"))
            .unwrap();
        assert_eq!(tracker.title(terminal), Some("tarea temporal".to_string()));

        assert!(tracker.forget(terminal));
        assert_eq!(tracker.title(terminal), None);
        assert!(!tracker.forget(terminal));
    }
}
