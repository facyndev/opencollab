use std::sync::Arc;
use std::time::Duration;

use application::ports::{ProcessInspector, PtyPort, RelayProbe, SessionRepository};
use application::{
    ActivityTracker, AgentAdapter, AgentAdapters, AgentStates, AppError, CheckRelay, CloseTerminal,
    DetectTerminalAgents, InspectBranch, LaunchTerminal, ListSubdirectories, ResizeTerminal,
    SendTerminalInput, SessionCollaborators,
};
use domain::{Session, SessionId, UserId};
use infrastructure::{
    ClaudeCodeAdapter, FsDirectoryBrowser, FsRepositoryInspector, HookReceiver, HttpRelayProbe,
    InMemorySessionRepository, OpenCodeAdapter, PortablePtyAdapter, SysinfoProcessInspector,
};

use crate::auth::AuthStore;
/// Silencio de un PTY a partir del cual se considera inactivo.
const ACTIVITY_IDLE_AFTER: Duration = Duration::from_secs(3);

/// Dependencias cableadas de la app. Mientras no haya cuentas ni persistencia,
/// arranca con un usuario local dueño de una sesión.
pub struct AppState {
    pub local_user: UserId,
    pub session_id: SessionId,
    pub launch_terminal: LaunchTerminal,
    pub send_input: SendTerminalInput,
    pub resize_terminal: ResizeTerminal,
    pub close_terminal: CloseTerminal,
    pub detect_agents: DetectTerminalAgents,
    pub list_subdirectories: ListSubdirectories,
    pub inspect_branch: InspectBranch,
    /// Actividad de cada terminal, inferida de su salida (ver `agent_watcher`).
    pub activity: Arc<ActivityTracker>,
    /// Último estado reducido de cada terminal con agente (ver `agent_events`).
    pub agent_states: Arc<AgentStates>,
    /// Adaptadores de agentes registrados; los demás agentes usan el camino genérico.
    /// Sumar uno (Claude Code, OpenCode...) es registrarlo acá.
    pub adapters: Arc<AgentAdapters>,
    pub check_relay: CheckRelay,
    pub session_collaborators: SessionCollaborators,
    /// Sesión del desktop (tokens solo en memoria) + verifier PKCE pendiente.
    pub auth: AuthStore,
}

/// Adaptadores ricos disponibles. Si uno no puede arrancar (p. ej. no abre su
/// puerto local) se omite: ese agente cae al camino genérico.
fn agent_adapters() -> Vec<Arc<dyn AgentAdapter>> {
    let mut adapters: Vec<Arc<dyn AgentAdapter>> = Vec::new();
    match HookReceiver::start() {
        Ok(receiver) => adapters.push(Arc::new(ClaudeCodeAdapter::new(receiver))),
        Err(e) => eprintln!("adaptador de Claude Code deshabilitado: {e}"),
    }
    adapters.push(Arc::new(OpenCodeAdapter::new()));
    adapters
}

impl AppState {
    pub fn bootstrap() -> Result<Self, AppError> {
        let repo: Arc<dyn SessionRepository> = Arc::new(InMemorySessionRepository::new());
        let pty: Arc<dyn PtyPort> = Arc::new(PortablePtyAdapter::new());
        let inspector: Arc<dyn ProcessInspector> = Arc::new(SysinfoProcessInspector::new());

        // Dirección del relay: `RELAY_ADDR` o la de por defecto del protocolo.
        let relay_addr = std::env::var("RELAY_ADDR")
            .unwrap_or_else(|_| protocol::DEFAULT_RELAY_ADDR.to_string());
        let relay_probe: Arc<dyn RelayProbe> = Arc::new(HttpRelayProbe::new(relay_addr.clone()));

        let local_user = UserId::new();
        let session = Session::new(local_user, "Sesión local");
        let session_id = session.id();
        repo.save_session(session)?;

        Ok(Self {
            local_user,
            session_id,
            launch_terminal: LaunchTerminal::new(repo.clone(), pty.clone()),
            send_input: SendTerminalInput::new(repo.clone(), pty.clone()),
            resize_terminal: ResizeTerminal::new(repo.clone(), pty.clone()),
            close_terminal: CloseTerminal::new(repo.clone(), pty.clone()),
            detect_agents: DetectTerminalAgents::new(repo.clone(), pty, inspector)
                .stopping_at(own_executable_name().into_iter().collect()),
            list_subdirectories: ListSubdirectories::new(Arc::new(FsDirectoryBrowser::new())),
            inspect_branch: InspectBranch::new(Arc::new(FsRepositoryInspector::new())),
            activity: Arc::new(ActivityTracker::new(ACTIVITY_IDLE_AFTER)),
            agent_states: Arc::new(AgentStates::new()),
            adapters: Arc::new(AgentAdapters::new(agent_adapters())),
            check_relay: CheckRelay::new(relay_probe),
            session_collaborators: SessionCollaborators::new(repo),
            auth: AuthStore::new(relay_addr),
        })
    }
}

/// Nombre del ejecutable de esta app: la detección de agentes no baja por otra
/// instancia suya (por ejemplo, una build de desarrollo que corre un agente).
fn own_executable_name() -> Option<String> {
    std::env::current_exe()
        .ok()?
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}
