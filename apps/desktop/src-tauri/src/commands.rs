//! Comandos Tauri: solo traducen entrada/salida y delegan en casos de uso.

use std::sync::Arc;
use std::time::Instant;

use application::ports::{TerminalOutputSink, TerminalSize};
use domain::TerminalId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use infrastructure::default_shell_profile;

use application::{exit_event, ActivityTracker, AgentEventSink, AgentStates};

use crate::agent_events::TauriAgentEvents;
use crate::collab_status::{self, CollabStatusPayload};
use crate::state::AppState;

pub const TERMINAL_OUTPUT_EVENT: &str = "terminal-output";
pub const TERMINAL_EXIT_EVENT: &str = "terminal-exit";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    terminal_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    terminal_id: String,
}

/// Reenvía la salida de los PTY al frontend como eventos.
struct TauriOutputSink {
    app: AppHandle,
    activity: Arc<ActivityTracker>,
    events: Arc<dyn AgentEventSink>,
    states: Arc<AgentStates>,
}

impl TerminalOutputSink for TauriOutputSink {
    fn output(&self, terminal: TerminalId, data: &[u8]) {
        self.activity.record_output(terminal, Instant::now());
        let _ = self.app.emit(
            TERMINAL_OUTPUT_EVENT,
            TerminalOutputPayload {
                terminal_id: terminal.to_string(),
                data: data.to_vec(),
            },
        );
    }

    fn exited(&self, terminal: TerminalId) {
        self.activity.forget(terminal);
        // Sin código de salida disponible en el puerto del PTY: se asume normal.
        self.events.emit(terminal, exit_event(None));
        self.states.forget(terminal);
        let _ = self.app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitPayload {
                terminal_id: terminal.to_string(),
            },
        );
    }
}

fn parse_terminal(id: &str) -> Result<TerminalId, String> {
    id.parse().map_err(|e: domain::InvalidId| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTerminal {
    terminal_id: String,
    name: String,
    cwd: Option<String>,
}

// Los comandos que pueden tardar (lanzar procesos, `taskkill`, leer disco) son
// `async`: Tauri corre los síncronos en el hilo principal y congelarían la UI.
#[tauri::command(async)]
pub fn open_shell(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    // Carpeta inicial (p. ej. la de la terminal desde la que se abre); `None` = home.
    cwd: Option<String>,
) -> Result<OpenedTerminal, String> {
    let sink: Arc<dyn TerminalOutputSink> = Arc::new(TauriOutputSink {
        events: Arc::new(TauriAgentEvents::new(
            app.clone(),
            state.agent_states.clone(),
        )),
        app,
        activity: state.activity.clone(),
        states: state.agent_states.clone(),
    });
    let profile = default_shell_profile(cwd.as_deref().map(std::path::Path::new));
    let name = profile.name.clone();
    let cwd = profile.cwd.as_ref().map(|p| p.display().to_string());
    state
        .launch_terminal
        .execute(
            state.local_user,
            state.session_id,
            profile,
            TerminalSize { cols, rows },
            sink,
        )
        .map(|id| OpenedTerminal {
            terminal_id: id.to_string(),
            name,
            cwd,
        })
        .map_err(|e| e.to_string())
}

// Síncrono a propósito: los comandos async corren en un pool y podrían
// desordenar las teclas.
#[tauri::command]
pub fn write_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let terminal = parse_terminal(&terminal_id)?;
    state
        .send_input
        .execute(
            state.local_user,
            state.session_id,
            terminal,
            data.as_bytes(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_subdirectories(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    state
        .list_subdirectories
        .execute(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDto {
    /// Nombre de la rama, o SHA corto si `HEAD` está desacoplado.
    name: String,
    detached: bool,
}

/// Rama de git de una carpeta (`None` fuera de un repositorio). Lee disco: `async`.
#[tauri::command(async)]
pub fn git_branch(state: State<'_, AppState>, path: String) -> Option<BranchDto> {
    state
        .inspect_branch
        .execute(std::path::Path::new(&path))
        .map(|branch| BranchDto {
            detached: branch.is_detached(),
            name: branch.label().to_string(),
        })
}

// `async`: sondear el relay bloquea hasta su timeout y no debe frenar la UI.
#[tauri::command(async)]
pub fn collab_status(state: State<'_, AppState>) -> Result<CollabStatusPayload, String> {
    Ok(collab_status::snapshot(&state, None))
}

#[tauri::command(async)]
pub fn close_terminal(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    let terminal = parse_terminal(&terminal_id)?;
    state
        .close_terminal
        .execute(state.local_user, state.session_id, terminal)
        .map_err(|e| e.to_string())?;
    state.activity.forget(terminal);
    state.agent_states.forget(terminal);
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminal = parse_terminal(&terminal_id)?;
    state
        .resize_terminal
        .execute(
            state.local_user,
            state.session_id,
            terminal,
            TerminalSize { cols, rows },
        )
        .map_err(|e| e.to_string())
}
