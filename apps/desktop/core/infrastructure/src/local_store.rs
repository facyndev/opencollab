//! Backend local del snapshot: un JSON en el directorio de datos de la app.
//!
//! Escritura atÃ³mica (temporal + renombre) para que un cierre a medias nunca
//! deje el snapshot corrupto, y cuarentena de archivos ilegibles: un archivo
//! que no se puede leer se renombra a `.corrupt` y la app arranca limpia en
//! vez de no abrir (S5: persistir es una mejora, nunca un obstÃ¡culo).

use std::fs;
use std::path::PathBuf;

use application::ports::{PortError, SnapshotStore};
use application::storage::WorkspaceSnapshot;

const FILE_NAME: &str = "workspaces.json";
const CORRUPT_EXT: &str = "corrupt";

/// Snapshot en `dir/workspaces.json`. `dir` es el directorio de datos de la
/// app (appdata en producciÃ³n, un temporal en los tests).
pub struct FsSnapshotStore {
    path: PathBuf,
}

impl FsSnapshotStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            path: dir.into().join(FILE_NAME),
        }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Pone el archivo ilegible a un lado con extensiÃ³n `.corrupt` para no
    /// pisarlo con el prÃ³ximo guardado. Best-effort: si falla, el arranque
    /// limpio sigue igual (el prÃ³ximo guardado lo reemplaza).
    fn quarantine(&self) {
        let to = self.path.with_extension(CORRUPT_EXT);
        let _ = fs::rename(&self.path, &to);
    }
}

impl SnapshotStore for FsSnapshotStore {
    fn load_snapshot(&self) -> Result<Option<WorkspaceSnapshot>, PortError> {
        let data = match fs::read_to_string(&self.path) {
            Ok(data) => data,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(PortError::new(format!("no se pudo leer el snapshot: {e}"))),
        };
        match serde_json::from_str::<WorkspaceSnapshot>(&data) {
            Ok(snapshot) if snapshot.is_current_version() => Ok(Some(snapshot)),
            // Ilegible o de una versión que no sabemos leer: cuarentena y
            // arranque limpio. Nunca frenar la app por un archivo roto.
            _ => {
                self.quarantine();
                Ok(None)
            }
        }
    }

