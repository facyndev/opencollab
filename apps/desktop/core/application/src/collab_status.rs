//! Estado de colaboración que muestra la status bar: si el relay responde y
//! cuántos participantes tiene la sesión.

use std::sync::Arc;

use domain::SessionId;

use crate::error::AppError;
use crate::ports::{RelayProbe, SessionRepository};

/// Resultado de sondear el relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayStatus {
    Connected { latency_ms: u64 },
    Disconnected,
}

/// Sondea el relay. Que no responda no es un error: es el estado `Disconnected`.
pub struct CheckRelay {
    probe: Arc<dyn RelayProbe>,
}

impl CheckRelay {
    pub fn new(probe: Arc<dyn RelayProbe>) -> Self {
        Self { probe }
    }

    pub fn execute(&self) -> RelayStatus {
        match self.probe.probe() {
            Ok(latency) => RelayStatus::Connected {
                // Mínimo 1 ms: una respuesta instantánea sigue siendo "conectado".
                latency_ms: (latency.as_millis() as u64).max(1),
            },
            Err(_) => RelayStatus::Disconnected,
        }
    }
}

/// Cuántos participantes de la sesión tienen acceso (al menos Ver). Quien no
/// puede ver la sesión no la está compartiendo con nadie, así que no cuenta.
pub struct SessionCollaborators {
    repo: Arc<dyn SessionRepository>,
}

impl SessionCollaborators {
    pub fn new(repo: Arc<dyn SessionRepository>) -> Self {
        Self { repo }
    }

    pub fn execute(&self, session_id: SessionId) -> Result<usize, AppError> {
        let session = self
            .repo
            .find_session(session_id)?
            .ok_or(AppError::SessionNotFound(session_id))?;
        Ok(session
            .participants()
            .iter()
            .filter(|p| p.access.can_view())
            .count())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    use domain::{AccessLevel, Session, UserId};

    use super::*;
    use crate::ports::PortError;

    struct FakeProbe(Result<Duration, PortError>);

    impl RelayProbe for FakeProbe {
        fn probe(&self) -> Result<Duration, PortError> {
            self.0.clone()
        }
    }

    #[test]
    fn relay_that_answers_is_connected_with_its_latency() {
        let check = CheckRelay::new(Arc::new(FakeProbe(Ok(Duration::from_millis(37)))));
        assert_eq!(check.execute(), RelayStatus::Connected { latency_ms: 37 });
    }

    #[test]
    fn instant_answer_still_reports_at_least_one_millisecond() {
        let check = CheckRelay::new(Arc::new(FakeProbe(Ok(Duration::from_micros(200)))));
        assert_eq!(check.execute(), RelayStatus::Connected { latency_ms: 1 });
    }

    #[test]
    fn failing_probe_is_disconnected_not_an_error() {
        let check = CheckRelay::new(Arc::new(FakeProbe(Err(PortError::new("sin relay")))));
        assert_eq!(check.execute(), RelayStatus::Disconnected);
    }

    #[derive(Default)]
    struct FakeRepo {
        sessions: Mutex<HashMap<SessionId, Session>>,
    }

    impl SessionRepository for FakeRepo {
        fn find_session(&self, id: SessionId) -> Result<Option<Session>, PortError> {
            Ok(self.sessions.lock().unwrap().get(&id).cloned())
        }
        fn save_session(&self, session: Session) -> Result<(), PortError> {
            self.sessions.lock().unwrap().insert(session.id(), session);
            Ok(())
        }
    }

    struct World {
        viewer: UserId,
        session_id: SessionId,
        repo: Arc<FakeRepo>,
    }

    fn world() -> World {
        let owner = UserId::new();
        let viewer = UserId::new();
        let mut session = Session::new(owner, "sesión");
        session.set_access(viewer, AccessLevel::View).unwrap();
        let session_id = session.id();
        let repo = Arc::new(FakeRepo::default());
        repo.save_session(session).unwrap();
        World {
            viewer,
            session_id,
            repo,
        }
    }

    #[test]
    fn counts_owner_and_viewers_granted_by_the_server() {
        let w = world();
        let count = SessionCollaborators::new(w.repo.clone()).execute(w.session_id);
        assert_eq!(count, Ok(2));
    }

    #[test]
    fn participant_without_view_is_not_counted() {
        let w = world();
        let mut session = w.repo.find_session(w.session_id).unwrap().unwrap();
        session.set_access(w.viewer, AccessLevel::None).unwrap();
        w.repo.save_session(session).unwrap();
        let count = SessionCollaborators::new(w.repo.clone()).execute(w.session_id);
        assert_eq!(count, Ok(1));
    }

    #[test]
    fn unknown_session_is_an_error() {
        let w = world();
        let missing = SessionId::new();
        let count = SessionCollaborators::new(w.repo.clone()).execute(missing);
        assert_eq!(count, Err(AppError::SessionNotFound(missing)));
    }
}
