//! Dominio de OpenCollab: Workspace → Session → Terminal, y las reglas de
//! acceso (Ver es el mínimo y viene activo por defecto). Sin I/O.

mod error;
mod ids;
mod invitation;
mod permission;
mod session;
mod terminal;
mod workspace;

pub use error::DomainError;
pub use ids::{InvalidId, InvitationId, SessionId, TerminalId, UserId, WorkspaceId};
pub use invitation::{Invitation, InvitationTarget};
pub use permission::AccessLevel;
pub use session::{Participant, ParticipantRole, Session, SessionGuest};
pub use terminal::{AgentProfile, Terminal};
pub use workspace::{Workspace, WorkspaceMember};
