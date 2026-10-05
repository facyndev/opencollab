//! Seguimiento de subagentes por terminal: el modelo que los hooks de cada
//! agente alimentan y el árbol que la UI consume.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use domain::TerminalId;

use crate::agent_detection::KnownAgent;
use crate::error::AppError;
use crate::ports::SubagentEventTranslator;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    Running,
    Completed,
    Failed,
}

/// Lo que un traductor extrae de un payload crudo de hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentChange {
    pub subagent_id: String,
    pub parent_id: Option<String>,
    /// Tipo de subagente según el agente (por ejemplo "explore").
    pub kind: Option<String>,
    /// Descripción corta de la tarea.
    pub label: Option<String>,
    pub status: SubagentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subagent {
    pub id: String,
    pub parent_id: Option<String>,
    pub agent: KnownAgent,
    pub kind: Option<String>,
    pub label: Option<String>,
    pub status: SubagentStatus,
}

/// Evento crudo tal como lo arma el receptor: la terminal sale del entorno
/// inyectado en el PTY, no del payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSubagentEvent {
    pub terminal: TerminalId,
    pub agent: KnownAgent,
    pub payload: String,
}

/// Subagentes de una terminal, en orden de aparición.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubagentTree {
    subagents: Vec<Subagent>,
}

impl SubagentTree {
    pub fn new() -> Self {
        Self::default()
    }

    /// Aplica un cambio (upsert). Devuelve `true` si el árbol cambió.
    ///
    /// El estado es last-write-wins; `parent_id`, `kind` y `label` solo se
    /// pisan con `Some`, para que un Stop sin etiqueta no borre la del Start.
    /// Un fin de un id desconocido lo inserta: se perdió el inicio.
    pub fn apply(&mut self, agent: KnownAgent, change: SubagentChange) -> bool {
        let Some(existing) = self
            .subagents
            .iter_mut()
            .find(|s| s.id == change.subagent_id)
        else {
            self.subagents.push(Subagent {
                id: change.subagent_id,
                parent_id: change.parent_id,
                agent,
                kind: change.kind,
                label: change.label,
                status: change.status,
            });
            return true;
        };
        let mut changed = existing.status != change.status;
        existing.status = change.status;
        changed |= overwrite(&mut existing.parent_id, change.parent_id);
        changed |= overwrite(&mut existing.kind, change.kind);
        changed |= overwrite(&mut existing.label, change.label);
        changed
    }

    pub fn subagents(&self) -> &[Subagent] {
        &self.subagents
    }

    /// Subagentes sin padre, o cuyo padre no es un subagente conocido (por
    /// ejemplo, Claude Code informa el id de la sesión principal como padre).
    pub fn roots(&self) -> Vec<&Subagent> {
        self.subagents
            .iter()
            .filter(|s| match &s.parent_id {
                None => true,
                Some(parent) => !self.subagents.iter().any(|p| &p.id == parent),
            })
            .collect()
    }

    pub fn children(&self, id: &str) -> Vec<&Subagent> {
        self.subagents
            .iter()
            .filter(|s| s.parent_id.as_deref() == Some(id))
            .collect()
    }
}

/// Recibe los eventos crudos de los hooks, los traduce y mantiene el árbol de
/// subagentes de cada terminal.
pub struct TrackSubagents {
    translators: Vec<Arc<dyn SubagentEventTranslator>>,
    trees: Mutex<HashMap<TerminalId, SubagentTree>>,
}

impl TrackSubagents {
    pub fn new(translators: Vec<Arc<dyn SubagentEventTranslator>>) -> Self {
        Self {
            translators,
            trees: Mutex::new(HashMap::new()),
        }
    }

