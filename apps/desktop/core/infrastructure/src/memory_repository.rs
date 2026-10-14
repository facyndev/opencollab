use std::collections::HashMap;
use std::sync::Mutex;

use application::ports::{PortError, SessionRepository};
use domain::{Session, SessionId};

/// Repositorio en memoria. Sirve para el desktop mientras no haya persistencia.
#[derive(Default)]
pub struct InMemorySessionRepository {
    sessions: Mutex<HashMap<SessionId, Session>>,
}

impl InMemorySessionRepository {
    pub fn new() -> Self {
        Self::default()
    }
}

fn poisoned<T>(_: T) -> PortError {
    PortError::new("repositorio en memoria envenenado")
}

impl SessionRepository for InMemorySessionRepository {
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
        let repo = InMemorySessionRepository::new();
        let session = Session::new(UserId::new(), "s");
        let id = session.id();
        repo.save_session(session).unwrap();
        assert!(repo.find_session(id).unwrap().is_some());
        assert!(repo.find_session(SessionId::new()).unwrap().is_none());
    }
}
