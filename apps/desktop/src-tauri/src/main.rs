// Evita la consola extra en Windows en builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_watcher;
mod commands;
mod state;
mod agent_session;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(icon) = app.default_window_icon() {
                for window in app.webview_windows().values() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            app.manage(state::AppState::bootstrap(app.handle())?);
            agent_watcher::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_shell,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::list_subdirectories,
            commands::agent_session_title,
            commands::hook_status,
            commands::install_agent_hooks,
            commands::uninstall_agent_hooks,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar OpenCollab");
}
