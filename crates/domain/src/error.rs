use crate::ids::TerminalId;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    #[error("solo el dueño de la sesión puede realizar esta acción")]
    NotOwner,
    #[error("los permisos del dueño no se pueden modificar")]
    CannotChangeOwnerAccess,
    #[error("la terminal {0} no pertenece a la sesión")]
    TerminalNotInSession(TerminalId),
    #[error("el comando del perfil de agente no puede estar vacío")]
    EmptyCommand,
}
