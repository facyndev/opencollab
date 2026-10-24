use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use application::ports::{
    AccessTokenProvider, PortError, ProcessInspector, PtyPort, RelayProbe, SessionRepository,
    SnapshotStore,
};
use application::storage::WorkspaceSnapshot;
use application::{
    ActivityTracker, AgentAdapter, AgentAdapters, AgentStates, AppError, CheckRelay, CloseTerminal,
    DetectTerminalAgents, InspectBranch, LaunchTerminal, ListSubdirectories, ResizeTerminal,
    SendTerminalInput, SessionCollaborators,
};
use domain::{Session, SessionId, UserId};
use infrastructure::{
    ClaudeCodeAdapter, CloudSnapshotStore, FsDirectoryBrowser, FsRepositoryInspector,
    FsSnapshotStore, HookReceiver, HttpRelayProbe, InMemorySessionRepository, OpenCodeAdapter,
    PortablePtyAdapter, SysinfoProcessInspector,
};

use crate::auth::AuthStore;
use crate::storage_config::{StorageConfig, StorageMode};
/// Silencio de un PTY a partir del cual se considera inactivo.
const ACTIVITY_IDLE_AFTER: Duration = Duration::from_secs(3);

/// Dependencias cableadas de la app. El usuario local sigue siendo el dueño de
/// la sesión de arranque; la persistencia la elige `storage_config`.
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
    /// Sesión del desktop (`access_token` y verifier PKCE en memoria; `refresh_token` en el llavero del SO).
    pub auth: Arc<AuthStore>,
    /// Persistencia de la estructura del escritorio (snapshot de workspaces,
    /// sesiones y perfiles de arranque). Se reemplaza al cambiar de modo.
    pub snapshot_store: RwLock<Arc<dyn SnapshotStore>>,
    /// Modo y base URL vigentes; se persisten en appdata.
    pub storage_config: RwLock<StorageConfig>,
    data_dir: PathBuf,
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
    /// `data_dir` es el directorio de datos de la app (appdata resuelto por
    /// Tauri en el setup); el port lo implanta en un archivo, no lo crea.
    /// Cuando `is_dev_app` es `true`, el login usa `client=desktop-dev` para
    /// regresar por el esquema aislado `opencollab-dev://`.
    pub fn bootstrap(data_dir: std::path::PathBuf, is_dev_app: bool) -> Result<Self, AppError> {
        crate::env::load_dot_env();
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

        let auth = Arc::new(
            AuthStore::new(relay_addr.clone())
                .with_dev_client(is_dev_app)
                .with_os_keyring(),
        );
        let default_api_base_url = format!("http://{relay_addr}");
        let config = StorageConfig::load(&data_dir, &default_api_base_url);
        let snapshot_store = build_snapshot_store(&config, &data_dir, auth.clone());

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
            auth,
            snapshot_store: RwLock::new(snapshot_store),
            storage_config: RwLock::new(config),
            data_dir,
        })
    }

    /// Store vigente; se clona el `Arc` para no sostener el lock durante I/O.
    pub fn snapshot_store(&self) -> Arc<dyn SnapshotStore> {
        self.snapshot_store.read().expect("snapshot store").clone()
    }

    pub fn storage_config(&self) -> StorageConfig {
        self.storage_config.read().expect("storage config").clone()
    }

    /// Persiste el modo/base URL, valida que cloud tenga sesión y cambia el
    /// store antes de devolver la configuración ya completa. Al pasar de local
    /// a cloud migra el snapshot local a la cuenta (S4, A4) dejando el archivo
    /// local intacto.
    pub fn set_storage_config(&self, mut config: StorageConfig) -> Result<StorageConfig, String> {
        config.validate()?;
        if config.mode == StorageMode::Cloud && !self.auth.has_session() {
            return Err("iniciá sesión antes de usar el modo nube".to_string());
        }
        let current = self.storage_config();
        let store: Arc<dyn SnapshotStore> = match config.mode {
            StorageMode::Local => Arc::new(FsSnapshotStore::new(self.data_dir.clone())),
            StorageMode::Cloud => {
                let tokens: Arc<dyn AccessTokenProvider> = self.auth.clone();
                let cloud = Arc::new(CloudSnapshotStore::new(config.api_base_url.clone(), tokens));
                let local = FsSnapshotStore::new(self.data_dir.clone());
                migrate_local_snapshot_if_needed(&current, config.mode, &local, |snapshot| {
                    cloud.migrate_snapshot(snapshot)
                })?;
                cloud
            }
        };
        config.onboarding_complete = true;
        config.save(&self.data_dir)?;
        *self.snapshot_store.write().expect("snapshot store") = store;
        *self.storage_config.write().expect("storage config") = config.clone();
        Ok(config)
    }
}

