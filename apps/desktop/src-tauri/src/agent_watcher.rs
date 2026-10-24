//! Revisa periódicamente qué agente corre en cada terminal y cuál está activa,
//! y avisa al frontend solo cuando algo cambia.

use std::collections::HashMap;
use std::thread;
use std::time::{Duration, Instant};

use application::activity_event;
use domain::TerminalId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_events::TauriAgentEvents;
use crate::state::AppState;

pub const TERMINAL_AGENT_EVENT: &str = "terminal-agent";
const INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAgentPayload {
    terminal_id: String,
    /// Agentes conocidos corriendo en la terminal, del más cercano a la shell al
    /// más profundo. Vacío cuando en la terminal no corre ningún agente.
    agents: Vec<&'static str>,
    /// Arranque del proceso del agente principal (segundos desde la época Unix);
    /// `null` si no corre ninguno.
    started_at: Option<u64>,
    /// Directorio de trabajo actual del agente o subagente activo (`null` si no
    /// corre ningún agente o el SO no lo expone).
    cwd: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct AgentObservation {
    agents: Vec<&'static str>,
    started_at: Option<u64>,
    cwd: Option<String>,
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let events =
            TauriAgentEvents::new(app.clone(), app.state::<AppState>().agent_states.clone());
        let mut last: HashMap<TerminalId, AgentObservation> = HashMap::new();
        loop {
            thread::sleep(INTERVAL);
            let state = app.state::<AppState>();
            // Adaptador genérico: la actividad del PTY como `status_changed`.
            for (terminal, activity) in state.activity.tick(Instant::now()) {
                events.emit_generic(terminal, activity_event(activity));
            }
            let detected = match state.detect_agents.execute(state.session_id) {
                Ok(detected) => detected,
                Err(e) => {
                    eprintln!("detección de agentes: {e}");
                    continue;
                }
            };

            let mut current = HashMap::with_capacity(detected.len());
            for (terminal, tree) in detected {
                // El principal primero, después los que ese agente tiene anidados.
                let started_at = tree.primary.and(tree.primary_started_at);
                let cwd = tree
                    .primary
                    .and(tree.active_cwd)
                    .map(|p| p.to_string_lossy().into_owned());
                let agents: Vec<&'static str> = tree
                    .primary
                    .into_iter()
                    .chain(tree.nested)
                    .map(|a| a.id())
                    .collect();
                let observation = AgentObservation {
                    agents,
                    started_at,
                    cwd,
                };
                if last.get(&terminal) != Some(&observation) {
                    let _ = app.emit(
                        TERMINAL_AGENT_EVENT,
                        TerminalAgentPayload {
                            terminal_id: terminal.to_string(),
                            agents: observation.agents.clone(),
                            started_at: observation.started_at,
                            cwd: observation.cwd.clone(),
                        },
                    );
                }
                current.insert(terminal, observation);
            }
            // Las terminales cerradas desaparecen solas del mapa.
            last = current;
        }
    });
}
