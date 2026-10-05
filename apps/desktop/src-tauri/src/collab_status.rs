//! Estado de colaboración para la status bar: comando `collab_status` y un
//! watcher que avisa al frontend solo cuando el valor cambia de forma visible.

use std::thread;
use std::time::Duration;

use application::{AppError, RelayStatus};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub const COLLAB_STATUS_EVENT: &str = "collab-status";
const INTERVAL: Duration = Duration::from_secs(3);
/// Cuánto debe moverse la latencia para que valga un evento: la medida
/// fluctúa unos ms en cada sondeo y no queremos emitir en cada vuelta.
const LATENCY_MIN_DELTA_MS: u64 = 5;
const LATENCY_MIN_DELTA_PERCENT: u64 = 25;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabStatusPayload {
    pub connected: bool,
    /// Latencia medida contra el relay; `None` si no está conectado.
    pub sync_ms: Option<u64>,
    pub collaborators: usize,
}

impl CollabStatusPayload {
    fn new(relay: RelayStatus, collaborators: usize) -> Self {
        match relay {
            RelayStatus::Connected { latency_ms } => Self {
                connected: true,
                sync_ms: Some(latency_ms),
                collaborators,
            },
            RelayStatus::Disconnected => Self {
                connected: false,
                sync_ms: None,
                collaborators,
            },
        }
    }
}

/// Foto actual: sondea el relay (bloquea hasta el timeout) y cuenta colaboradores.
pub fn snapshot(state: &AppState) -> Result<CollabStatusPayload, AppError> {
    let collaborators = state.session_collaborators.execute(state.session_id)?;
    Ok(CollabStatusPayload::new(
        state.check_relay.execute(),
        collaborators,
    ))
}

/// Regla de emisión: siempre que cambie conectado/colaboradores; la latencia
/// solo si se movió más de `LATENCY_MIN_DELTA_MS` y de `LATENCY_MIN_DELTA_PERCENT`%
/// respecto de la última emitida.
fn should_emit(last: Option<&CollabStatusPayload>, current: &CollabStatusPayload) -> bool {
    let Some(last) = last else { return true };
    if last.connected != current.connected || last.collaborators != current.collaborators {
        return true;
    }
    match (last.sync_ms, current.sync_ms) {
        (Some(before), Some(now)) => {
            let delta = before.abs_diff(now);
            delta > LATENCY_MIN_DELTA_MS && delta * 100 > before * LATENCY_MIN_DELTA_PERCENT
        }
        (before, now) => before != now,
    }
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<CollabStatusPayload> = None;
        loop {
            let state = app.state::<AppState>();
            match snapshot(&state) {
                Ok(current) => {
                    if should_emit(last.as_ref(), &current) {
                        let _ = app.emit(COLLAB_STATUS_EVENT, current.clone());
                        last = Some(current);
                    }
                }
                Err(e) => eprintln!("estado de colaboración: {e}"),
            }
            thread::sleep(INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(ms: u64, collaborators: usize) -> CollabStatusPayload {
        CollabStatusPayload::new(RelayStatus::Connected { latency_ms: ms }, collaborators)
    }

    fn disconnected(collaborators: usize) -> CollabStatusPayload {
        CollabStatusPayload::new(RelayStatus::Disconnected, collaborators)
    }

    #[test]
    fn first_value_is_always_emitted() {
        assert!(should_emit(None, &disconnected(1)));
    }

    #[test]
    fn identical_value_is_not_emitted() {
        assert!(!should_emit(Some(&connected(40, 1)), &connected(40, 1)));
    }

    #[test]
    fn connection_change_is_emitted() {
        assert!(should_emit(Some(&disconnected(1)), &connected(40, 1)));
        assert!(should_emit(Some(&connected(40, 1)), &disconnected(1)));
    }

    #[test]
    fn collaborators_change_is_emitted() {
        assert!(should_emit(Some(&connected(40, 1)), &connected(40, 2)));
    }

    #[test]
    fn small_latency_jitter_is_not_emitted() {
        assert!(!should_emit(Some(&connected(40, 1)), &connected(46, 1)));
        assert!(!should_emit(Some(&connected(2, 1)), &connected(6, 1)));
    }

    #[test]
    fn large_latency_change_is_emitted() {
        assert!(should_emit(Some(&connected(40, 1)), &connected(55, 1)));
        assert!(should_emit(Some(&connected(200, 1)), &connected(100, 1)));
    }

    #[test]
    fn serializes_in_camel_case() {
        let json = serde_json::to_value(connected(12, 1)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "connected": true, "syncMs": 12, "collaborators": 1 })
        );
        let json = serde_json::to_value(disconnected(1)).unwrap();
        assert_eq!(json["syncMs"], serde_json::Value::Null);
    }
}
