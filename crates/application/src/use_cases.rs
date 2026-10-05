use std::sync::Arc;

use domain::{AccessLevel, AgentProfile, Session, SessionId, TerminalId, UserId, Workspace};

use crate::agent_detection::{detect_agents, AgentTree};
use crate::agent_session::HookEndpoint;
use crate::error::AppError;
use crate::ports::{
    CollabTransport, DirectoryBrowser, ProcessInspector, PtyPort, TerminalOutputSink, TerminalSize,
    WorkspaceRepository,
};

fn load(
    repo: &dyn WorkspaceRepository,
    session_id: SessionId,
) -> Result<(Workspace, Session), AppError> {
    let session = repo
        .find_session(session_id)?
        .ok_or(AppError::SessionNotFound(session_id))?;
    let workspace = repo
        .find_workspace(session.workspace_id())?
        .ok_or(AppError::WorkspaceNotFound(session.workspace_id()))?;
    Ok((workspace, session))
}

/// Agrega una terminal a la sesión y lanza su PTY.
pub struct LaunchTerminal {
    repo: Arc<dyn WorkspaceRepository>,
    pty: Arc<dyn PtyPort>,
    hook_endpoint: Option<HookEndpoint>,
}

impl LaunchTerminal {
    pub fn new(repo: Arc<dyn WorkspaceRepository>, pty: Arc<dyn PtyPort>) -> Self {
        Self {
            repo,
            pty,
            hook_endpoint: None,
        }
    }

    /// Cada terminal lanzada recibe en su entorno el endpoint de los hooks y su
    /// propio id, para que los eventos de los agentes vuelvan atados a ella.
    pub fn with_hook_endpoint(mut self, endpoint: HookEndpoint) -> Self {
        self.hook_endpoint = Some(endpoint);
        self
    }

    pub fn execute(
        &self,
        actor: UserId,
        session_id: SessionId,
        profile: AgentProfile,
        size: TerminalSize,
        sink: Arc<dyn TerminalOutputSink>,
    ) -> Result<TerminalId, AppError> {
        let (workspace, mut session) = load(self.repo.as_ref(), session_id)?;
        let terminal = session.add_terminal(&workspace, actor, profile.clone())?;
        let profile = match &self.hook_endpoint {
            Some(endpoint) => profile
                .with_env(HookEndpoint::ENV_TERMINAL_ID, terminal.to_string())
                .with_env(HookEndpoint::ENV_URL, endpoint.url.clone())
                .with_env(HookEndpoint::ENV_TOKEN, endpoint.token.clone()),
            None => profile,
        };
        self.pty.spawn(terminal, &profile, size, sink)?;
        self.repo.save_session(session)?;
        Ok(terminal)
    }
}

/// Escribe input en una terminal. Es el único camino de entrada al PTY, tanto
/// local como remoto: valida contra el permiso vigente en cada llamada.
pub struct SendTerminalInput {
    repo: Arc<dyn WorkspaceRepository>,
    pty: Arc<dyn PtyPort>,
}

impl SendTerminalInput {
    pub fn new(repo: Arc<dyn WorkspaceRepository>, pty: Arc<dyn PtyPort>) -> Self {
        Self { repo, pty }
    }

    pub fn execute(
        &self,
        actor: UserId,
        session_id: SessionId,
        terminal: TerminalId,
        data: &[u8],
    ) -> Result<(), AppError> {
        ensure_can_write(self.repo.as_ref(), actor, session_id, terminal)?;
        self.pty.write(terminal, data)?;
        Ok(())
    }
}

pub struct ResizeTerminal {
    repo: Arc<dyn WorkspaceRepository>,
    pty: Arc<dyn PtyPort>,
}

impl ResizeTerminal {
    pub fn new(repo: Arc<dyn WorkspaceRepository>, pty: Arc<dyn PtyPort>) -> Self {
        Self { repo, pty }
    }

    pub fn execute(
        &self,
        actor: UserId,
        session_id: SessionId,
        terminal: TerminalId,
        size: TerminalSize,
    ) -> Result<(), AppError> {
        ensure_can_write(self.repo.as_ref(), actor, session_id, terminal)?;
        self.pty.resize(terminal, size)?;
        Ok(())
    }
}

/// Quita una terminal de la sesión y termina su proceso.
pub struct CloseTerminal {
    repo: Arc<dyn WorkspaceRepository>,
    pty: Arc<dyn PtyPort>,
}

impl CloseTerminal {
    pub fn new(repo: Arc<dyn WorkspaceRepository>, pty: Arc<dyn PtyPort>) -> Self {
        Self { repo, pty }
    }

