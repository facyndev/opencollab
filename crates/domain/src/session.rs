use std::collections::HashMap;

use crate::error::DomainError;
use crate::ids::{InvitationId, SessionId, TerminalId, UserId, WorkspaceId};
use crate::invitation::{Invitation, InvitationTarget};
use crate::permission::AccessLevel;
use crate::terminal::{AgentProfile, Terminal};
use crate::workspace::Workspace;

/// Invitado temporal: accede solo a esta sesión, nunca al resto del workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGuest {
    pub user_id: UserId,
    pub access: AccessLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticipantRole {
    Owner,
    Member,
    Guest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Participant {
    pub user_id: UserId,
    pub role: ParticipantRole,
    pub access: AccessLevel,
}

/// Grupo de varias terminales que se ven juntas en una grilla. Es la unidad
/// que se comparte en vivo.
///
/// El acceso efectivo de un miembro del workspace es su override en esta
/// sesión o, si no tiene, [`AccessLevel::DEFAULT`] (Ver). Así un miembro
/// agregado después de crear la sesión también arranca con Ver, sin tener
/// que recorrer las sesiones existentes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    id: SessionId,
    workspace_id: WorkspaceId,
    name: String,
    terminals: Vec<Terminal>,
    member_overrides: HashMap<UserId, AccessLevel>,
    guests: Vec<SessionGuest>,
}

