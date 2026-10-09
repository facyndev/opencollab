//! Casos de uso de OpenCollab y los puertos que necesitan.

mod activity;
pub mod agent_adapter;
pub mod agent_detection;
pub mod agent_event;
pub mod agent_state;
mod collab_status;
mod error;
pub mod git;
pub mod ports;
mod use_cases;

pub use activity::{Activity, ActivityTracker};
pub use agent_adapter::{
    activity_event, exit_event, AgentAdapter, AgentAdapters, AgentEventSink, AgentStates,
    LaunchAugmentation, PreparedLaunch,
};
pub use agent_detection::{AgentTree, KnownAgent};
pub use agent_event::{AgentEvent, AgentStatus};
pub use agent_state::AgentState;
pub use collab_status::{CheckRelay, RelayStatus, SessionCollaborators};
pub use error::AppError;
pub use git::Branch;
pub use use_cases::{
    ApplyAccessLevel, CloseTerminal, DetectTerminalAgents, InspectBranch, LaunchTerminal,
    ListSubdirectories, ResizeTerminal, SendTerminalInput,
};
