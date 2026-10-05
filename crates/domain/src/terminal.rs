use std::path::PathBuf;

use crate::error::DomainError;
use crate::ids::TerminalId;

/// Cómo lanzar un agente (o una shell). Agnóstico: no hay lógica específica
/// de Claude Code, Codex, etc.; cualquier CLI es un perfil.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfile {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

impl AgentProfile {
    pub fn new(name: impl Into<String>, command: impl Into<String>) -> Result<Self, DomainError> {
        let command = command.into();
        if command.trim().is_empty() {
            return Err(DomainError::EmptyCommand);
        }
        Ok(Self {
            name: name.into(),
            command,
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
        })
    }

    pub fn with_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

/// Un PTY dentro de una sesión que ejecuta un [`AgentProfile`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terminal {
    pub id: TerminalId,
    pub profile: AgentProfile,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_command() {
        assert_eq!(
            AgentProfile::new("x", "   "),
            Err(DomainError::EmptyCommand)
        );
    }
}
