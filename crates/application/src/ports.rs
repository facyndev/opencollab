//! Puertos que la infraestructura implementa. Sincrónicos a propósito: la
//! capa de aplicación no depende de un runtime async.

use std::sync::Arc;

use crate::agent_detection::{KnownAgent, ProcessInfo};
use crate::hooks::HookStatus;
use crate::subagents::SubagentChange;

use domain::{
    AccessLevel, AgentProfile, Session, SessionId, TerminalId, UserId, Workspace, WorkspaceId,
};

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

/// Foto de los procesos del sistema, para detectar qué corre en cada terminal.
pub trait ProcessInspector: Send + Sync {
    fn snapshot(&self) -> Result<Vec<ProcessInfo>, PortError>;
}

/// Traduce el payload crudo de un hook de un agente a cambios de subagentes.
/// El payload llega como texto: interpretarlo (JSON, etc.) es trabajo de la
/// infraestructura.
pub trait SubagentEventTranslator: Send + Sync {
    fn agent(&self) -> KnownAgent;
    fn translate(&self, payload: &str) -> Result<Vec<SubagentChange>, PortError>;
}

/// Instala / quita en la configuración de un agente los hooks o el plugin que
/// reportan sus subagentes. Uno por agente; solo agrega y quita entradas propias.
pub trait HookInstaller: Send + Sync {
    fn agent(&self) -> KnownAgent;
    fn status(&self) -> Result<HookStatus, PortError>;
    /// Idempotente: instalar dos veces no duplica entradas.
    fn install(&self) -> Result<(), PortError>;
    /// Deja la configuración como estaba antes de instalar.
    fn uninstall(&self) -> Result<(), PortError>;
}

pub trait WorkspaceRepository: Send + Sync {
    fn find_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>, PortError>;
    fn save_workspace(&self, workspace: Workspace) -> Result<(), PortError>;
    fn find_session(&self, id: SessionId) -> Result<Option<Session>, PortError>;
    fn save_session(&self, session: Session) -> Result<(), PortError>;
}

/// Salida hacia los demás participantes (vía relay).
pub trait CollabTransport: Send + Sync {
    fn access_changed(
        &self,
        session: SessionId,
        user: UserId,
        access: AccessLevel,
    ) -> Result<(), PortError>;
}