fn build_snapshot_store(
    config: &StorageConfig,
    data_dir: &Path,
    auth: Arc<AuthStore>,
) -> Arc<dyn SnapshotStore> {
    match config.mode {
        StorageMode::Local => Arc::new(FsSnapshotStore::new(data_dir.to_path_buf())),
        StorageMode::Cloud => {
            let tokens: Arc<dyn AccessTokenProvider> = auth;
            Arc::new(CloudSnapshotStore::new(config.api_base_url.clone(), tokens))
        }
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

fn migrate_local_snapshot_if_needed(
    previous: &StorageConfig,
    target_mode: StorageMode,
    local_store: &dyn SnapshotStore,
    migrate: impl FnOnce(&WorkspaceSnapshot) -> Result<(), PortError>,
) -> Result<(), String> {
    if !previous.onboarding_complete
        || previous.mode != StorageMode::Local
        || target_mode != StorageMode::Cloud
    {
        return Ok(());
    }
    if let Some(snapshot) = local_store.load_snapshot().map_err(|e| e.to_string())? {
        if !snapshot.workspaces.is_empty() {
            migrate(&snapshot).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use application::storage::{StoredPane, StoredSession, StoredWorkspace};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "opencollab-state-migrate-{tag}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot::new(vec![StoredWorkspace {
            id: "w1".into(),
            name: "Local".into(),
            sessions: vec![StoredSession {
                id: "s1".into(),
                name: "Sesión".into(),
                panes: vec![StoredPane {
                    id: "p1".into(),
                    seq: 0,
                    minimized: false,
                    initial_cwd: None,
                    agent: None,
                }],
            }],
        }])
    }

    #[test]
    fn switching_from_completed_local_to_cloud_migrates_and_keeps_local_file() {
        let dir = temp_dir("local-to-cloud");
        let local = FsSnapshotStore::new(&dir);
        let expected = sample_snapshot();
        local.save_snapshot(&expected).unwrap();

        let previous = StorageConfig {
            version: 1,
            mode: StorageMode::Local,
            api_base_url: "http://127.0.0.1:8787".into(),
            onboarding_complete: true,
        };
        let mut migrated: Option<WorkspaceSnapshot> = None;
        migrate_local_snapshot_if_needed(&previous, StorageMode::Cloud, &local, |snap| {
            migrated = Some(snap.clone());
            Ok(())
        })
        .unwrap();

        assert_eq!(migrated.as_ref(), Some(&expected));
        assert_eq!(
            local.load_snapshot().unwrap().as_ref(),
            Some(&expected),
            "el archivo local debe conservarse intacto tras migrar (A4)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_error_fails_closed_and_keeps_local_file() {
        let dir = temp_dir("migrate-error");
        let local = FsSnapshotStore::new(&dir);
        let expected = sample_snapshot();
        local.save_snapshot(&expected).unwrap();

        let previous = StorageConfig {
            version: 1,
            mode: StorageMode::Local,
            api_base_url: "http://127.0.0.1:8787".into(),
            onboarding_complete: true,
        };
        let err = migrate_local_snapshot_if_needed(&previous, StorageMode::Cloud, &local, |_| {
            Err(PortError::new("fallo de red al migrar"))
        })
        .unwrap_err();

        assert!(err.contains("fallo de red al migrar"), "{err}");
        assert_eq!(local.load_snapshot().unwrap().as_ref(), Some(&expected));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_run_or_non_local_source_does_not_migrate() {
        let dir = temp_dir("skip-migrate");
        let local = FsSnapshotStore::new(&dir);
        local.save_snapshot(&sample_snapshot()).unwrap();

        let first_run = StorageConfig {
            version: 1,
            mode: StorageMode::Local,
            api_base_url: "http://127.0.0.1:8787".into(),
            onboarding_complete: false,
        };
        let mut called = false;
        migrate_local_snapshot_if_needed(&first_run, StorageMode::Cloud, &local, |_| {
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(
            !called,
            "el primer arranque no debe migrar como cambio de modo"
        );

        let already_cloud = StorageConfig {
            version: 1,
            mode: StorageMode::Cloud,
            api_base_url: "http://127.0.0.1:8787".into(),
            onboarding_complete: true,
        };
        migrate_local_snapshot_if_needed(&already_cloud, StorageMode::Cloud, &local, |_| {
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(
            !called,
            "cloud -> cloud no debe volver a migrar el archivo local"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
