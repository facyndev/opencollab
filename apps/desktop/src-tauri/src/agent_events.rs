//! Reenvía al frontend el estado reducido de cada agente (`AgentState`).
//!
//! Por el cable viaja el estado y no los eventos crudos: el reductor vive en
//! `application` (testeado) y el frontend no lo duplica; solo muestra el estado
//! y le suma lo que es de UI (la "atención" depende del foco del panel).

use std::sync::Arc;

use application::{AgentEvent, AgentEventSink, AgentState, AgentStates};
use domain::TerminalId;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const TERMINAL_AGENT_STATE_EVENT: &str = "terminal-agent-state";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAgentStatePayload {
    terminal_id: String,
    state: AgentState,
}

/// Aplica cada evento al estado de su terminal y emite el estado solo si cambió.
pub struct TauriAgentEvents {
    app: AppHandle,
    states: Arc<AgentStates>,
}

impl TauriAgentEvents {
    pub fn new(app: AppHandle, states: Arc<AgentStates>) -> Self {
        Self { app, states }
    }
}

impl TauriAgentEvents {
    fn publish(&self, terminal: TerminalId, state: Option<AgentState>) {
        if let Some(state) = state {
            let _ = self.app.emit(
                TERMINAL_AGENT_STATE_EVENT,
                TerminalAgentStatePayload {
                    terminal_id: terminal.to_string(),
                    state,
                },
            );
        }
    }

    /// Camino genérico (actividad del PTY, salida del proceso): si la terminal
    /// tiene un adaptador rico, su `status_changed` se descarta.
    pub fn emit_generic(&self, terminal: TerminalId, event: AgentEvent) {
        let state = self.states.apply_generic(terminal, event);
        self.publish(terminal, state);
    }
}

impl AgentEventSink for TauriAgentEvents {
    /// Camino de los adaptadores ricos: autoritativo.
    fn emit(&self, terminal: TerminalId, event: AgentEvent) {
        let state = self.states.apply(terminal, event);
        self.publish(terminal, state);
    }
}
