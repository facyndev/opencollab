use std::sync::Mutex;

use application::agent_detection::ProcessInfo;
use application::ports::{PortError, ProcessInspector};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// [`ProcessInspector`] sobre `sysinfo`. Reutiliza el mismo `System` entre
/// llamadas para que cada refresco sea incremental.
pub struct SysinfoProcessInspector {
    system: Mutex<System>,
}

impl SysinfoProcessInspector {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }
}

impl Default for SysinfoProcessInspector {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessInspector for SysinfoProcessInspector {
    fn snapshot(&self) -> Result<Vec<ProcessInfo>, PortError> {
        let mut system = self
            .system
            .lock()
            .map_err(|e| PortError::new(e.to_string()))?;
        // Solo lo que la detección usa: sin CPU, memoria ni disco.
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
        );
        Ok(system
            .processes()
            .values()
            .map(|p| ProcessInfo {
                pid: p.pid().as_u32(),
                parent: p.parent().map(|pid| pid.as_u32()),
                name: p.name().to_string_lossy().into_owned(),
                args: p
                    .cmd()
                    .iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect(),
                // sysinfo informa 0 cuando no pudo leerlo.
                started_at: Some(p.start_time()).filter(|&t| t > 0),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sees_the_current_process_and_its_parent() {
        let processes = SysinfoProcessInspector::new().snapshot().unwrap();
        let me = processes
            .iter()
            .find(|p| p.pid == std::process::id())
            .expect("el proceso del test debería aparecer");
        assert!(me.parent.is_some());
        // El proceso del test arrancó hace poco, pero ya.
        let started = me.started_at.expect("sysinfo debería informar el arranque");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(started > 0 && started <= now);
    }
}
