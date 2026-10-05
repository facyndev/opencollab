//! Adaptadores concretos de los puertos definidos en `application`.

mod directory_browser;
mod memory_repository;
mod process_inspector;
mod pty;
mod shell;
mod subagent_translators;

pub use directory_browser::FsDirectoryBrowser;
pub use memory_repository::InMemoryWorkspaceRepository;
pub use process_inspector::SysinfoProcessInspector;
pub use pty::PortablePtyAdapter;
pub use shell::default_shell_profile;
pub use subagent_translators::{ClaudeCodeTranslator, CodexTranslator, OpenCodeTranslator};
