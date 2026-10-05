//! Revisa periódicamente qué agente corre en cada terminal y cuál está activa,
//! y avisa al frontend solo cuando algo cambia.

use std::collections::HashMap;
use std::thread;
use std::time::{Duration, Instant};

use application::{activity_event, AgentEventSink};
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
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let events =
            TauriAgentEvents::new(app.clone(), app.state::<AppState>().agent_states.clone());
        let mut last: HashMap<TerminalId, (Vec<&'static str>, Option<u64>)> = HashMap::new();
        loop {
            thread::sleep(INTERVAL);
            let state = app.state::<AppState>();
            // Adaptador genérico: la actividad del PTY como `status_changed`.
            for (terminal, activity) in state.activity.tick(Instant::now()) {
                events.emit(terminal, activity_event(activity));
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
                let agents: Vec<&'static str> = tree
                    .primary
                    .into_iter()
                    .chain(tree.nested)
                    .map(|a| a.id())
                    .collect();
                let value = (agents, started_at);
                if last.get(&terminal) != Some(&value) {
                    let _ = app.emit(
                        TERMINAL_AGENT_EVENT,
                        TerminalAgentPayload {
                            terminal_id: terminal.to_string(),
                            agents: value.0.clone(),
                            started_at,
                        },
                    );
                }
                current.insert(terminal, value);
            }
            // Las terminales cerradas desaparecen solas del mapa.
            last = current;
        }
    });
}
