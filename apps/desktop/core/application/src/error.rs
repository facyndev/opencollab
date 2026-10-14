use domain::{DomainError, SessionId, TerminalId, UserId};

use crate::ports::PortError;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Port(#[from] PortError),
    #[error("sesión {0} no encontrada")]
    SessionNotFound(SessionId),
    #[error("{user} no tiene permiso de escritura en la terminal {terminal}")]
    WriteNotAllowed { user: UserId, terminal: TerminalId },
}
