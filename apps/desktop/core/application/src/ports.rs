//! Puertos que la infraestructura implementa. Sincrónicos a propósito: la
//! capa de aplicación no depende de un runtime async.

use std::sync::Arc;
use std::time::Duration;

use crate::agent_detection::ProcessInfo;
use crate::git::Branch;
use crate::storage::WorkspaceSnapshot;

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

/// Persiste el snapshot completo de la estructura del escritorio (workspaces,
/// sesiones y perfiles de arranque de las terminales). El modo local lo
/// implementa con un archivo en el directorio de datos y el modo nube con la
/// API REST; ambos quedan detrás del mismo puerto. `None` = no hay nada
/// guardado todavía (primera corrida o arranque limpio).
pub trait SnapshotStore: Send + Sync {
    fn load_snapshot(&self) -> Result<Option<WorkspaceSnapshot>, PortError>;
    fn save_snapshot(&self, snapshot: &WorkspaceSnapshot) -> Result<(), PortError>;
}

/// Token de acceso para la API remota (modo nube). Se consulta por pedido
/// HTTP: si el access ya venció o está por vencer, el proveedor lo refresca
/// antes de devolverlo.
pub trait AccessTokenProvider: Send + Sync {
    /// Token vigente, refrescándolo si la sesión lo pide (igual que hace la web).
    fn access_token(&self) -> Result<String, PortError>;
    /// Token apenas refrescado a la fuerza: la API rechazó el anterior con 401.
    /// Aunque el access parezca vigente, en este caso hay que refrescar sí o sí.
    fn refreshed_access_token(&self) -> Result<String, PortError>;
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Fake del puerto: una lista de tokens donde el corriente es el primero.
    /// `access_token` devuelve el corriente sin tocar la lista (un pedido no
    /// debe refrescar); `refreshed_access_token` descarta el corriente y pasa
    /// al siguiente, como haría un refresh real.
    struct FakeTokens {
        tokens: Mutex<Vec<String>>,
    }

    impl FakeTokens {
        fn new(tokens: &[&str]) -> Self {
            Self {
                tokens: Mutex::new(tokens.iter().map(|t| t.to_string()).collect()),
            }
        }
    }

    impl AccessTokenProvider for FakeTokens {
        fn access_token(&self) -> Result<String, PortError> {
            let tokens = self.tokens.lock().expect("fake");
            tokens
                .first()
                .cloned()
                .ok_or_else(|| PortError::new("sin token: no hay sesión iniciada"))
        }

        fn refreshed_access_token(&self) -> Result<String, PortError> {
            let mut tokens = self.tokens.lock().expect("fake");
            if tokens.is_empty() {
                return Err(PortError::new("sin token: no hay sesión iniciada"));
            }
            if tokens.len() > 1 {
                tokens.remove(0);
            }
            Ok(tokens[0].clone())
        }
    }

    #[test]
    fn cada_pedido_consulta_el_token_vigente() {
        let tokens = FakeTokens::new(&["tok-1", "tok-2"]);
        // Dos pedidos seguidos reciben el mismo token y no lo consumen.
        assert_eq!(tokens.access_token().unwrap(), "tok-1");
        assert_eq!(tokens.access_token().unwrap(), "tok-1");
    }

    #[test]
    fn el_refresh_forzado_avanza_al_token_siguiente() {
        let tokens = FakeTokens::new(&["tok-1", "tok-2"]);
        assert_eq!(tokens.access_token().unwrap(), "tok-1");
        assert_eq!(tokens.refreshed_access_token().unwrap(), "tok-2");
        // Y el nuevo pasa a ser el corriente.
        assert_eq!(tokens.access_token().unwrap(), "tok-2");
        // Un último token se reutiliza: sin sesión a quién refrescar no existe.
        assert_eq!(tokens.refreshed_access_token().unwrap(), "tok-2");
    }

    #[test]
    fn sin_token_todos_los_caminos_fallan_con_port_error() {
        let tokens = FakeTokens::new(&[]);
        assert_eq!(
            tokens.access_token(),
            Err(PortError::new("sin token: no hay sesión iniciada"))
        );
        assert_eq!(
            tokens.refreshed_access_token(),
            Err(PortError::new("sin token: no hay sesión iniciada"))
        );
    }

    /// Helper que compila solo si el puerto es un trait-objeto `Send + Sync`:
    /// el modo nube lo inyecta por `Arc<dyn AccessTokenProvider`.
    #[allow(dead_code)]
    fn port_is_shared_by_reference(provider: Arc<dyn AccessTokenProvider>) -> String {
        provider.access_token().unwrap()
    }

    #[test]
    fn el_puerto_se_comparte_como_trait_objeto() {
        let provider: Arc<dyn AccessTokenProvider> = Arc::new(FakeTokens::new(&["tok"]));
        assert_eq!(port_is_shared_by_reference(provider), "tok");
    }
}
