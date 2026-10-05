//! Casos de uso de OpenCollab y los puertos que necesitan.

mod activity;
pub mod agent_detection;
mod agent_session;
mod error;
mod hooks;
pub mod ports;
mod use_cases;

pub use activity::{Activity, ActivityTracker};
pub use agent_detection::{AgentTree, KnownAgent};
pub use agent_session::{HookEndpoint, RawSessionEvent, TrackAgentSessionTitle};
pub use error::AppError;
pub use hooks::{HookStatus, InspectHookInstallation, InstallAgentHooks, UninstallAgentHooks};
pub use use_cases::{
    AccessChange, ChangeParticipantAccess, CloseTerminal, DetectTerminalAgents, LaunchTerminal,
    ListSubdirectories, ResizeTerminal, SendTerminalInput,
};
