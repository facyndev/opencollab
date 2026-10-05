//! Casos de uso de OpenCollab y los puertos que necesitan.

pub mod agent_detection;
mod collab_status;
mod error;
mod hooks;
pub mod ports;
mod subagents;
mod use_cases;

pub use agent_detection::{AgentTree, KnownAgent};
pub use collab_status::{CheckRelay, RelayStatus, SessionCollaborators};
pub use error::AppError;
pub use hooks::{HookStatus, InspectHookInstallation, InstallAgentHooks, UninstallAgentHooks};
pub use subagents::{
    HookEndpoint, RawSubagentEvent, Subagent, SubagentChange, SubagentStatus, SubagentTree,
    TrackSubagents,
};
pub use use_cases::{
    AccessChange, ChangeParticipantAccess, CloseTerminal, DetectTerminalAgents, LaunchTerminal,
    ListSubdirectories, ResizeTerminal, SendTerminalInput,
};
