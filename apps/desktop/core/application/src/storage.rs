//! Snapshot de la estructura del escritorio: workspaces, sesiones y perfiles
//! de arranque de las terminales. Es lo único que se persiste en el modo local
//! (feature desktop-dual-storage, S5/A1): ni `env` ni scrollback ni estado de
//! procesos, solo lo necesario para reconstruir la grilla al arrancar.

use serde::{Deserialize, Serialize};

/// Versión del formato. Un archivo con otra versión no se sabe leer y se pone
/// en cuarentena en vez de bochar la app; cuando haya migraciones reales se
/// agregan acá.
pub const SNAPSHOT_VERSION: u32 = 1;

/// Una terminal del escritorio: su perfil de arranque y su lugar en la grilla.
/// Espeja al `Pane` de la UI (`packages/ui/src/model.ts`): el orden del DOM es
/// `seq` (estable, para no resetear xterm) y el orden visual es la posición en
/// el array de la sesión.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPane {
    pub id: String,
    /// Orden de creación. Unicidad global, igual que en la UI.
    pub seq: u64,
    pub minimized: bool,
    /// Carpeta inicial de la shell; `None` = la por defecto del núcleo.
    pub initial_cwd: Option<String>,
    /// Agente que se lanza al abrir la terminal; `None` = solo la shell.
    pub agent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub name: String,
    /// En orden visual (arrastrar paneles reordena este array).
    pub panes: Vec<StoredPane>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkspace {
    pub id: String,
    pub name: String,
    pub sessions: Vec<StoredSession>,
}

/// Toda la estructura persistida del escritorio, de una vez. El backend la
/// guarda y la devuelve completa; no hay lectura por partes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub version: u32,
    pub workspaces: Vec<StoredWorkspace>,
}

impl WorkspaceSnapshot {
    /// Snapshot de la versión vigente.
    pub fn new(workspaces: Vec<StoredWorkspace>) -> Self {
        Self {
            version: SNAPSHOT_VERSION,
            workspaces,
        }
    }

    /// Es de la versión que sabemos leer.
    pub fn is_current_version(&self) -> bool {
        self.version == SNAPSHOT_VERSION
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn pane() -> StoredPane {
        StoredPane {
            id: "pane-1".into(),
            seq: 7,
            minimized: true,
            initial_cwd: Some("C:\\repo".into()),
            agent: Some("claude-code".into()),
        }
    }

    #[test]
    fn serializes_with_camel_case_keys_like_the_frontend_model() {
        let snapshot = WorkspaceSnapshot::new(vec![StoredWorkspace {
            id: "ws-1".into(),
            name: "OpenCollab".into(),
            sessions: vec![StoredSession {
                id: "session-1".into(),
                name: "Sesión 1".into(),
                panes: vec![pane()],
            }],
        }]);
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            json!({
                "version": 1,
                "workspaces": [{
                    "id": "ws-1",
                    "name": "OpenCollab",
                    "sessions": [{
                        "id": "session-1",
                        "name": "Sesión 1",
                        "panes": [{
                            "id": "pane-1",
                            "seq": 7,
                            "minimized": true,
                            "initialCwd": "C:\\repo",
                            "agent": "claude-code"
                        }]
                    }]
                }]
            })
        );
    }

    #[test]
    fn round_trips_through_json() {
        let snapshot = WorkspaceSnapshot::new(vec![StoredWorkspace {
            id: "ws-1".into(),
            name: "trabajo".into(),
            sessions: vec![
                StoredSession {
                    id: "session-1".into(),
                    name: "sin panes".into(),
                    panes: vec![],
                },
                StoredSession {
                    id: "session-2".into(),
                    name: "con pane".into(),
                    panes: vec![StoredPane {
                        id: "pane-1".into(),
                        seq: 0,
                        minimized: false,
                        initial_cwd: None,
                        agent: None,
                    }],
                },
            ],
        }]);
        let back: WorkspaceSnapshot =
            serde_json::from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();
        assert_eq!(back, snapshot);
    }

    #[test]
    fn version_gate_knows_what_it_can_read() {
        let current = WorkspaceSnapshot::new(vec![]);
        assert!(current.is_current_version());
        let future = WorkspaceSnapshot {
            version: SNAPSHOT_VERSION + 1,
            workspaces: vec![],
        };
        assert!(!future.is_current_version());
    }
}
