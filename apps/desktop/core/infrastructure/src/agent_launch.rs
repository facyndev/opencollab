//! Lanzar un agente como perfil: corre DENTRO de la shell por defecto, así al
//! salir del agente el panel vuelve a la shell y la integración de OSC 7 (carpeta
//! actual) sigue funcionando. El dominio sigue siendo agnóstico: el resultado es
//! un `AgentProfile` más (comando, args, env, cwd).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use domain::AgentProfile;

use crate::shell::default_shell_profile;

fn quote_powershell(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "''"))
}

fn quote_posix(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Línea de comando para la shell: `command 'arg1' 'arg2'`. El comando sale del
/// catálogo (no es texto del usuario), los argumentos se entrecomillan.
fn command_line(command: &str, args: &[String], windows: bool) -> String {
    let quote = if windows {
        quote_powershell
    } else {
        quote_posix
    };
    std::iter::once(command.to_string())
        .chain(args.iter().map(|a| quote(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Hace que la shell del perfil corra `line` al arrancar y siga viva después.
fn with_initial_command(mut profile: AgentProfile, line: &str, windows: bool) -> AgentProfile {
    if windows {
        // `-NoExit -Command <integración>`: se encadena el agente al final.
        if let Some(script) = profile.args.last_mut() {
            script.push_str("; ");
            script.push_str(line);
        }
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        profile.args = vec!["-c".into(), format!("{line}; exec {}", quote_posix(&shell))];
    }
    profile
}

/// Perfil que abre la shell por defecto en `cwd` y ejecuta `command args` dentro
/// de ella, con `env` agregado al entorno del proceso.
pub fn agent_shell_profile(
    cwd: Option<&Path>,
    command: &str,
    args: &[String],
    env: &[(String, String)],
) -> AgentProfile {
    let windows = cfg!(windows);
    let profile = with_initial_command(
        default_shell_profile(cwd),
        &command_line(command, args, windows),
        windows,
    );
    env.iter()
        .fold(profile, |p, (k, v)| p.with_env(k.clone(), v.clone()))
}

/// ¿Hay un ejecutable `name` en alguna carpeta de `path_var`? `extensions` son
/// las terminaciones a probar además del nombre solo (`PATHEXT` en Windows).
fn command_exists_in(name: &str, path_var: &OsStr, extensions: &[String]) -> bool {
    std::env::split_paths(path_var).any(|dir| {
        std::iter::once(String::new())
            .chain(extensions.iter().cloned())
            .any(|ext| {
                let file: PathBuf = dir.join(format!("{name}{ext}"));
                file.is_file()
            })
    })
}

/// ¿Se puede ejecutar `name` desde el `PATH` del proceso?
pub fn command_exists(name: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    command_exists_in(name, &path_var, &extensions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_arguments_for_each_shell() {
        let args = vec!["--settings".to_string(), "{\"a\":\"it's\"}".to_string()];
        assert_eq!(
            command_line("claude", &args, true),
            "claude '--settings' '{\"a\":\"it''s\"}'"
        );
        assert_eq!(
            command_line("claude", &args, false),
            "claude '--settings' '{\"a\":\"it'\\''s\"}'"
        );
        assert_eq!(command_line("codex", &[], true), "codex");
    }

    #[test]
    fn windows_chains_the_agent_after_the_shell_integration() {
        let base = AgentProfile::new("PowerShell", "powershell.exe")
            .unwrap()
            .with_args(["-NoLogo", "-NoExit", "-Command", "function prompt {}"]);
        let profile = with_initial_command(base, "claude", true);
        assert_eq!(profile.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert_eq!(profile.args[3], "function prompt {}; claude");
    }

    #[test]
    fn unix_runs_the_agent_and_then_stays_in_the_shell() {
        let base = AgentProfile::new("Shell", "/bin/zsh").unwrap();
        let profile = with_initial_command(base, "claude", false);
        assert_eq!(profile.args[0], "-c");
        assert!(profile.args[1].starts_with("claude; exec '"));
    }

    #[test]
    fn the_profile_keeps_the_cwd_and_carries_the_env() {
        let dir = std::env::temp_dir();
        let profile = agent_shell_profile(
            Some(&dir),
            "claude",
            &["--x".to_string()],
            &[("OC_TOKEN".to_string(), "abc".to_string())],
        );
        assert_eq!(profile.cwd.as_deref(), Some(dir.as_path()));
        assert_eq!(
            profile.env,
            vec![("OC_TOKEN".to_string(), "abc".to_string())]
        );
        assert!(profile.args.iter().any(|a| a.contains("claude '--x'")));
    }

    #[test]
    fn finds_executables_in_the_path_with_or_without_extension() {
        let dir = std::env::temp_dir().join(format!("opencollab-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake-agent.cmd"), "").unwrap();
        std::fs::write(dir.join("plain-agent"), "").unwrap();
        let path = std::env::join_paths([&dir]).unwrap();
        let exts = vec![".cmd".to_string()];
        assert!(command_exists_in("fake-agent", &path, &exts));
        assert!(!command_exists_in("fake-agent", &path, &[]));
        assert!(command_exists_in("plain-agent", &path, &[]));
        assert!(!command_exists_in("missing-agent", &path, &exts));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
