//! Casos de uso de OpenCollab y los puertos que necesitan.

pub mod agent_detection;
mod error;
pub mod ports;
mod use_cases;

pub use agent_detection::{AgentTree, KnownAgent};
pub use error::AppError;
pub use use_cases::{
    AccessChange, ChangeParticipantAccess, CloseTerminal, DetectTerminalAgents, LaunchTerminal,
    ListSubdirectories, ResizeTerminal, SendTerminalInput,
};
