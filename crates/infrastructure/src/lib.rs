//! Adaptadores concretos de los puertos definidos en `application`.

mod agent_launch;
mod claude_adapter;
mod claude_hooks;
mod directory_browser;
mod hook_receiver;
mod memory_repository;
mod process_inspector;
mod pty;
mod relay_probe;
mod repository_inspector;
mod shell;

pub use agent_launch::{agent_shell_profile, command_exists};
pub use claude_adapter::ClaudeCodeAdapter;
pub use directory_browser::FsDirectoryBrowser;
pub use hook_receiver::HookReceiver;
pub use memory_repository::InMemoryWorkspaceRepository;
pub use process_inspector::SysinfoProcessInspector;
pub use pty::PortablePtyAdapter;
pub use relay_probe::HttpRelayProbe;
pub use repository_inspector::FsRepositoryInspector;
pub use shell::default_shell_profile;
