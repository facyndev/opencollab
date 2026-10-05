//! Instalación de los hooks / plugins que cada agente usa para reportar el
//! título de su sesión. Los casos de uso solo orquestan los puertos [`HookInstaller`];
//! tocar la configuración de cada agente es trabajo de la infraestructura.

use std::sync::Arc;

use crate::agent_detection::KnownAgent;
use crate::error::AppError;
use crate::ports::{HookInstaller, PortError};

/// Estado de la integración de OpenCollab en la configuración de un agente.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookStatus {
    /// El agente no ofrece un mecanismo para reportar el título de sesión.
    Unsupported,
    /// Nuestras entradas no están (o están desactualizadas).
    NotInstalled,
    /// Nuestras entradas están presentes y al día.
    Installed,
}

/// Consulta el estado de la integración de todos los agentes.
pub struct InspectHookInstallation {
    installers: Vec<Arc<dyn HookInstaller>>,
}

impl InspectHookInstallation {
    pub fn new(installers: Vec<Arc<dyn HookInstaller>>) -> Self {
        Self { installers }
    }

    /// Un resultado por instalador: el fallo de uno no oculta a los demás.
    pub fn execute(&self) -> Vec<(KnownAgent, Result<HookStatus, PortError>)> {
        self.installers
            .iter()
            .map(|i| (i.agent(), i.status()))
            .collect()
    }
}

/// Instala los hooks de un agente (siempre tras confirmación del usuario).
pub struct InstallAgentHooks {
    installers: Vec<Arc<dyn HookInstaller>>,
}

impl InstallAgentHooks {
    pub fn new(installers: Vec<Arc<dyn HookInstaller>>) -> Self {
        Self { installers }
    }

    pub fn execute(&self, agent: KnownAgent) -> Result<(), AppError> {
        Ok(find(&self.installers, agent)?.install()?)
    }
}

/// Quita los hooks de un agente, dejando su configuración como estaba.
pub struct UninstallAgentHooks {
    installers: Vec<Arc<dyn HookInstaller>>,
}

impl UninstallAgentHooks {
    pub fn new(installers: Vec<Arc<dyn HookInstaller>>) -> Self {
        Self { installers }
    }

    pub fn execute(&self, agent: KnownAgent) -> Result<(), AppError> {
        Ok(find(&self.installers, agent)?.uninstall()?)
    }
}

fn find(
    installers: &[Arc<dyn HookInstaller>],
    agent: KnownAgent,
) -> Result<&Arc<dyn HookInstaller>, AppError> {
    installers
        .iter()
        .find(|i| i.agent() == agent)
        .ok_or(AppError::NoHookInstaller(agent))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct FakeInstaller {
        agent: KnownAgent,
        installed: Mutex<bool>,
        fail: bool,
    }

    impl FakeInstaller {
        fn new(agent: KnownAgent) -> Arc<Self> {
            Arc::new(Self {
                agent,
                installed: Mutex::new(false),
                fail: false,
            })
        }
        fn failing(agent: KnownAgent) -> Arc<Self> {
            Arc::new(Self {
                agent,
                installed: Mutex::new(false),
                fail: true,
            })
        }
    }

    impl HookInstaller for FakeInstaller {
        fn agent(&self) -> KnownAgent {
            self.agent
        }
        fn status(&self) -> Result<HookStatus, PortError> {
            if self.fail {
                return Err(PortError::new("config ilegible"));
            }
            Ok(if *self.installed.lock().unwrap() {
                HookStatus::Installed
            } else {
                HookStatus::NotInstalled
            })
        }
        fn install(&self) -> Result<(), PortError> {
            *self.installed.lock().unwrap() = true;
            Ok(())
        }
        fn uninstall(&self) -> Result<(), PortError> {
            *self.installed.lock().unwrap() = false;
            Ok(())
        }
    }

    #[test]
    fn inspect_reports_every_installer_even_if_one_fails() {
        let inspect = InspectHookInstallation::new(vec![
            FakeInstaller::new(KnownAgent::ClaudeCode),
            FakeInstaller::failing(KnownAgent::Codex),
        ]);
        let result = inspect.execute();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, KnownAgent::ClaudeCode);
        assert_eq!(result[0].1, Ok(HookStatus::NotInstalled));
        assert_eq!(result[1].0, KnownAgent::Codex);
        assert!(result[1].1.is_err());
    }

    #[test]
    fn install_then_uninstall_changes_status() {
        let installer = FakeInstaller::new(KnownAgent::OpenCode);
        let installers: Vec<Arc<dyn HookInstaller>> = vec![installer.clone()];
        InstallAgentHooks::new(installers.clone())
            .execute(KnownAgent::OpenCode)
            .unwrap();
        assert_eq!(installer.status(), Ok(HookStatus::Installed));
        UninstallAgentHooks::new(installers)
            .execute(KnownAgent::OpenCode)
            .unwrap();
        assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
    }

    #[test]
    fn install_only_touches_the_requested_agent() {
        let claude = FakeInstaller::new(KnownAgent::ClaudeCode);
        let codex = FakeInstaller::new(KnownAgent::Codex);
        InstallAgentHooks::new(vec![claude.clone(), codex.clone()])
            .execute(KnownAgent::Codex)
            .unwrap();
        assert_eq!(claude.status(), Ok(HookStatus::NotInstalled));
        assert_eq!(codex.status(), Ok(HookStatus::Installed));
    }

    #[test]
    fn unknown_agent_is_an_error() {
        let install = InstallAgentHooks::new(vec![FakeInstaller::new(KnownAgent::Codex)]);
        assert_eq!(
            install.execute(KnownAgent::ClaudeCode),
            Err(AppError::NoHookInstaller(KnownAgent::ClaudeCode))
        );
        let uninstall = UninstallAgentHooks::new(vec![]);
        assert_eq!(
            uninstall.execute(KnownAgent::Codex),
            Err(AppError::NoHookInstaller(KnownAgent::Codex))
        );
    }

    #[test]
    fn installer_failure_propagates_as_port_error() {
        struct Broken;
        impl HookInstaller for Broken {
            fn agent(&self) -> KnownAgent {
                KnownAgent::Codex
            }
            fn status(&self) -> Result<HookStatus, PortError> {
                Ok(HookStatus::Unsupported)
            }
            fn install(&self) -> Result<(), PortError> {
                Err(PortError::new("no soportado"))
            }
            fn uninstall(&self) -> Result<(), PortError> {
                Err(PortError::new("no soportado"))
            }
        }
        let install = InstallAgentHooks::new(vec![Arc::new(Broken)]);
        assert_eq!(
            install.execute(KnownAgent::Codex),
            Err(AppError::Port(PortError::new("no soportado")))
        );
    }
}