    pub fn execute(
        &self,
        actor: UserId,
        session_id: SessionId,
        terminal: TerminalId,
    ) -> Result<(), AppError> {
        let (workspace, mut session) = load(self.repo.as_ref(), session_id)?;
        session.remove_terminal(&workspace, actor, terminal)?;
        self.pty.kill(terminal)?;
        self.repo.save_session(session)?;
        Ok(())
    }
}

/// Subcarpetas de un directorio, para "ir hacia adelante" desde la ruta de una
/// terminal. Ordenadas como un explorador: alfabético sin distinguir mayúsculas,
/// con las ocultas (`.git`, `.cache`…) al final.
pub struct ListSubdirectories {
    browser: Arc<dyn DirectoryBrowser>,
}

impl ListSubdirectories {
    /// Tope para no mandar miles de entradas a la UI (p. ej. `node_modules`).
    pub const LIMIT: usize = 500;

    pub fn new(browser: Arc<dyn DirectoryBrowser>) -> Self {
        Self { browser }
    }

    pub fn execute(&self, path: &std::path::Path) -> Result<Vec<String>, AppError> {
        let mut names = self.browser.subdirectories(path)?;
        names.sort_by_key(|name| (name.starts_with('.'), name.to_lowercase()));
        names.truncate(Self::LIMIT);
        Ok(names)
    }
}

/// Qué agentes conocidos corren en cada terminal viva de la sesión: el principal
/// de cada una y los que ese agente tiene anidados.
pub struct DetectTerminalAgents {
    repo: Arc<dyn WorkspaceRepository>,
    pty: Arc<dyn PtyPort>,
    inspector: Arc<dyn ProcessInspector>,
}

impl DetectTerminalAgents {
    pub fn new(
        repo: Arc<dyn WorkspaceRepository>,
        pty: Arc<dyn PtyPort>,
        inspector: Arc<dyn ProcessInspector>,
    ) -> Self {
        Self {
            repo,
            pty,
            inspector,
        }
    }

    pub fn execute(&self, session_id: SessionId) -> Result<Vec<(TerminalId, AgentTree)>, AppError> {
        let session = self
            .repo
            .find_session(session_id)?
            .ok_or(AppError::SessionNotFound(session_id))?;
        let live: Vec<(TerminalId, u32)> = session
            .terminals()
            .iter()
            .filter_map(|t| self.pty.process_id(t.id).map(|pid| (t.id, pid)))
            .collect();
        if live.is_empty() {
            return Ok(Vec::new());
        }
        // Una sola foto del sistema para todas las terminales.
        let processes = self.inspector.snapshot()?;
        Ok(live
            .into_iter()
            .map(|(terminal, pid)| (terminal, detect_agents(&processes, pid)))
            .collect())
    }
}

