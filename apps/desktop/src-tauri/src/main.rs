// Evita la consola extra en Windows en builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_watcher;
mod commands;
mod state;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(state::AppState::bootstrap()?);
            agent_watcher::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_shell,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::list_subdirectories,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar OpenCollab");
}
