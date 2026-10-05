// Wire contract: TS mirror of `crates/protocol` (Envelope/Message).
// The Rust domain stays authoritative for the RULES; this file owns the Nest
// side of the BYTES until `packages/contracts` becomes the single source.
// IDs travel as UUID strings. PROTOCOL_VERSION must match the desktop.

export const PROTOCOL_VERSION = 1;

/** snake_case on the wire, mirroring `AccessLevelDto`. */
export type AccessLevelDto = 'none' | 'view' | 'write';

export type Message =
  | {
      type: 'terminal_output';
      session_id: string;
      terminal_id: string;
      /** Vec<u8> serializes as a JSON number array. */
      data: number[];
    }
  | {
      type: 'terminal_input';
      session_id: string;
      terminal_id: string;
      user_id: string;
      data: number[];
    }
  | {
      type: 'access_changed';
      session_id: string;
      user_id: string;
      access: AccessLevelDto;
    };

export interface Envelope {
  version: number;
  message: Message;
}

export const INCOMPATIBLE_PROTOCOL_VERSION = '{"error":"incompatible_protocol_version"}';
export const INVALID_MESSAGE = '{"error":"invalid_message"}';

function isCompatibleEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { version?: unknown }).version === PROTOCOL_VERSION;
}

/**
 * Reply semantics, mirroring the Rust relay exactly: a compatible envelope
 * echoes back byte-identically (the ORIGINAL text, not re-serialized), any
 * other version gets the version error, and unparsable input gets the
 * message error.
 */
export function replyForTextFrame(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return INVALID_MESSAGE;
  }
  return isCompatibleEnvelope(parsed) ? text : INCOMPATIBLE_PROTOCOL_VERSION;
}
