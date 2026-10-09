//! Dominio del desktop de OpenCollab: Session → Terminal y el nivel de acceso
//! ordenado con el que se valida el input antes de escribir en el PTY. Las
//! reglas colaborativas (workspaces, miembros, invitaciones) viven en el server;
//! acá solo se aplica el nivel que él manda. Sin I/O.

mod error;
mod ids;
mod permission;
mod session;
mod terminal;

pub use error::DomainError;
pub use ids::{InvalidId, SessionId, TerminalId, UserId};
pub use permission::AccessLevel;
pub use session::{Participant, Session};
pub use terminal::{AgentProfile, Terminal};
