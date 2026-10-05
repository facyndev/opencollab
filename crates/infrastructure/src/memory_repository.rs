use std::collections::HashMap;
use std::sync::Mutex;

use application::ports::{PortError, WorkspaceRepository};
use domain::{Session, SessionId, Workspace, WorkspaceId};

/// Repositorio en memoria. Sirve para el desktop mientras no haya persistencia.
#[derive(Default)]
pub struct InMemoryWorkspaceRepository {
    workspaces: Mutex<HashMap<WorkspaceId, Workspace>>,
    sessions: Mutex<HashMap<SessionId, Session>>,
}

impl InMemoryWorkspaceRepository {
    pub fn new() -> Self {
        Self::default()
    }
}

fn poisoned<T>(_: T) -> PortError {
    PortError::new("repositorio en memoria envenenado")
}

impl WorkspaceRepository for InMemoryWorkspaceRepository {
    fn find_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>, PortError> {
        Ok(self.workspaces.lock().map_err(poisoned)?.get(&id).cloned())
    }

    fn save_workspace(&self, workspace: Workspace) -> Result<(), PortError> {
        self.workspaces
            .lock()
            .map_err(poisoned)?
            .insert(workspace.id(), workspace);
        Ok(())
    }

    fn find_session(&self, id: SessionId) -> Result<Option<Session>, PortError> {
        Ok(self.sessions.lock().map_err(poisoned)?.get(&id).cloned())
    }

    fn save_session(&self, session: Session) -> Result<(), PortError> {
        self.sessions
            .lock()
            .map_err(poisoned)?
            .insert(session.id(), session);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use domain::UserId;

    use super::*;

    #[test]
    fn saves_and_finds() {
        let repo = InMemoryWorkspaceRepository::new();
        let owner = UserId::new();
        let ws = Workspace::new(owner, "p");
        let session = Session::new(&ws, owner, "s").unwrap();
        let (ws_id, s_id) = (ws.id(), session.id());
        repo.save_workspace(ws).unwrap();
        repo.save_session(session).unwrap();
        assert!(repo.find_workspace(ws_id).unwrap().is_some());
        assert!(repo.find_session(s_id).unwrap().is_some());
        assert!(repo.find_session(SessionId::new()).unwrap().is_none());
    }
}
