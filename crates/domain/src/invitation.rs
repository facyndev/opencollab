use crate::ids::{InvitationId, SessionId, UserId, WorkspaceId};

/// A qué da acceso una invitación. Las dos formas de colaborar son distintas:
/// miembro fijo del workspace o invitado temporal de una sola sesión.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationTarget {
    Workspace(WorkspaceId),
    Session(SessionId),
}

/// Se crea con `Workspace::invite_member` o `Session::invite_guest`, que
/// validan que quien invita sea el dueño.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub id: InvitationId,
    pub target: InvitationTarget,
    pub invitee: UserId,
    pub invited_by: UserId,
}