fn ensure_can_write(
    repo: &dyn WorkspaceRepository,
    actor: UserId,
    session_id: SessionId,
    terminal: TerminalId,
) -> Result<(), AppError> {
    let (workspace, session) = load(repo, session_id)?;
    session.ensure_has_terminal(terminal)?;
    if !session.can_write(&workspace, actor) {
        return Err(AppError::WriteNotAllowed {
            user: actor,
            terminal,
        });
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessChange {
    SetView(bool),
    SetWrite(bool),
}

/// El dueño cambia el acceso de un participante en vivo y se notifica a los demás.
pub struct ChangeParticipantAccess {
    repo: Arc<dyn WorkspaceRepository>,
    transport: Arc<dyn CollabTransport>,
}

impl ChangeParticipantAccess {
    pub fn new(repo: Arc<dyn WorkspaceRepository>, transport: Arc<dyn CollabTransport>) -> Self {
        Self { repo, transport }
    }

    pub fn execute(
        &self,
        actor: UserId,
        session_id: SessionId,
        target: UserId,
        change: AccessChange,
    ) -> Result<AccessLevel, AppError> {
        let (workspace, mut session) = load(self.repo.as_ref(), session_id)?;
        let level = match change {
            AccessChange::SetView(enabled) => {
                session.set_view(&workspace, actor, target, enabled)?
            }
            AccessChange::SetWrite(enabled) => {
                session.set_write(&workspace, actor, target, enabled)?
            }
        };
        self.repo.save_session(session)?;
        self.transport.access_changed(session_id, target, level)?;
        Ok(level)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use domain::{DomainError, WorkspaceId};

    use super::*;
    use crate::agent_detection::KnownAgent;
    use crate::ports::PortError;

    #[derive(Default)]
    struct FakeRepo {
        workspaces: Mutex<HashMap<WorkspaceId, Workspace>>,
        sessions: Mutex<HashMap<SessionId, Session>>,
    }

    impl WorkspaceRepository for FakeRepo {
        fn find_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>, PortError> {
            Ok(self.workspaces.lock().unwrap().get(&id).cloned())
        }
        fn save_workspace(&self, workspace: Workspace) -> Result<(), PortError> {
            self.workspaces
                .lock()
                .unwrap()
                .insert(workspace.id(), workspace);
            Ok(())
        }
        fn find_session(&self, id: SessionId) -> Result<Option<Session>, PortError> {
            Ok(self.sessions.lock().unwrap().get(&id).cloned())
        }
        fn save_session(&self, session: Session) -> Result<(), PortError> {
            self.sessions.lock().unwrap().insert(session.id(), session);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakePty {
        spawned: Mutex<Vec<TerminalId>>,
        profiles: Mutex<Vec<AgentProfile>>,
        written: Mutex<Vec<(TerminalId, Vec<u8>)>>,
        killed: Mutex<Vec<TerminalId>>,
    }

    impl PtyPort for FakePty {
        fn spawn(
            &self,
            terminal: TerminalId,
            profile: &AgentProfile,
            _size: TerminalSize,
            _sink: Arc<dyn TerminalOutputSink>,
        ) -> Result<(), PortError> {
            self.spawned.lock().unwrap().push(terminal);
            self.profiles.lock().unwrap().push(profile.clone());
            Ok(())
        }
        fn write(&self, terminal: TerminalId, data: &[u8]) -> Result<(), PortError> {
            self.written.lock().unwrap().push((terminal, data.to_vec()));
            Ok(())
        }
        fn resize(&self, _terminal: TerminalId, _size: TerminalSize) -> Result<(), PortError> {
            Ok(())
        }
        fn kill(&self, terminal: TerminalId) -> Result<(), PortError> {
            self.killed.lock().unwrap().push(terminal);
            Ok(())
        }
        fn process_id(&self, terminal: TerminalId) -> Option<u32> {
            // Pid ficticio y estable por terminal: su posición entre las lanzadas.
            let spawned = self.spawned.lock().unwrap();
            let killed = self.killed.lock().unwrap();
            let index = spawned.iter().position(|t| *t == terminal)?;
            (!killed.contains(&terminal)).then_some(1000 + index as u32)
        }
    }

    struct FakeInspector(Vec<crate::agent_detection::ProcessInfo>);

    impl ProcessInspector for FakeInspector {
        fn snapshot(&self) -> Result<Vec<crate::agent_detection::ProcessInfo>, PortError> {
            Ok(self.0.clone())
        }
    }

    #[derive(Default)]
    struct FakeTransport {
        events: Mutex<Vec<(SessionId, UserId, AccessLevel)>>,
    }

    impl CollabTransport for FakeTransport {
        fn access_changed(
            &self,
            session: SessionId,
            user: UserId,
            access: AccessLevel,
        ) -> Result<(), PortError> {
            self.events.lock().unwrap().push((session, user, access));
            Ok(())
        }
    }

    struct NullSink;
    impl TerminalOutputSink for NullSink {
        fn output(&self, _terminal: TerminalId, _data: &[u8]) {}
        fn exited(&self, _terminal: TerminalId) {}
    }

    struct World {
        owner: UserId,
        member: UserId,
        session_id: SessionId,
        terminal: TerminalId,
        repo: Arc<FakeRepo>,
        pty: Arc<FakePty>,
        transport: Arc<FakeTransport>,
    }

    fn world() -> World {
        let owner = UserId::new();
        let member = UserId::new();
        let mut workspace = Workspace::new(owner, "proyecto");
        workspace.add_member(owner, member).unwrap();
        let session = Session::new(&workspace, owner, "sesión").unwrap();
        let session_id = session.id();

        let repo = Arc::new(FakeRepo::default());
        repo.save_workspace(workspace).unwrap();
        repo.save_session(session).unwrap();
        let pty = Arc::new(FakePty::default());
        let transport = Arc::new(FakeTransport::default());

        let terminal = LaunchTerminal::new(repo.clone(), pty.clone())
            .execute(
                owner,
                session_id,
                AgentProfile::new("shell", "sh").unwrap(),
                TerminalSize::default(),
                Arc::new(NullSink),
            )
            .unwrap();

        World {
            owner,
            member,
            session_id,
            terminal,
            repo,
            pty,
            transport,
        }
    }

    #[test]
    fn launch_terminal_spawns_and_persists() {
        let w = world();
        assert_eq!(*w.pty.spawned.lock().unwrap(), vec![w.terminal]);
        let session = w.repo.find_session(w.session_id).unwrap().unwrap();
        assert!(session.terminal(w.terminal).is_some());
    }

    fn launch_with(w: &World, launcher: LaunchTerminal) -> (TerminalId, AgentProfile) {
        let terminal = launcher
            .execute(
                w.owner,
                w.session_id,
                AgentProfile::new("shell", "sh")
                    .unwrap()
                    .with_env("PROPIA", "1"),
                TerminalSize::default(),
                Arc::new(NullSink),
            )
            .unwrap();
        let profile = w.pty.profiles.lock().unwrap().last().unwrap().clone();
        (terminal, profile)
    }

    #[test]
    fn launch_injects_hook_env_with_the_terminal_id() {
        let w = world();
        let launcher = LaunchTerminal::new(w.repo.clone(), w.pty.clone())
            .with_hook_endpoint(HookEndpoint::new("http://127.0.0.1:9/hook", "secreto"));
        let (terminal, profile) = launch_with(&w, launcher);
        let get = |key: &str| {
            profile
                .env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("OPENCOLLAB_TERMINAL_ID"), Some(terminal.to_string()));
        assert_eq!(
            get("OPENCOLLAB_HOOK_URL").as_deref(),
            Some("http://127.0.0.1:9/hook")
        );
        assert_eq!(get("OPENCOLLAB_HOOK_TOKEN").as_deref(), Some("secreto"));
        // Respeta el entorno que ya traía el perfil.
        assert_eq!(get("PROPIA").as_deref(), Some("1"));
    }

    #[test]
    fn launch_without_hook_endpoint_adds_no_env() {
        let w = world();
        let launcher = LaunchTerminal::new(w.repo.clone(), w.pty.clone());
        let (_, profile) = launch_with(&w, launcher);
        assert_eq!(profile.env, vec![("PROPIA".to_string(), "1".to_string())]);
    }

    struct FakeBrowser(Vec<&'static str>);

    impl DirectoryBrowser for FakeBrowser {
        fn subdirectories(&self, _path: &std::path::Path) -> Result<Vec<String>, PortError> {
            Ok(self.0.iter().map(|s| s.to_string()).collect())
        }
    }

    #[test]
    fn subdirectories_are_sorted_like_an_explorer() {
        let list = ListSubdirectories::new(Arc::new(FakeBrowser(vec![
            ".git", "src", "Docs", "apps", ".cache", "crates",
        ])))
        .execute(std::path::Path::new("x"))
        .unwrap();
        assert_eq!(list, ["apps", "crates", "Docs", "src", ".cache", ".git"]);
    }

    #[test]
    fn detects_the_agent_running_in_each_terminal() {
        let w = world();
        let second = LaunchTerminal::new(w.repo.clone(), w.pty.clone())
            .execute(
                w.owner,
                w.session_id,
                AgentProfile::new("shell", "sh").unwrap(),
                TerminalSize::default(),
                Arc::new(NullSink),
            )
            .unwrap();
        // La primera terminal (pid 1000) corre Claude Code; la segunda (1001) nada.
        let inspector = Arc::new(FakeInspector(vec![crate::agent_detection::ProcessInfo {
            pid: 2000,
            parent: Some(1000),
            name: "claude.exe".into(),
            args: vec![],
            started_at: Some(1_700_000_000),
        }]));

        let detected = DetectTerminalAgents::new(w.repo.clone(), w.pty.clone(), inspector)
            .execute(w.session_id)
            .unwrap();

        assert_eq!(
            detected,
            vec![
                (
                    w.terminal,
                    AgentTree {
                        primary: Some(KnownAgent::ClaudeCode),
                        primary_started_at: Some(1_700_000_000),
                        nested: vec![],
                    }
                ),
                (second, AgentTree::default()),
            ]
        );
    }

    #[test]
    fn reports_the_agents_nested_below_the_main_one() {
        let w = world();
        // Claude Code (2000) con Codex (2001) debajo, ambos en la primera terminal.
        let inspector = Arc::new(FakeInspector(vec![
            crate::agent_detection::ProcessInfo {
                pid: 2000,
                parent: Some(1000),
                name: "claude.exe".into(),
                args: vec![],
                started_at: None,
            },
            crate::agent_detection::ProcessInfo {
                pid: 2001,
                parent: Some(2000),
                name: "codex.exe".into(),
                args: vec![],
                started_at: None,
            },
        ]));

        let detected = DetectTerminalAgents::new(w.repo.clone(), w.pty.clone(), inspector)
            .execute(w.session_id)
            .unwrap();

        assert_eq!(
            detected,
            vec![(
                w.terminal,
                AgentTree {
                    primary: Some(KnownAgent::ClaudeCode),
                    primary_started_at: None,
                    nested: vec![KnownAgent::Codex],
                }
            )]
        );
    }

    #[test]
    fn closed_terminals_are_not_inspected() {
        let w = world();
        CloseTerminal::new(w.repo.clone(), w.pty.clone())
            .execute(w.owner, w.session_id, w.terminal)
            .unwrap();
        let detected = DetectTerminalAgents::new(
            w.repo.clone(),
            w.pty.clone(),
            Arc::new(FakeInspector(vec![])),
        )
        .execute(w.session_id)
        .unwrap();
        assert!(detected.is_empty());
    }

    #[test]
    fn close_terminal_kills_and_removes_it() {
        let w = world();
        let close = CloseTerminal::new(w.repo.clone(), w.pty.clone());

        assert!(close.execute(w.member, w.session_id, w.terminal).is_err());
        assert!(w.pty.killed.lock().unwrap().is_empty());

        close.execute(w.owner, w.session_id, w.terminal).unwrap();
        assert_eq!(*w.pty.killed.lock().unwrap(), vec![w.terminal]);
        let session = w.repo.find_session(w.session_id).unwrap().unwrap();
        assert!(session.terminal(w.terminal).is_none());
    }

    #[test]
    fn member_with_default_view_cannot_write() {
        let w = world();
        let input = SendTerminalInput::new(w.repo.clone(), w.pty.clone());
        let result = input.execute(w.member, w.session_id, w.terminal, b"ls\r");
        assert!(matches!(result, Err(AppError::WriteNotAllowed { .. })));
        assert!(w.pty.written.lock().unwrap().is_empty());
    }

    #[test]
    fn permission_change_applies_to_next_input() {
        let w = world();
        let change = ChangeParticipantAccess::new(w.repo.clone(), w.transport.clone());
        let input = SendTerminalInput::new(w.repo.clone(), w.pty.clone());

        change
            .execute(
                w.owner,
                w.session_id,
                w.member,
                AccessChange::SetWrite(true),
            )
            .unwrap();
        input
            .execute(w.member, w.session_id, w.terminal, b"a")
            .unwrap();

        change
            .execute(
                w.owner,
                w.session_id,
                w.member,
                AccessChange::SetWrite(false),
            )
            .unwrap();
        assert!(input
            .execute(w.member, w.session_id, w.terminal, b"b")
            .is_err());

        assert_eq!(w.pty.written.lock().unwrap().len(), 1);
    }

    #[test]
    fn permission_change_is_broadcast() {
        let w = world();
        let change = ChangeParticipantAccess::new(w.repo.clone(), w.transport.clone());
        let level = change
            .execute(
                w.owner,
                w.session_id,
                w.member,
                AccessChange::SetView(false),
            )
            .unwrap();
        assert_eq!(level, AccessLevel::None);
        assert_eq!(
            *w.transport.events.lock().unwrap(),
            vec![(w.session_id, w.member, AccessLevel::None)]
        );
    }

    #[test]
    fn non_owner_cannot_change_permissions_and_nothing_is_broadcast() {
        let w = world();
        let change = ChangeParticipantAccess::new(w.repo.clone(), w.transport.clone());
        let result = change.execute(
            w.member,
            w.session_id,
            w.member,
            AccessChange::SetWrite(true),
        );
        assert_eq!(result, Err(AppError::Domain(DomainError::NotOwner)));
        assert!(w.transport.events.lock().unwrap().is_empty());
    }

    #[test]
    fn owner_can_always_write() {
        let w = world();
        SendTerminalInput::new(w.repo.clone(), w.pty.clone())
            .execute(w.owner, w.session_id, w.terminal, b"x")
            .unwrap();
    }

    #[test]
    fn input_to_unknown_terminal_is_rejected() {
        let w = world();
        let result = SendTerminalInput::new(w.repo.clone(), w.pty.clone()).execute(
            w.owner,
            w.session_id,
            TerminalId::new(),
            b"x",
        );
        assert!(matches!(
            result,
            Err(AppError::Domain(DomainError::TerminalNotInSession(_)))
        ));
    }
}
