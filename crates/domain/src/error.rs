use crate::ids::{SessionId, TerminalId, UserId, WorkspaceId};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    #[error("solo el dueño del workspace puede realizar esta acción")]
    NotOwner,
    #[error("los permisos del dueño no se pueden modificar")]
    CannotChangeOwnerAccess,
    #[error("{0} no participa de la sesión")]
    NotAParticipant(UserId),
    #[error("{0} ya tiene acceso")]
    AlreadyHasAccess(UserId),
    #[error("la sesión {session} no pertenece al workspace {workspace}")]
    WorkspaceMismatch {
        session: SessionId,
        workspace: WorkspaceId,
    },
    #[error("la invitación no corresponde a este destino")]
    InvitationTargetMismatch,
    #[error("la terminal {0} no pertenece a la sesión")]
    TerminalNotInSession(TerminalId),
    #[error("el comando del perfil de agente no puede estar vacío")]
    EmptyCommand,
}
