//! Comandos Tauri: solo traducen entrada/salida y delegan en casos de uso.

use std::sync::Arc;

use application::ports::{TerminalOutputSink, TerminalSize};
use domain::TerminalId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use infrastructure::default_shell_profile;

use application::TrackSubagents;

use crate::state::AppState;
use crate::subagents::{
    forget_terminal, hook_status_dto, parse_agent, subagents_payload, HookStatusDto,
    TerminalSubagentsPayload, TERMINAL_SUBAGENTS_EVENT,
};

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
    subagents: Arc<TrackSubagents>,
}

impl TerminalOutputSink for TauriOutputSink {
    fn output(&self, terminal: TerminalId, data: &[u8]) {
        let _ = self.app.emit(
            TERMINAL_OUTPUT_EVENT,
            TerminalOutputPayload {
                terminal_id: terminal.to_string(),
                data: data.to_vec(),
            },
        );
    }

    fn exited(&self, terminal: TerminalId) {
        emit_forgotten(&self.app, &self.subagents, terminal);
        let _ = self.app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitPayload {
                terminal_id: terminal.to_string(),
            },
        );
    }
}

/// La terminal terminó: descarta sus subagentes y avisa a la UI si tenía.
fn emit_forgotten(app: &AppHandle, hub: &TrackSubagents, terminal: TerminalId) {
    if let Some(payload) = forget_terminal(hub, terminal) {
        let _ = app.emit(TERMINAL_SUBAGENTS_EVENT, payload);
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
        app,
        subagents: state.subagents.clone(),
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

#[tauri::command(async)]
pub fn close_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), String> {
    let terminal = parse_terminal(&terminal_id)?;
    state
        .close_terminal
        .execute(state.local_user, state.session_id, terminal)
        .map_err(|e| e.to_string())?;
    emit_forgotten(&app, &state.subagents, terminal);
    Ok(())
}

/// Foto inicial de los subagentes de una terminal (los cambios llegan por el
/// evento `terminal-subagents`).
#[tauri::command]
pub fn subagent_snapshot(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<TerminalSubagentsPayload, String> {
    let terminal = parse_terminal(&terminal_id)?;
    Ok(subagents_payload(
        terminal,
        &state.subagents.snapshot(terminal),
    ))
}

// Los comandos de hooks leen y escriben archivos de configuración: `async`
// para no bloquear el hilo principal.
#[tauri::command(async)]
pub fn hook_status(state: State<'_, AppState>) -> Vec<HookStatusDto> {
    state
        .inspect_hooks
        .execute()
        .into_iter()
        .map(|(agent, status)| hook_status_dto(agent, status))
        .collect()
}

#[tauri::command(async)]
pub fn install_agent_hooks(state: State<'_, AppState>, agent: String) -> Result<(), String> {
    let agent = parse_agent(&agent)?;
    state
        .install_hooks
        .execute(agent)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn uninstall_agent_hooks(state: State<'_, AppState>, agent: String) -> Result<(), String> {
    let agent = parse_agent(&agent)?;
    state
        .uninstall_hooks
        .execute(agent)
        .map_err(|e| e.to_string())
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
