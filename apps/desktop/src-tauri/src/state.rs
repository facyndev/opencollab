use std::sync::Arc;
use std::time::Duration;

use application::ports::{ProcessInspector, PtyPort, RelayProbe, WorkspaceRepository};
use application::{
    ActivityTracker, AgentAdapter, AgentAdapters, AgentStates, AppError, CheckRelay, CloseTerminal,
    DetectTerminalAgents, InspectBranch, LaunchTerminal, ListSubdirectories, ResizeTerminal,
    SendTerminalInput, SessionCollaborators,
};
use domain::{Session, SessionId, UserId, Workspace};
use infrastructure::{
    ClaudeCodeAdapter, FsDirectoryBrowser, FsRepositoryInspector, HookReceiver, HttpRelayProbe,
    InMemoryWorkspaceRepository, OpenCodeAdapter, PortablePtyAdapter, SysinfoProcessInspector,
};

/// Silencio de un PTY a partir del cual se considera inactivo.
const ACTIVITY_IDLE_AFTER: Duration = Duration::from_secs(3);

/// Dependencias cableadas de la app. Mientras no haya cuentas ni persistencia,
/// arranca con un usuario local dueño de un workspace y una sesión.
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
        let repo: Arc<dyn WorkspaceRepository> = Arc::new(InMemoryWorkspaceRepository::new());
        let pty: Arc<dyn PtyPort> = Arc::new(PortablePtyAdapter::new());
        let inspector: Arc<dyn ProcessInspector> = Arc::new(SysinfoProcessInspector::new());

        // Dirección del relay: `RELAY_ADDR` o la de por defecto del protocolo.
        let relay_addr = std::env::var("RELAY_ADDR")
            .unwrap_or_else(|_| protocol::DEFAULT_RELAY_ADDR.to_string());
        let relay_probe: Arc<dyn RelayProbe> = Arc::new(HttpRelayProbe::new(relay_addr));

        let local_user = UserId::new();
        let workspace = Workspace::new(local_user, "Local");
        let session = Session::new(&workspace, local_user, "Sesión local")?;
        let session_id = session.id();
        repo.save_workspace(workspace)?;
        repo.save_session(session)?;

        Ok(Self {
            local_user,
            session_id,
            launch_terminal: LaunchTerminal::new(repo.clone(), pty.clone()),
            send_input: SendTerminalInput::new(repo.clone(), pty.clone()),
            resize_terminal: ResizeTerminal::new(repo.clone(), pty.clone()),
            close_terminal: CloseTerminal::new(repo.clone(), pty.clone()),
            detect_agents: DetectTerminalAgents::new(repo.clone(), pty, inspector),
            list_subdirectories: ListSubdirectories::new(Arc::new(FsDirectoryBrowser::new())),
            inspect_branch: InspectBranch::new(Arc::new(FsRepositoryInspector::new())),
            activity: Arc::new(ActivityTracker::new(ACTIVITY_IDLE_AFTER)),
            agent_states: Arc::new(AgentStates::new()),
            adapters: Arc::new(AgentAdapters::new(agent_adapters())),
            check_relay: CheckRelay::new(relay_probe),
            session_collaborators: SessionCollaborators::new(repo),
        })
    }
}
