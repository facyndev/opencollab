//! Puertos que la infraestructura implementa. Sincrónicos a propósito: la
//! capa de aplicación no depende de un runtime async.

use std::sync::Arc;
use std::time::Duration;

use crate::agent_detection::ProcessInfo;
use crate::git::Branch;

use domain::{AgentProfile, Session, SessionId, TerminalId};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PortError(pub String);

impl PortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

/// Recibe la salida de los PTY. El adaptador de entrada (Tauri, relay) la
/// reenvía a quien corresponda.
pub trait TerminalOutputSink: Send + Sync {
    fn output(&self, terminal: TerminalId, data: &[u8]);
    fn exited(&self, terminal: TerminalId);
}

pub trait PtyPort: Send + Sync {
    fn spawn(
        &self,
        terminal: TerminalId,
        profile: &AgentProfile,
        size: TerminalSize,
        sink: Arc<dyn TerminalOutputSink>,
    ) -> Result<(), PortError>;
    fn write(&self, terminal: TerminalId, data: &[u8]) -> Result<(), PortError>;
    fn resize(&self, terminal: TerminalId, size: TerminalSize) -> Result<(), PortError>;
    /// Termina el proceso. Si ya había terminado, no es un error.
    fn kill(&self, terminal: TerminalId) -> Result<(), PortError>;
    /// Pid del proceso raíz de la terminal, si sigue vivo.
    fn process_id(&self, terminal: TerminalId) -> Option<u32>;
}

/// Lectura de carpetas del disco local, para navegar desde el header de una terminal.
pub trait DirectoryBrowser: Send + Sync {
    /// Nombres de las subcarpetas directas de `path` (sin orden garantizado).
    fn subdirectories(&self, path: &std::path::Path) -> Result<Vec<String>, PortError>;
}

/// Lee el estado de git de una carpeta del disco local.
pub trait RepositoryInspector: Send + Sync {
    /// Rama (o commit, si `HEAD` está desacoplado) de la carpeta, buscando hacia
    /// arriba el repositorio que la contiene. `None` fuera de un repositorio.
    fn current_branch(&self, path: &std::path::Path) -> Option<Branch>;
}

/// Foto de los procesos del sistema, para detectar qué corre en cada terminal.
pub trait ProcessInspector: Send + Sync {
    fn snapshot(&self) -> Result<Vec<ProcessInfo>, PortError>;
}

/// Sondea al relay de colaboración. Bloquea hasta responder o agotar su timeout,
/// así que quien lo llame periódicamente debe hacerlo fuera del hilo de la UI.
pub trait RelayProbe: Send + Sync {
    /// Tiempo de ida y vuelta si el relay respondió bien; error si no.
    fn probe(&self) -> Result<Duration, PortError>;
}

/// Guarda la sesión local del host, incluido el nivel de acceso vigente que mandó el server.
pub trait SessionRepository: Send + Sync {
    fn find_session(&self, id: SessionId) -> Result<Option<Session>, PortError>;
    fn save_session(&self, session: Session) -> Result<(), PortError>;
}