    /// Aplica el evento. Devuelve la foto de la terminal solo si algo cambió.
    pub fn handle(&self, event: RawSubagentEvent) -> Result<Option<Vec<Subagent>>, AppError> {
        let translator = self
            .translators
            .iter()
            .find(|t| t.agent() == event.agent)
            .ok_or(AppError::NoSubagentTranslator(event.agent))?;
        let changes = translator.translate(&event.payload)?;
        let mut trees = self.trees();
        let tree = trees.entry(event.terminal).or_default();
        let mut changed = false;
        for change in changes {
            changed |= tree.apply(event.agent, change);
        }
        Ok(changed.then(|| tree.subagents().to_vec()))
    }

    pub fn snapshot(&self, terminal: TerminalId) -> Vec<Subagent> {
        self.trees()
            .get(&terminal)
            .map(|tree| tree.subagents().to_vec())
            .unwrap_or_default()
    }

    /// La terminal se cerró: descarta su árbol.
    pub fn forget(&self, terminal: TerminalId) {
        self.trees().remove(&terminal);
    }

    fn trees(&self) -> MutexGuard<'_, HashMap<TerminalId, SubagentTree>> {
        // Un pánico ajeno no debe volver inútil el seguimiento: el mapa sigue
        // siendo consistente porque cada operación lo deja completo.
        self.trees.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Reemplaza `current` solo si llega un valor distinto; `true` si cambió.
fn overwrite(current: &mut Option<String>, incoming: Option<String>) -> bool {
    match incoming {
        Some(value) if current.as_ref() != Some(&value) => {
            *current = Some(value);
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(id: &str, status: SubagentStatus) -> SubagentChange {
        SubagentChange {
            subagent_id: id.into(),
            parent_id: None,
            kind: None,
            label: None,
            status,
        }
    }

    const CLAUDE: KnownAgent = KnownAgent::ClaudeCode;

    #[test]
    fn start_inserts_subagent() {
        let mut tree = SubagentTree::new();
        let started = SubagentChange {
            kind: Some("explore".into()),
            label: Some("buscar".into()),
            ..change("a", SubagentStatus::Running)
        };
        assert!(tree.apply(CLAUDE, started));
        assert_eq!(tree.subagents().len(), 1);
        let s = &tree.subagents()[0];
        assert_eq!(s.id, "a");
        assert_eq!(s.agent, CLAUDE);
        assert_eq!(s.kind.as_deref(), Some("explore"));
        assert_eq!(s.status, SubagentStatus::Running);
    }

    #[test]
    fn finish_updates_status_and_keeps_label() {
        let mut tree = SubagentTree::new();
        tree.apply(
            CLAUDE,
            SubagentChange {
                label: Some("buscar".into()),
                ..change("a", SubagentStatus::Running)
            },
        );
        assert!(tree.apply(CLAUDE, change("a", SubagentStatus::Completed)));
        assert_eq!(tree.subagents().len(), 1);
        assert_eq!(tree.subagents()[0].status, SubagentStatus::Completed);
        assert_eq!(tree.subagents()[0].label.as_deref(), Some("buscar"));
    }

    #[test]
    fn some_fields_overwrite_previous_values() {
        let mut tree = SubagentTree::new();
        tree.apply(
            CLAUDE,
            SubagentChange {
                label: Some("viejo".into()),
                ..change("a", SubagentStatus::Running)
            },
        );
        tree.apply(
            CLAUDE,
            SubagentChange {
                label: Some("nuevo".into()),
                ..change("a", SubagentStatus::Failed)
            },
        );
        assert_eq!(tree.subagents()[0].label.as_deref(), Some("nuevo"));
        assert_eq!(tree.subagents()[0].status, SubagentStatus::Failed);
    }

    #[test]
    fn finish_for_unknown_id_inserts_it() {
        let mut tree = SubagentTree::new();
        assert!(tree.apply(CLAUDE, change("x", SubagentStatus::Completed)));
        assert_eq!(tree.subagents()[0].status, SubagentStatus::Completed);
    }

    #[test]
    fn repeated_change_reports_no_change() {
        let mut tree = SubagentTree::new();
        assert!(tree.apply(CLAUDE, change("a", SubagentStatus::Running)));
        assert!(!tree.apply(CLAUDE, change("a", SubagentStatus::Running)));
    }

    #[test]
    fn nested_subagents_form_children_and_roots() {
        let mut tree = SubagentTree::new();
        tree.apply(CLAUDE, change("a", SubagentStatus::Running));
        tree.apply(
            CLAUDE,
            SubagentChange {
                parent_id: Some("a".into()),
                ..change("b", SubagentStatus::Running)
            },
        );
        let roots: Vec<&str> = tree.roots().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(roots, vec!["a"]);
        let children: Vec<&str> = tree.children("a").iter().map(|s| s.id.as_str()).collect();
        assert_eq!(children, vec!["b"]);
        assert!(tree.children("b").is_empty());
    }

    #[test]
    fn parent_missing_from_tree_is_root() {
        let mut tree = SubagentTree::new();
        tree.apply(
            CLAUDE,
            SubagentChange {
                parent_id: Some("sesion-principal".into()),
                ..change("a", SubagentStatus::Running)
            },
        );
        assert_eq!(tree.roots().len(), 1);
    }

    use crate::ports::PortError;

    struct FakeTranslator {
        agent: KnownAgent,
        result: Result<Vec<SubagentChange>, PortError>,
    }

    impl SubagentEventTranslator for FakeTranslator {
        fn agent(&self) -> KnownAgent {
            self.agent
        }
        fn translate(&self, _payload: &str) -> Result<Vec<SubagentChange>, PortError> {
            self.result.clone()
        }
    }

    fn hub(result: Result<Vec<SubagentChange>, PortError>) -> TrackSubagents {
        TrackSubagents::new(vec![Arc::new(FakeTranslator {
            agent: CLAUDE,
            result,
        })])
    }

    fn event(terminal: TerminalId, agent: KnownAgent) -> RawSubagentEvent {
        RawSubagentEvent {
            terminal,
            agent,
            payload: "{}".into(),
        }
    }

    #[test]
    fn hub_returns_snapshot_when_something_changed() {
        let hub = hub(Ok(vec![change("a", SubagentStatus::Running)]));
        let t = TerminalId::new();
        let snap = hub.handle(event(t, CLAUDE)).unwrap().unwrap();
        assert_eq!(snap.len(), 1);
        assert_eq!(hub.snapshot(t), snap);
    }

    #[test]
    fn hub_returns_none_when_nothing_changed() {
        let hub = hub(Ok(vec![change("a", SubagentStatus::Running)]));
        let t = TerminalId::new();
        hub.handle(event(t, CLAUDE)).unwrap();
        assert_eq!(hub.handle(event(t, CLAUDE)).unwrap(), None);
    }

    #[test]
    fn hub_fails_for_agent_without_translator() {
        let hub = hub(Ok(vec![]));
        let err = hub
            .handle(event(TerminalId::new(), KnownAgent::Codex))
            .unwrap_err();
        assert_eq!(err, AppError::NoSubagentTranslator(KnownAgent::Codex));
    }

    #[test]
    fn hub_surfaces_translator_error() {
        let hub = hub(Err(PortError::new("payload inválido")));
        let err = hub.handle(event(TerminalId::new(), CLAUDE)).unwrap_err();
        assert_eq!(err, AppError::Port(PortError::new("payload inválido")));
    }

    #[test]
    fn hub_forget_clears_terminal() {
        let hub = hub(Ok(vec![change("a", SubagentStatus::Running)]));
        let t = TerminalId::new();
        hub.handle(event(t, CLAUDE)).unwrap();
        hub.forget(t);
        assert!(hub.snapshot(t).is_empty());
    }

    #[test]
    fn hub_isolates_terminals() {
        let hub = hub(Ok(vec![change("a", SubagentStatus::Running)]));
        let (t1, t2) = (TerminalId::new(), TerminalId::new());
        hub.handle(event(t1, CLAUDE)).unwrap();
        assert!(hub.snapshot(t2).is_empty());
        assert!(hub.handle(event(t2, CLAUDE)).unwrap().is_some());
    }
}
