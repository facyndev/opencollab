//! Shell por defecto del sistema, con integración para reportar el directorio
//! actual.
//!
//! Integración: el prompt de la shell emite `OSC 7` (`ESC ] 7 ; file://host/ruta ESC \`)
//! antes de cada prompt. Es una secuencia invisible que el emulador de terminal
//! (xterm.js) lee para saber en qué carpeta está la shell. Hace falta porque
//! PowerShell no cambia el directorio del proceso al hacer `cd`, así que no se
//! puede leer desde afuera.

use domain::AgentProfile;

/// Envuelve el `prompt` de PowerShell (después de cargar el perfil del usuario)
/// para que antes de cada prompt escriba OSC 7 con la ubicación actual.
/// Compatible con Windows PowerShell 5.1 (sin `` `e ``).
const POWERSHELL_INTEGRATION: &str = concat!(
    "$global:__ocPrompt = $function:prompt; ",
    "function global:prompt { ",
    "$loc = $executionContext.SessionState.Path.CurrentLocation; ",
    "if ($loc.Provider.Name -eq 'FileSystem') { ",
    "[Console]::Write([char]27 + ']7;file://localhost/' + ($loc.ProviderPath -replace '\\\\', '/') + [char]27 + '\\') ",
    "}; ",
    "& $global:__ocPrompt ",
    "}"
);

pub fn default_shell_profile() -> AgentProfile {
    let profile = if cfg!(windows) {
        AgentProfile::new("PowerShell", "powershell.exe")
            .map(|p| p.with_args(["-NoLogo", "-NoExit", "-Command", POWERSHELL_INTEGRATION]))
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        AgentProfile::new("Shell", shell)
    }
    .expect("el comando de la shell por defecto no está vacío");

    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    match home {
        Some(home) => profile.with_cwd(home),
        None => profile,
    }
}
