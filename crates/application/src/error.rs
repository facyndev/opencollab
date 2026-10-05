use domain::{DomainError, SessionId, TerminalId, UserId, WorkspaceId};

use crate::agent_detection::KnownAgent;
use crate::ports::PortError;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Port(#[from] PortError),
    #[error("workspace {0} no encontrado")]
    WorkspaceNotFound(WorkspaceId),
    #[error("sesión {0} no encontrada")]
    SessionNotFound(SessionId),
    #[error("{user} no tiene permiso de escritura en la terminal {terminal}")]
    WriteNotAllowed { user: UserId, terminal: TerminalId },
    #[error("no hay traductor de eventos de subagentes para {0:?}")]
    NoSubagentTranslator(KnownAgent),
    #[error("no hay instalador de hooks para {0:?}")]
    NoHookInstaller(KnownAgent),
}