impl Session {
    pub fn new(
        workspace: &Workspace,
        actor: UserId,
        name: impl Into<String>,
    ) -> Result<Self, DomainError> {
        workspace.ensure_owner(actor)?;
        Ok(Self {
            id: SessionId::new(),
            workspace_id: workspace.id(),
            name: name.into(),
            terminals: Vec::new(),
            member_overrides: HashMap::new(),
            guests: Vec::new(),
        })
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    pub fn workspace_id(&self) -> WorkspaceId {
        self.workspace_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn terminals(&self) -> &[Terminal] {
        &self.terminals
    }

    pub fn terminal(&self, id: TerminalId) -> Option<&Terminal> {
        self.terminals.iter().find(|t| t.id == id)
    }

    pub fn guests(&self) -> &[SessionGuest] {
        &self.guests
    }

    fn ensure_belongs_to(&self, workspace: &Workspace) -> Result<(), DomainError> {
        if workspace.id() == self.workspace_id {
            Ok(())
        } else {
            Err(DomainError::WorkspaceMismatch {
                session: self.id,
                workspace: workspace.id(),
            })
        }
    }

    fn guest(&self, user: UserId) -> Option<&SessionGuest> {
        self.guests.iter().find(|g| g.user_id == user)
    }

    fn role_of(&self, workspace: &Workspace, user: UserId) -> Option<ParticipantRole> {
        if workspace.is_owner(user) {
            Some(ParticipantRole::Owner)
        } else if workspace.is_member(user) {
            Some(ParticipantRole::Member)
        } else if self.guest(user).is_some() {
            Some(ParticipantRole::Guest)
        } else {
            None
        }
    }

    /// Fuente única de verdad del acceso de `user` a esta sesión.
    /// Si `workspace` no es el de la sesión, el resultado es `None` (sin acceso).
    pub fn access_of(&self, workspace: &Workspace, user: UserId) -> AccessLevel {
        if self.ensure_belongs_to(workspace).is_err() {
            return AccessLevel::None;
        }
        match self.role_of(workspace, user) {
            Some(ParticipantRole::Owner) => AccessLevel::Write,
            Some(ParticipantRole::Member) => self
                .member_overrides
                .get(&user)
                .copied()
                .unwrap_or(AccessLevel::DEFAULT),
            Some(ParticipantRole::Guest) => self
                .guest(user)
                .map(|g| g.access)
                .unwrap_or(AccessLevel::None),
            None => AccessLevel::None,
        }
    }

    pub fn can_view(&self, workspace: &Workspace, user: UserId) -> bool {
        self.access_of(workspace, user).can_view()
    }

    pub fn can_write(&self, workspace: &Workspace, user: UserId) -> bool {
        self.access_of(workspace, user).can_write()
    }

    /// Todos los que podrían participar (dueño, miembros e invitados) con su acceso vigente.
    pub fn participants(&self, workspace: &Workspace) -> Vec<Participant> {
        if self.ensure_belongs_to(workspace).is_err() {
            return Vec::new();
        }
        let owner = std::iter::once(workspace.owner());
        let members = workspace.members().iter().map(|m| m.user_id);
        let guests = self.guests.iter().map(|g| g.user_id);
        owner
            .chain(members)
            .chain(guests)
            .filter_map(|user_id| {
                self.role_of(workspace, user_id).map(|role| Participant {
                    user_id,
                    role,
                    access: self.access_of(workspace, user_id),
                })
            })
            .collect()
    }

    /// Cambia el acceso de un participante. Solo el dueño puede hacerlo, en
    /// cualquier momento mientras la sesión está activa. Devuelve el nivel resultante.
    pub fn set_access(
        &mut self,
        workspace: &Workspace,
        actor: UserId,
        target: UserId,
        level: AccessLevel,
    ) -> Result<AccessLevel, DomainError> {
        self.ensure_belongs_to(workspace)?;
        workspace.ensure_owner(actor)?;
        match self.role_of(workspace, target) {
            Some(ParticipantRole::Owner) => Err(DomainError::CannotChangeOwnerAccess),
            Some(ParticipantRole::Member) => {
                self.member_overrides.insert(target, level);
                Ok(level)
            }
            Some(ParticipantRole::Guest) => {
                let guest = self
                    .guests
                    .iter_mut()
                    .find(|g| g.user_id == target)
                    .ok_or(DomainError::NotAParticipant(target))?;
                guest.access = level;
                Ok(level)
            }
            None => Err(DomainError::NotAParticipant(target)),
        }
    }

    /// Activa/desactiva Ver. Desactivarlo revoca Escribir y el acceso.
    pub fn set_view(
        &mut self,
        workspace: &Workspace,
        actor: UserId,
        target: UserId,
        enabled: bool,
    ) -> Result<AccessLevel, DomainError> {
        let level = self.access_of(workspace, target).with_view(enabled);
        self.set_access(workspace, actor, target, level)
    }

    /// Activa/desactiva Escribir. Activarlo activa también Ver.
    pub fn set_write(
        &mut self,
        workspace: &Workspace,
        actor: UserId,
        target: UserId,
        enabled: bool,
    ) -> Result<AccessLevel, DomainError> {
        let level = self.access_of(workspace, target).with_write(enabled);
        self.set_access(workspace, actor, target, level)
    }

    pub fn invite_guest(
        &self,
        workspace: &Workspace,
        actor: UserId,
        invitee: UserId,
    ) -> Result<Invitation, DomainError> {
        self.ensure_belongs_to(workspace)?;
        workspace.ensure_owner(actor)?;
        if self.role_of(workspace, invitee).is_some() {
            return Err(DomainError::AlreadyHasAccess(invitee));
        }
        Ok(Invitation {
            id: InvitationId::new(),
            target: InvitationTarget::Session(self.id),
            invitee,
            invited_by: actor,
        })
    }

    /// El invitado entra con Ver, el mínimo para que la sesión esté compartida.
    pub fn accept_invitation(
        &mut self,
        workspace: &Workspace,
        invitation: &Invitation,
    ) -> Result<(), DomainError> {
        self.ensure_belongs_to(workspace)?;
        if invitation.target != InvitationTarget::Session(self.id) {
            return Err(DomainError::InvitationTargetMismatch);
        }
        workspace.ensure_owner(invitation.invited_by)?;
        if self.role_of(workspace, invitation.invitee).is_some() {
            return Err(DomainError::AlreadyHasAccess(invitation.invitee));
        }
        self.guests.push(SessionGuest {
            user_id: invitation.invitee,
            access: AccessLevel::DEFAULT,
        });
        Ok(())
    }

    pub fn add_terminal(
        &mut self,
        workspace: &Workspace,
        actor: UserId,
        profile: AgentProfile,
    ) -> Result<TerminalId, DomainError> {
        self.ensure_belongs_to(workspace)?;
        workspace.ensure_owner(actor)?;
        let id = TerminalId::new();
        self.terminals.push(Terminal { id, profile });
        Ok(id)
    }

    /// Quita una terminal de la sesión. Igual que agregarlas, es del dueño.
    pub fn remove_terminal(
        &mut self,
        workspace: &Workspace,
        actor: UserId,
        id: TerminalId,
    ) -> Result<(), DomainError> {
        self.ensure_belongs_to(workspace)?;
        workspace.ensure_owner(actor)?;
        self.ensure_has_terminal(id)?;
        self.terminals.retain(|t| t.id != id);
        Ok(())
    }

    pub fn ensure_has_terminal(&self, id: TerminalId) -> Result<(), DomainError> {
        self.terminal(id)
            .map(|_| ())
            .ok_or(DomainError::TerminalNotInSession(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        owner: UserId,
        member: UserId,
        workspace: Workspace,
        session: Session,
    }

    fn fixture() -> Fixture {
        let owner = UserId::new();
        let member = UserId::new();
        let mut workspace = Workspace::new(owner, "proyecto");
        workspace.add_member(owner, member).unwrap();
        let session = Session::new(&workspace, owner, "sesión").unwrap();
        Fixture {
            owner,
            member,
            workspace,
            session,
        }
    }

    fn with_guest(f: &mut Fixture) -> UserId {
        let guest = UserId::new();
        let inv = f
            .session
            .invite_guest(&f.workspace, f.owner, guest)
            .unwrap();
        f.session.accept_invitation(&f.workspace, &inv).unwrap();
        guest
    }

    #[test]
    fn only_owner_removes_terminals() {
        let mut f = fixture();
        let profile = AgentProfile::new("shell", "sh").unwrap();
        let terminal = f
            .session
            .add_terminal(&f.workspace, f.owner, profile)
            .unwrap();
        assert_eq!(
            f.session.remove_terminal(&f.workspace, f.member, terminal),
            Err(DomainError::NotOwner)
        );
        f.session
            .remove_terminal(&f.workspace, f.owner, terminal)
            .unwrap();
        assert!(f.session.terminal(terminal).is_none());
        assert_eq!(
            f.session.remove_terminal(&f.workspace, f.owner, terminal),
            Err(DomainError::TerminalNotInSession(terminal))
        );
    }

    #[test]
    fn member_starts_with_view_by_default() {
        let f = fixture();
        assert_eq!(
            f.session.access_of(&f.workspace, f.member),
            AccessLevel::View
        );
        assert!(f.session.can_view(&f.workspace, f.member));
        assert!(!f.session.can_write(&f.workspace, f.member));
    }

    #[test]
    fn member_added_after_session_creation_also_gets_view() {
        let mut f = fixture();
        let late = UserId::new();
        f.workspace.add_member(f.owner, late).unwrap();
        assert_eq!(f.session.access_of(&f.workspace, late), AccessLevel::View);
    }

    #[test]
    fn guest_starts_with_view() {
        let mut f = fixture();
        let guest = with_guest(&mut f);
        assert_eq!(f.session.access_of(&f.workspace, guest), AccessLevel::View);
    }

    #[test]
    fn enabling_write_enables_view() {
        let mut f = fixture();
        f.session
            .set_view(&f.workspace, f.owner, f.member, false)
            .unwrap();
        let level = f
            .session
            .set_write(&f.workspace, f.owner, f.member, true)
            .unwrap();
        assert_eq!(level, AccessLevel::Write);
        assert!(f.session.can_view(&f.workspace, f.member));
        assert!(f.session.can_write(&f.workspace, f.member));
    }

    #[test]
    fn no_participant_can_write_without_view() {
        let mut f = fixture();
        let guest = with_guest(&mut f);
        for user in [f.owner, f.member, guest] {
            for (view, write) in [(true, true), (false, true), (true, false), (false, false)] {
                if user != f.owner {
                    let _ = f.session.set_write(&f.workspace, f.owner, user, write);
                    let _ = f.session.set_view(&f.workspace, f.owner, user, view);
                }
                if f.session.can_write(&f.workspace, user) {
                    assert!(f.session.can_view(&f.workspace, user));
                }
            }
        }
    }

    #[test]
    fn removing_view_revokes_write_and_access() {
        let mut f = fixture();
        f.session
            .set_write(&f.workspace, f.owner, f.member, true)
            .unwrap();
        f.session
            .set_view(&f.workspace, f.owner, f.member, false)
            .unwrap();
        assert_eq!(
            f.session.access_of(&f.workspace, f.member),
            AccessLevel::None
        );
        assert!(!f.session.can_view(&f.workspace, f.member));
        assert!(!f.session.can_write(&f.workspace, f.member));
    }

    #[test]
    fn removing_view_for_guest_revokes_access() {
        let mut f = fixture();
        let guest = with_guest(&mut f);
        f.session
            .set_view(&f.workspace, f.owner, guest, false)
            .unwrap();
        assert!(!f.session.can_view(&f.workspace, guest));
    }

    #[test]
    fn view_override_is_per_session() {
        let mut f = fixture();
        let other = Session::new(&f.workspace, f.owner, "otra").unwrap();
        f.session
            .set_view(&f.workspace, f.owner, f.member, false)
            .unwrap();
        assert!(!f.session.can_view(&f.workspace, f.member));
        assert!(other.can_view(&f.workspace, f.member));
    }

    #[test]
    fn guest_cannot_see_other_sessions_of_the_workspace() {
        let mut f = fixture();
        let guest = with_guest(&mut f);
        let other = Session::new(&f.workspace, f.owner, "otra").unwrap();
        assert!(f.session.can_view(&f.workspace, guest));
        assert!(!other.can_view(&f.workspace, guest));
        assert!(!f.workspace.is_member(guest));
    }

    #[test]
    fn only_owner_can_change_permissions() {
        let mut f = fixture();
        let guest = with_guest(&mut f);
        assert_eq!(
            f.session.set_write(&f.workspace, f.member, guest, true),
            Err(DomainError::NotOwner)
        );
        assert_eq!(
            f.session.set_view(&f.workspace, guest, f.member, false),
            Err(DomainError::NotOwner)
        );
        assert_eq!(f.session.access_of(&f.workspace, guest), AccessLevel::View);
        assert_eq!(
            f.session.access_of(&f.workspace, f.member),
            AccessLevel::View
        );
    }

    #[test]
    fn owner_always_has_full_access() {
        let mut f = fixture();
        assert_eq!(
            f.session.access_of(&f.workspace, f.owner),
            AccessLevel::Write
        );
        assert_eq!(
            f.session.set_view(&f.workspace, f.owner, f.owner, false),
            Err(DomainError::CannotChangeOwnerAccess)
        );
        assert_eq!(
            f.session.access_of(&f.workspace, f.owner),
            AccessLevel::Write
        );
    }

    #[test]
    fn strangers_have_no_access() {
        let f = fixture();
        assert_eq!(
            f.session.access_of(&f.workspace, UserId::new()),
            AccessLevel::None
        );
    }

    #[test]
    fn removed_member_loses_access() {
        let mut f = fixture();
        f.workspace.remove_member(f.owner, f.member).unwrap();
        assert!(!f.session.can_view(&f.workspace, f.member));
    }

    #[test]
    fn cannot_invite_existing_member_as_guest() {
        let f = fixture();
        assert_eq!(
            f.session.invite_guest(&f.workspace, f.owner, f.member),
            Err(DomainError::AlreadyHasAccess(f.member))
        );
    }

    #[test]
    fn wrong_workspace_grants_no_access() {
        let f = fixture();
        let foreign = Workspace::new(f.member, "ajeno");
        assert_eq!(f.session.access_of(&foreign, f.member), AccessLevel::None);
    }

    #[test]
    fn participants_lists_effective_access() {
        let mut f = fixture();
        let guest = with_guest(&mut f);
        let participants = f.session.participants(&f.workspace);
        assert_eq!(participants.len(), 3);
        let find = |u| participants.iter().find(|p| p.user_id == u).unwrap();
        assert_eq!(find(f.owner).role, ParticipantRole::Owner);
        assert_eq!(find(f.member).access, AccessLevel::View);
        assert_eq!(find(guest).role, ParticipantRole::Guest);
    }
}
