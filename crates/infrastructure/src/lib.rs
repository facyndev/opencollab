//! Adaptadores concretos de los puertos definidos en `application`.

mod directory_browser;
mod hook_receiver;
mod memory_repository;
mod process_inspector;
mod pty;
mod relay_probe;
mod shell;
mod subagent_translators;

pub use directory_browser::FsDirectoryBrowser;
pub use hook_receiver::HookReceiver;
pub use memory_repository::InMemoryWorkspaceRepository;
pub use process_inspector::SysinfoProcessInspector;
pub use pty::PortablePtyAdapter;
pub use relay_probe::HttpRelayProbe;
pub use shell::default_shell_profile;
pub use subagent_translators::{ClaudeCodeTranslator, CodexTranslator, OpenCodeTranslator};