    fn save_snapshot(&self, snapshot: &WorkspaceSnapshot) -> Result<(), PortError> {
        let json = serde_json::to_string(snapshot)
            .map_err(|e| PortError::new(format!("no se pudo serializar el snapshot: {e}")))?;
        // Escritura atómica: primero al temporal, después renombre. Un cierre
        // a medias deja intacto el snapshot anterior.
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                PortError::new(format!("no se pudo crear el directorio de datos: {e}"))
            })?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json)
            .map_err(|e| PortError::new(format!("no se pudo escribir el snapshot: {e}")))?;
        fs::rename(&tmp, &self.path)
            .map_err(|e| PortError::new(format!("no se pudo reemplazar el snapshot: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    use application::storage::{StoredPane, StoredSession, StoredWorkspace, SNAPSHOT_VERSION};

    use super::*;

    /// Directorio temporal por test; se borra al salir del scope.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "opencollab-local-store-{tag}-{}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn sub(&self, name: &str) -> PathBuf {
            let p = self.0.join(name);
            fs::create_dir_all(&p).unwrap();
            p
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot::new(vec![StoredWorkspace {
            id: "ws-1".into(),
            name: "OpenCollab".into(),
            sessions: vec![StoredSession {
                id: "session-1".into(),
                name: "SesiÃ³n 1".into(),
                panes: vec![
                    StoredPane {
                        id: "pane-1".into(),
                        seq: 0,
                        minimized: false,
                        initial_cwd: Some("C:\\repo".into()),
                        agent: Some("claude-code".into()),
                    },
                    StoredPane {
                        id: "pane-2".into(),
                        seq: 1,
                        minimized: true,
                        initial_cwd: None,
                        agent: None,
                    },
                ],
            }],
        }])
    }

    #[test]
    fn round_trips_the_whole_structure() {
        let dir = TempDir::new("round-trip");
        let store = FsSnapshotStore::new(dir.0.clone());
        store.save_snapshot(&snapshot()).unwrap();
        let loaded = store.load_snapshot().unwrap();
        assert_eq!(loaded, Some(snapshot()));
    }

    #[test]
    fn no_file_yet_means_no_snapshot() {
        let dir = TempDir::new("missing");
        let store = FsSnapshotStore::new(dir.0.clone());
        assert_eq!(store.load_snapshot().unwrap(), None);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = TempDir::new("create-dirs");
        let nested = dir.sub("a").join("b"); // todavÃ­a no existe
        let store = FsSnapshotStore::new(nested);
        store.save_snapshot(&snapshot()).unwrap();
        assert!(store.path().is_file());
    }

    #[test]
    fn saving_replaces_the_previous_snapshot() {
        let dir = TempDir::new("replace");
        let store = FsSnapshotStore::new(dir.0.clone());
        store.save_snapshot(&snapshot()).unwrap();
        let next = WorkspaceSnapshot::new(vec![StoredWorkspace {
            id: "ws-2".into(),
            name: "otro".into(),
            sessions: vec![],
        }]);
        store.save_snapshot(&next).unwrap();
        assert_eq!(store.load_snapshot().unwrap(), Some(next));
    }

    #[test]
    fn garbage_file_is_quarantined_and_boot_is_fresh() {
        let dir = TempDir::new("garbage");
        let store = FsSnapshotStore::new(dir.0.clone());
        fs::write(store.path(), "no es json").unwrap();
        assert_eq!(store.load_snapshot().unwrap(), None);
        // El original queda a un lado, recuperable a mano.
        let corrupt = store.path().with_extension(CORRUPT_EXT);
        assert_eq!(fs::read_to_string(&corrupt).unwrap(), "no es json");
        // Y el segundo arranque ya ni lo ve: el archivo original ya no estÃ¡.
        assert_eq!(store.load_snapshot().unwrap(), None);
    }

    #[test]
    fn future_version_is_quarantined_and_boot_is_fresh() {
        let dir = TempDir::new("future");
        let store = FsSnapshotStore::new(dir.0.clone());
        let future = serde_json::to_string(&WorkspaceSnapshot {
            version: SNAPSHOT_VERSION + 1,
            workspaces: vec![],
        })
        .unwrap();
        fs::write(store.path(), future).unwrap();
        assert_eq!(store.load_snapshot().unwrap(), None);
        assert!(store.path().with_extension(CORRUPT_EXT).is_file());
    }

    #[test]
    fn empty_file_is_quarantined_and_boot_is_fresh() {
        let dir = TempDir::new("empty");
        let store = FsSnapshotStore::new(dir.0.clone());
        fs::write(store.path(), "").unwrap();
        assert_eq!(store.load_snapshot().unwrap(), None);
        assert!(store.path().with_extension(CORRUPT_EXT).is_file());
    }

    #[test]
    fn save_over_quarantined_leftovers_still_works() {
        let dir = TempDir::new("after-corrupt");
        let store = FsSnapshotStore::new(dir.0.clone());
        fs::write(store.path(), "roto").unwrap();
        assert_eq!(store.load_snapshot().unwrap(), None);
        // ArrancÃ³ limpio: el prÃ³ximo guardado escribe el archivo de vuelta.
        store.save_snapshot(&snapshot()).unwrap();
        assert_eq!(store.load_snapshot().unwrap(), Some(snapshot()));
        // La cuarentena del arranque anterior no molesta al nuevo archivo.
        assert!(store.path().with_extension(CORRUPT_EXT).is_file());
    }

    #[test]
    fn pane_order_survives_the_round_trip() {
        let dir = TempDir::new("order");
        let store = FsSnapshotStore::new(dir.0.clone());
        let mut snap = snapshot();
        let StoredWorkspace { sessions, .. } = &mut snap.workspaces[0];
        sessions[0].panes.reverse(); // orden visual distinto al de creaciÃ³n
        store.save_snapshot(&snap).unwrap();
        let loaded = store.load_snapshot().unwrap().unwrap();
        let panes = &loaded.workspaces[0].sessions[0].panes;
        assert_eq!(panes[0].id, "pane-2");
        assert_eq!(panes[1].id, "pane-1");
        // El seq (orden del DOM) viaja intacto aunque el array estÃ© reordenado.
        assert_eq!(panes[0].seq, 1);
        assert_eq!(panes[1].seq, 0);
    }

    #[test]
    fn path_is_inside_the_configured_directory() {
        let dir = TempDir::new("path");
        let store = FsSnapshotStore::new(dir.0.clone());
        assert_eq!(store.path(), Path::new(&dir.0).join(FILE_NAME));
    }
}
