//! Shell por defecto del sistema, con integración para reportar el directorio
//! actual.
//!
//! Integración: el prompt de la shell emite `OSC 7` (`ESC ] 7 ; file://host/ruta ESC \`)
//! antes de cada prompt. Es una secuencia invisible que el emulador de terminal
//! (xterm.js) lee para saber en qué carpeta está la shell. Hace falta porque
//! PowerShell no cambia el directorio del proceso al hacer `cd`, así que no se
//! puede leer desde afuera.

use std::path::Path;

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

/// Shell por defecto, arrancando en `cwd` si es una carpeta existente (p. ej. al
/// abrir una terminal desde otra) o, si no, en la carpeta del usuario.
pub fn default_shell_profile(cwd: Option<&Path>) -> AgentProfile {
    let profile = if cfg!(windows) {
        AgentProfile::new("PowerShell", "powershell.exe")
            .map(|p| p.with_args(["-NoLogo", "-NoExit", "-Command", POWERSHELL_INTEGRATION]))
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        AgentProfile::new("Shell", shell)
    }
    .expect("el comando de la shell por defecto no está vacío");

    // La carpeta pudo borrarse desde que la reportó la otra terminal.
    if let Some(cwd) = cwd.filter(|p| p.is_dir()) {
        return profile.with_cwd(cwd);
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    match home {
        Some(home) => profile.with_cwd(home),
        None => profile,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_in_the_requested_directory_when_it_exists() {
        let dir = std::env::temp_dir();
        let profile = default_shell_profile(Some(&dir));
        assert_eq!(profile.cwd.as_deref(), Some(dir.as_path()));
    }

    #[test]
    fn falls_back_to_home_when_the_directory_does_not_exist() {
        let missing = std::env::temp_dir().join("opencollab-no-existe-esta-carpeta");
        let profile = default_shell_profile(Some(&missing));
        assert_eq!(profile.cwd, default_shell_profile(None).cwd);
        assert_ne!(profile.cwd.as_deref(), Some(missing.as_path()));
    }
}
