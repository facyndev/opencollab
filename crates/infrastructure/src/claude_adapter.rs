//! Adaptador de Claude Code: hooks HTTP por lanzamiento vía `--settings`.
//!
//! `prepare` escribe un JSON de settings en una carpeta PROPIA de la app (nunca
//! en `~/.claude` ni en el proyecto) con un hook HTTP por evento apuntando al
//! [`HookReceiver`] local, y lo pasa con `--settings <archivo>`: Claude Code lo
//! suma a la configuración del usuario sin tocarla. Va un archivo y no JSON en
//! línea para no pelear con el entrecomillado de PowerShell. El archivo se
//! borra al cerrar la terminal (y los viejos, al arrancar).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use application::ports::PortError;
use application::{AgentAdapter, AgentEventSink, KnownAgent, LaunchAugmentation};
use domain::TerminalId;

use crate::claude_hooks::settings_json;
use crate::hook_receiver::HookReceiver;

const FILE_PREFIX: &str = "claude-settings-";
/// Plazo del hook en segundos: corto para no frenar nunca al agente.
const HOOK_TIMEOUT_SECS: u32 = 2;
/// Antigüedad a partir de la cual un settings huérfano (app caída) se borra.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

pub struct ClaudeCodeAdapter {
    receiver: Arc<HookReceiver>,
    dir: PathBuf,
    /// Terminal -> token, para liberar al cerrarla.
    bound: Mutex<HashMap<TerminalId, String>>,
}

impl ClaudeCodeAdapter {
    /// Settings en `<tmp>/opencollab`. Limpia los huérfanos de corridas viejas.
    pub fn new(receiver: Arc<HookReceiver>) -> Self {
        Self::in_dir(receiver, std::env::temp_dir().join("opencollab"))
    }

    pub fn in_dir(receiver: Arc<HookReceiver>, dir: PathBuf) -> Self {
        cleanup_stale(&dir, STALE_AFTER);
        Self {
            receiver,
            dir,
            bound: Mutex::default(),
        }
    }

    fn settings_path(&self, token: &str) -> PathBuf {
        self.dir.join(format!("{FILE_PREFIX}{token}.json"))
    }
}

/// Borra los `claude-settings-*.json` de `dir` más viejos que `max_age`.
fn cleanup_stale(dir: &Path, max_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(FILE_PREFIX) && name.ends_with(".json")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

impl AgentAdapter for ClaudeCodeAdapter {
    fn agent(&self) -> KnownAgent {
        KnownAgent::ClaudeCode
    }

    fn prepare(&self) -> Result<LaunchAugmentation, PortError> {
        // Secreto por lanzamiento: UUID v4 (aleatorio del sistema operativo).
        let token = uuid::Uuid::new_v4().simple().to_string();
        let url = format!("http://127.0.0.1:{}/hook/{token}", self.receiver.port());
        fs::create_dir_all(&self.dir)
            .map_err(|e| PortError::new(format!("no se pudo crear la carpeta temporal: {e}")))?;
        let path = self.settings_path(&token);
        fs::write(&path, settings_json(&url, HOOK_TIMEOUT_SECS))
            .map_err(|e| PortError::new(format!("no se pudo escribir los settings: {e}")))?;
        self.receiver.register(&token);
        Ok(LaunchAugmentation {
            args: vec!["--settings".into(), path.display().to_string()],
            env: Vec::new(),
            token,
        })
    }

    fn bind(&self, token: &str, terminal: TerminalId, events: Arc<dyn AgentEventSink>) {
        self.receiver.bind(token, terminal, events);
        if let Ok(mut bound) = self.bound.lock() {
            bound.insert(terminal, token.to_string());
        }
    }

    fn release(&self, terminal: TerminalId) {
        let token = self.bound.lock().ok().and_then(|mut b| b.remove(&terminal));
        if let Some(token) = token {
            self.receiver.unregister(&token);
            let _ = fs::remove_file(self.settings_path(&token));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    use application::AgentEvent;
    use serde_json::Value;

    use super::*;

    struct Recorder(Mutex<Vec<AgentEvent>>);
    impl AgentEventSink for Recorder {
        fn emit(&self, _: TerminalId, event: AgentEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("opencollab-test-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn post_status(url: &str) -> u16 {
        let rest = url.strip_prefix("http://").unwrap();
        let (addr, path) = rest.split_once('/').unwrap();
        let body = r#"{"hook_event_name":"UserPromptSubmit"}"#;
        let mut stream = TcpStream::connect(addr).unwrap();
        write!(
            stream,
            "POST /{path} HTTP/1.1\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    #[test]
    fn prepare_writes_settings_in_the_app_dir_and_passes_them_by_path() {
        let dir = temp_dir("prepare");
        let adapter = ClaudeCodeAdapter::in_dir(HookReceiver::start().unwrap(), dir.clone());
        let launch = adapter.prepare().unwrap();
        assert_eq!(launch.args[0], "--settings");
        let path = PathBuf::from(&launch.args[1]);
        assert!(path.starts_with(&dir) && path.exists());
        assert!(launch.env.is_empty());
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let url = settings["hooks"]["Stop"][0]["hooks"][0]["url"]
            .as_str()
            .unwrap();
        assert!(url.starts_with("http://127.0.0.1:") && url.ends_with(&launch.token));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn each_launch_gets_its_own_secret() {
        let dir = temp_dir("secrets");
        let adapter = ClaudeCodeAdapter::in_dir(HookReceiver::start().unwrap(), dir.clone());
        let (a, b) = (adapter.prepare().unwrap(), adapter.prepare().unwrap());
        assert_ne!(a.token, b.token);
        assert!(a.token.len() >= 32);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hooks_reach_the_bound_sink_and_release_cleans_everything() {
        let dir = temp_dir("release");
        let adapter = ClaudeCodeAdapter::in_dir(HookReceiver::start().unwrap(), dir.clone());
        let launch = adapter.prepare().unwrap();
        let path = PathBuf::from(&launch.args[1]);
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let url = settings["hooks"]["Stop"][0]["hooks"][0]["url"]
            .as_str()
            .unwrap()
            .to_string();
        let sink = Arc::new(Recorder(Mutex::default()));
        let terminal = TerminalId::new();
        adapter.bind(&launch.token, terminal, sink.clone());
        assert_eq!(post_status(&url), 200);
        assert_eq!(sink.0.lock().unwrap().len(), 1);

        adapter.release(terminal);
        assert!(!path.exists(), "el settings se borra al cerrar la terminal");
        assert_eq!(post_status(&url), 401, "el token deja de valer");
        // Cerrar otra terminal (o la misma dos veces) no rompe nada.
        adapter.release(terminal);
        adapter.release(TerminalId::new());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cleanup_removes_only_old_settings_files() {
        let dir = temp_dir("cleanup");
        let ours = dir.join(format!("{FILE_PREFIX}abc.json"));
        let other = dir.join("notes.txt");
        fs::write(&ours, "{}").unwrap();
        fs::write(&other, "x").unwrap();
        cleanup_stale(&dir, Duration::from_secs(3600));
        assert!(ours.exists(), "reciente: se conserva");
        cleanup_stale(&dir, Duration::ZERO);
        assert!(!ours.exists(), "vencido: se borra");
        assert!(other.exists(), "ajeno: nunca se toca");
        fs::remove_dir_all(dir).unwrap();
    }
}
