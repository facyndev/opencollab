//! Revisa periódicamente qué agente corre en cada terminal y avisa al
//! frontend solo cuando cambia.

use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use domain::TerminalId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

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
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut last: HashMap<TerminalId, Vec<&'static str>> = HashMap::new();
        loop {
            thread::sleep(INTERVAL);
            let state = app.state::<AppState>();
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
                let agents: Vec<&'static str> = tree
                    .primary
                    .into_iter()
                    .chain(tree.nested)
                    .map(|a| a.id())
                    .collect();
                if last.get(&terminal) != Some(&agents) {
                    let _ = app.emit(
                        TERMINAL_AGENT_EVENT,
                        TerminalAgentPayload {
                            terminal_id: terminal.to_string(),
                            agents: agents.clone(),
                        },
                    );
                }
                current.insert(terminal, agents);
            }
            // Las terminales cerradas desaparecen solas del mapa.
            last = current;
        }
    });
}
