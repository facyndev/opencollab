//! Adaptadores concretos de los puertos definidos en `application`.

mod directory_browser;
mod hook_installers;
mod hook_receiver;
mod memory_repository;
mod process_inspector;
mod pty;
mod relay_probe;
mod repository_inspector;
mod session_title_translators;
mod shell;

pub use directory_browser::FsDirectoryBrowser;
pub use hook_installers::{
    AntigravityHookInstaller, ClaudeCodeHookInstaller, CodexHookInstaller, OpenCodePluginInstaller,
};
pub use hook_receiver::HookReceiver;
pub use memory_repository::InMemoryWorkspaceRepository;
pub use process_inspector::SysinfoProcessInspector;
pub use pty::PortablePtyAdapter;
pub use relay_probe::HttpRelayProbe;
pub use repository_inspector::FsRepositoryInspector;
pub use session_title_translators::{ClaudeCodeTranslator, CodexTranslator, OpenCodeTranslator};
pub use shell::default_shell_profile;
