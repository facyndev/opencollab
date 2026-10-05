use std::path::{Path, PathBuf};
use std::sync::Arc;

use application::ports::{
    HookInstaller, ProcessInspector, PtyPort, SessionTitleTranslator, WorkspaceRepository,
};
use application::{
    AppError, CloseTerminal, DetectTerminalAgents, HookEndpoint, InspectHookInstallation,
    InstallAgentHooks, LaunchTerminal, ListSubdirectories, ResizeTerminal, SendTerminalInput,
    TrackAgentSessionTitle, UninstallAgentHooks,
};
use domain::{Session, SessionId, UserId, Workspace};
use infrastructure::{
    AntigravityHookInstaller, ClaudeCodeHookInstaller, ClaudeCodeTranslator, CodexHookInstaller,
    CodexTranslator, FsDirectoryBrowser, HookReceiver, InMemoryWorkspaceRepository,
    OpenCodePluginInstaller, OpenCodeTranslator, PortablePtyAdapter, SysinfoProcessInspector,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_session::{
    apply_hook_event, hook_binary_path, RequireHookBinary, TERMINAL_AGENT_SESSION_EVENT,
};

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
    pub agent_sessions: Arc<TrackAgentSessionTitle>,
    pub inspect_hooks: InspectHookInstallation,
    pub install_hooks: InstallAgentHooks,
    pub uninstall_hooks: UninstallAgentHooks,
    /// Se mantiene vivo mientras viva la app; al soltarse libera el puerto.
    _hook_receiver: Option<HookReceiver>,
}

impl AppState {
    /// `app` se necesita para emitir `terminal-agent-session` desde el hilo del
    /// receptor, por eso se arma en `setup`, cuando el handle ya existe.
    pub fn bootstrap(app: &AppHandle) -> Result<Self, AppError> {
        let repo: Arc<dyn WorkspaceRepository> = Arc::new(InMemoryWorkspaceRepository::new());
        let pty: Arc<dyn PtyPort> = Arc::new(PortablePtyAdapter::new());
        let inspector: Arc<dyn ProcessInspector> = Arc::new(SysinfoProcessInspector::new());

        let local_user = UserId::new();
        let workspace = Workspace::new(local_user, "Local");
        let session = Session::new(&workspace, local_user, "Sesión local")?;
        let session_id = session.id();
        repo.save_workspace(workspace)?;
        repo.save_session(session)?;

        let translators: Vec<Arc<dyn SessionTitleTranslator>> = vec![
            Arc::new(ClaudeCodeTranslator),
            Arc::new(OpenCodeTranslator),
            Arc::new(CodexTranslator),
        ];
        let agent_sessions = Arc::new(TrackAgentSessionTitle::new(translators));

        // Si el receptor no arranca, las terminales se lanzan sin endpoint: la
        // app sigue funcionando, solo sin títulos de agentes en vivo.
        let hook_receiver = {
            let (tracker, app) = (agent_sessions.clone(), app.clone());
            HookReceiver::start(move |event| {
                if let Some(payload) = apply_hook_event(&tracker, event) {
                    let _ = app.emit(TERMINAL_AGENT_SESSION_EVENT, payload);
                }
            })
            .map_err(|e| eprintln!("receptor de hooks no disponible: {e}"))
            .ok()
        };
        let mut launch_terminal = LaunchTerminal::new(repo.clone(), pty.clone());
        if let Some(receiver) = &hook_receiver {
            launch_terminal = launch_terminal
                .with_hook_endpoint(HookEndpoint::new(receiver.url(), receiver.token()));
        }

        let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
        let installers = hook_installers(&home, &hook_binary_dir());

        Ok(Self {
            local_user,
            session_id,
            launch_terminal,
            send_input: SendTerminalInput::new(repo.clone(), pty.clone()),
            resize_terminal: ResizeTerminal::new(repo.clone(), pty.clone()),
            close_terminal: CloseTerminal::new(repo.clone(), pty.clone()),
            detect_agents: DetectTerminalAgents::new(repo, pty, inspector),
            list_subdirectories: ListSubdirectories::new(Arc::new(FsDirectoryBrowser::new())),
            agent_sessions,
            inspect_hooks: InspectHookInstallation::new(installers.clone()),
            install_hooks: InstallAgentHooks::new(installers.clone()),
            uninstall_hooks: UninstallAgentHooks::new(installers),
            _hook_receiver: hook_receiver,
        })
    }
}

/// Carpeta del ejecutable de la app: ahí se espera `opencollab-hook`.
fn hook_binary_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

/// Instaladores sobre las configuraciones reales de cada agente (`~/.claude`,
/// `~/.codex`, `~/.config/opencode`). Claude y Codex exigen el binario del hook.
fn hook_installers(home: &Path, bin_dir: &Path) -> Vec<Arc<dyn HookInstaller>> {
    let bin = hook_binary_path(bin_dir);
    let guarded = |inner: Arc<dyn HookInstaller>| -> Arc<dyn HookInstaller> {
        Arc::new(RequireHookBinary::new(inner, bin.clone()))
    };
    vec![
        guarded(Arc::new(ClaudeCodeHookInstaller::new(
            home.join(".claude"),
            &bin,
        ))),
        guarded(Arc::new(CodexHookInstaller::new(home.join(".codex"), &bin))),
        Arc::new(OpenCodePluginInstaller::new(
            home.join(".config").join("opencode"),
        )),
        Arc::new(AntigravityHookInstaller),
    ]
}
