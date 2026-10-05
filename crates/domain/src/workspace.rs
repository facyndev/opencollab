use crate::error::DomainError;
use crate::ids::{InvitationId, UserId, WorkspaceId};
use crate::invitation::{Invitation, InvitationTarget};

/// Miembro fijo del workspace: equipo estable, permanente hasta que el dueño lo quite.
/// Accede a todas las sesiones del workspace con Ver por defecto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMember {
    pub user_id: UserId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    id: WorkspaceId,
    name: String,
    owner: UserId,
    members: Vec<WorkspaceMember>,
}

impl Workspace {
    pub fn new(owner: UserId, name: impl Into<String>) -> Self {
        Self {
            id: WorkspaceId::new(),
            name: name.into(),
            owner,
            members: Vec::new(),
        }
    }

    pub fn id(&self) -> WorkspaceId {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn owner(&self) -> UserId {
        self.owner
    }

    pub fn members(&self) -> &[WorkspaceMember] {
        &self.members
    }

    pub fn is_owner(&self, user: UserId) -> bool {
        self.owner == user
    }

    pub fn is_member(&self, user: UserId) -> bool {
        self.members.iter().any(|m| m.user_id == user)
    }

    pub fn ensure_owner(&self, actor: UserId) -> Result<(), DomainError> {
        if self.is_owner(actor) {
            Ok(())
        } else {
            Err(DomainError::NotOwner)
        }
    }

    pub fn invite_member(&self, actor: UserId, invitee: UserId) -> Result<Invitation, DomainError> {
        self.ensure_owner(actor)?;
        if self.is_owner(invitee) || self.is_member(invitee) {
            return Err(DomainError::AlreadyHasAccess(invitee));
        }
        Ok(Invitation {
            id: InvitationId::new(),
            target: InvitationTarget::Workspace(self.id),
            invitee,
            invited_by: actor,
        })
    }

    pub fn accept_invitation(&mut self, invitation: &Invitation) -> Result<(), DomainError> {
        if invitation.target != InvitationTarget::Workspace(self.id) {
            return Err(DomainError::InvitationTargetMismatch);
        }
        self.add_member(invitation.invited_by, invitation.invitee)
    }

    pub fn add_member(&mut self, actor: UserId, user: UserId) -> Result<(), DomainError> {
        self.ensure_owner(actor)?;
        if self.is_owner(user) || self.is_member(user) {
            return Err(DomainError::AlreadyHasAccess(user));
        }
        self.members.push(WorkspaceMember { user_id: user });
        Ok(())
    }

    pub fn remove_member(&mut self, actor: UserId, user: UserId) -> Result<(), DomainError> {
        self.ensure_owner(actor)?;
        let before = self.members.len();
        self.members.retain(|m| m.user_id != user);
        if self.members.len() == before {
            return Err(DomainError::NotAParticipant(user));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_owner_adds_members() {
        let owner = UserId::new();
        let other = UserId::new();
        let mut ws = Workspace::new(owner, "proyecto");
        assert_eq!(
            ws.add_member(other, UserId::new()),
            Err(DomainError::NotOwner)
        );
        assert!(ws.add_member(owner, other).is_ok());
        assert!(ws.is_member(other));
    }

    #[test]
    fn accepting_workspace_invitation_adds_member() {
        let owner = UserId::new();
        let invitee = UserId::new();
        let mut ws = Workspace::new(owner, "proyecto");
        let inv = ws.invite_member(owner, invitee).unwrap();
        ws.accept_invitation(&inv).unwrap();
        assert!(ws.is_member(invitee));
    }

    #[test]
    fn non_owner_cannot_invite() {
        let owner = UserId::new();
        let member = UserId::new();
        let mut ws = Workspace::new(owner, "proyecto");
        ws.add_member(owner, member).unwrap();
        assert_eq!(
            ws.invite_member(member, UserId::new()),
            Err(DomainError::NotOwner)
        );
    }
}
