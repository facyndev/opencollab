// Evita la consola extra en Windows en builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_events;
mod agent_watcher;
mod auth;
mod collab_status;
mod commands;
mod env;
mod state;
mod storage_config;

use tauri::Manager;

fn main() {
    env::load_dot_env();
    let mut builder = tauri::Builder::default();
    // Único: el deep link que llega como argumento de un segundo proceso se
    // reenvía a esta instancia (el plugin `deep-link` lo entrega igual).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon() {
                for window in app.webview_windows().values() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            // appdata del bundle (app_data_dir une el identificador del
            // tauri.conf.json a la carpeta de datos del usuario).
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("no se pudo resolver el directorio de datos: {e}"))?;
            app.manage(state::AppState::bootstrap(data_dir)?);
            agent_watcher::spawn(app.handle().clone());
            collab_status::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_shell,
            commands::available_agents,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::snapshot_load,
            commands::snapshot_save,
            commands::storage_config_get,
            commands::storage_config_set,
            commands::list_subdirectories,
            commands::git_branch,
            commands::collab_status,
            auth::auth_begin_login,
            auth::auth_finish,
            auth::auth_status,
            auth::auth_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar OpenCollab");
}
