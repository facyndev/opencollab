// Evita la consola extra en Windows en builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_watcher;
mod collab_status;
mod commands;
mod state;
mod subagents;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(state::AppState::bootstrap(app.handle())?);
            agent_watcher::spawn(app.handle().clone());
            collab_status::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_shell,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::list_subdirectories,
            commands::collab_status,
            commands::subagent_snapshot,
            commands::hook_status,
            commands::install_agent_hooks,
            commands::uninstall_agent_hooks,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar OpenCollab");
}
