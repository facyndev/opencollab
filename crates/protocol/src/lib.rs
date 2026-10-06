//! Mensajes del wire entre desktop y relay.
//!
//! No contiene tipos de dominio: los IDs viajan como strings (UUID) y los
//! adaptadores traducen hacia/desde el dominio. Todo mensaje viaja dentro de
//! un [`Envelope`] con la versión del protocolo.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;

/// Dirección donde escucha el relay por defecto. El relay y el desktop la usan
/// (ambos pisables con `RELAY_ADDR`), así que cambiarla es una sola línea.
pub const DEFAULT_RELAY_ADDR: &str = "127.0.0.1:8787";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub version: u16,
    pub message: Message,
}

impl Envelope {
    pub fn new(message: Message) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            message,
        }
    }

    pub fn is_compatible(&self) -> bool {
        self.version == PROTOCOL_VERSION
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessLevelDto {
    None,
    View,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// Salida de una terminal del host hacia los participantes.
    TerminalOutput {
        session_id: String,
        terminal_id: String,
        data: Vec<u8>,
    },
    /// Input de un participante hacia la terminal del host.
    TerminalInput {
        session_id: String,
        terminal_id: String,
        user_id: String,
        data: Vec<u8>,
    },
    /// El dueño cambió el acceso de un participante.
    AccessChanged {
        session_id: String,
        user_id: String,
        access: AccessLevelDto,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_as_tagged_json() {
        let envelope = Envelope::new(Message::AccessChanged {
            session_id: "s".into(),
            user_id: "u".into(),
            access: AccessLevelDto::View,
        });
        let json = serde_json::to_string(&envelope).unwrap();
        assert!(json.contains(r#""type":"access_changed""#));
        assert!(json.contains(r#""access":"view""#));
        let back: Envelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, envelope);
        assert!(back.is_compatible());
    }

    #[test]
    fn rejects_other_versions() {
        let json = r#"{"version":999,"message":{"type":"terminal_output","session_id":"s","terminal_id":"t","data":[104,105]}}"#;
        let envelope: Envelope = serde_json::from_str(json).unwrap();
        assert!(!envelope.is_compatible());
    }
}
