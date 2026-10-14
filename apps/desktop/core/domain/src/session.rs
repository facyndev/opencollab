use std::collections::HashMap;

use crate::error::DomainError;
use crate::ids::{SessionId, TerminalId, UserId};
use crate::permission::AccessLevel;
use crate::terminal::{AgentProfile, Terminal};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Participant {
    pub user_id: UserId,
    pub access: AccessLevel,
}

/// Sesión local del host: grupo de terminales que se ven juntas en una grilla.
///
/// El server es quien decide los permisos; acá solo se guarda el último nivel
/// que mandó para cada usuario ([`Session::set_access`]) y se valida contra él
/// antes de escribir en un PTY. Un usuario sin entrada no tiene acceso (falla
/// cerrado); el dueño siempre escribe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    id: SessionId,
    name: String,
    owner: UserId,
    terminals: Vec<Terminal>,
    access: HashMap<UserId, AccessLevel>,
}

impl Session {
    pub fn new(owner: UserId, name: impl Into<String>) -> Self {
        Self {
            id: SessionId::new(),
            name: name.into(),
            owner,
            terminals: Vec::new(),
            access: HashMap::new(),
        }
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn owner(&self) -> UserId {
        self.owner
    }

    pub fn terminals(&self) -> &[Terminal] {
        &self.terminals
    }

    pub fn terminal(&self, id: TerminalId) -> Option<&Terminal> {
        self.terminals.iter().find(|t| t.id == id)
    }

    /// Fuente única de verdad del acceso de `user` a esta sesión.
    pub fn access_of(&self, user: UserId) -> AccessLevel {
        if user == self.owner {
            return AccessLevel::Write;
        }
        self.access.get(&user).copied().unwrap_or(AccessLevel::None)
    }

    pub fn can_view(&self, user: UserId) -> bool {
        self.access_of(user).can_view()
    }

    pub fn can_write(&self, user: UserId) -> bool {
        self.access_of(user).can_write()
    }

    /// El dueño y los usuarios con al menos Ver, con su acceso vigente.
    pub fn participants(&self) -> Vec<Participant> {
        let owner = std::iter::once(self.owner);
        let granted = self.access.keys().copied();
        owner
            .chain(granted)
            .filter(|user| self.can_view(*user))
            .map(|user_id| Participant {
                user_id,
                access: self.access_of(user_id),
            })
            .collect()
    }

    /// Aplica el nivel que mandó el server para `user`. El del dueño no se puede cambiar.
    pub fn set_access(&mut self, user: UserId, level: AccessLevel) -> Result<(), DomainError> {
        if user == self.owner {
            return Err(DomainError::CannotChangeOwnerAccess);
        }
        if level == AccessLevel::None {
            self.access.remove(&user);
        } else {
            self.access.insert(user, level);
        }
        Ok(())
    }

    pub fn add_terminal(
        &mut self,
        actor: UserId,
        profile: AgentProfile,
    ) -> Result<TerminalId, DomainError> {
        self.ensure_owner(actor)?;
        let id = TerminalId::new();
        self.terminals.push(Terminal { id, profile });
        Ok(id)
    }

    /// Quita una terminal de la sesión. Igual que agregarlas, es del dueño.
    pub fn remove_terminal(&mut self, actor: UserId, id: TerminalId) -> Result<(), DomainError> {
        self.ensure_owner(actor)?;
        self.ensure_has_terminal(id)?;
        self.terminals.retain(|t| t.id != id);
        Ok(())
    }

    pub fn ensure_has_terminal(&self, id: TerminalId) -> Result<(), DomainError> {
        self.terminal(id)
            .map(|_| ())
            .ok_or(DomainError::TerminalNotInSession(id))
    }

    fn ensure_owner(&self, actor: UserId) -> Result<(), DomainError> {
        if actor == self.owner {
            Ok(())
        } else {
            Err(DomainError::NotOwner)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> (UserId, Session) {
        let owner = UserId::new();
        (owner, Session::new(owner, "sesión"))
    }

    #[test]
    fn owner_always_writes() {
        let (owner, mut s) = session();
        assert_eq!(s.access_of(owner), AccessLevel::Write);
        assert!(s.can_write(owner));
        assert_eq!(
            s.set_access(owner, AccessLevel::None),
            Err(DomainError::CannotChangeOwnerAccess)
        );
        assert!(s.can_write(owner));
    }

    #[test]
    fn unknown_user_has_no_access() {
        let (_, s) = session();
        let stranger = UserId::new();
        assert_eq!(s.access_of(stranger), AccessLevel::None);
        assert!(!s.can_view(stranger) && !s.can_write(stranger));
    }

    #[test]
    fn server_levels_drive_view_and_write() {
        let (_, mut s) = session();
        let user = UserId::new();
        s.set_access(user, AccessLevel::View).unwrap();
        assert!(s.can_view(user) && !s.can_write(user));
        s.set_access(user, AccessLevel::Write).unwrap();
        assert!(s.can_view(user) && s.can_write(user));
        s.set_access(user, AccessLevel::None).unwrap();
        assert!(!s.can_view(user) && !s.can_write(user));
    }

    #[test]
    fn participants_are_owner_plus_viewers() {
        let (owner, mut s) = session();
        let viewer = UserId::new();
        let revoked = UserId::new();
        s.set_access(viewer, AccessLevel::View).unwrap();
        s.set_access(revoked, AccessLevel::Write).unwrap();
        s.set_access(revoked, AccessLevel::None).unwrap();
        let participants = s.participants();
        assert_eq!(participants.len(), 2);
        assert!(participants.contains(&Participant {
            user_id: owner,
            access: AccessLevel::Write
        }));
        assert!(participants.contains(&Participant {
            user_id: viewer,
            access: AccessLevel::View
        }));
    }

    #[test]
    fn only_owner_manages_terminals() {
        let (owner, mut s) = session();
        let other = UserId::new();
        s.set_access(other, AccessLevel::Write).unwrap();
        let profile = AgentProfile::new("shell", "sh").unwrap();
        assert_eq!(
            s.add_terminal(other, profile.clone()),
            Err(DomainError::NotOwner)
        );
        let terminal = s.add_terminal(owner, profile).unwrap();
        assert_eq!(
            s.remove_terminal(other, terminal),
            Err(DomainError::NotOwner)
        );
        s.remove_terminal(owner, terminal).unwrap();
        assert!(s.terminal(terminal).is_none());
        assert_eq!(
            s.remove_terminal(owner, terminal),
            Err(DomainError::TerminalNotInSession(terminal))
        );
    }
}
