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
    }
  /** Client -> server: subscribe this connection to a session. */
  | { type: 'join_session'; session_id: string }
  /** Server -> client: join accepted, with the access in force right now. */
  | { type: 'joined'; session_id: string; access: AccessLevelDto };

export interface Envelope {
  version: number;
  message: Message;
}

export const INCOMPATIBLE_PROTOCOL_VERSION = '{"error":"incompatible_protocol_version"}';
export const INVALID_MESSAGE = '{"error":"invalid_message"}';
/** Also answers unknown sessions, so existence is not revealed. */
export const FORBIDDEN = '{"error":"forbidden"}';
export const NOT_JOINED = '{"error":"not_joined"}';

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isUint = (value: unknown, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

const isBytes = (value: unknown): boolean =>
  Array.isArray(value) && value.every((byte) => isUint(byte, 255));

const ACCESS_LEVELS: readonly unknown[] = ['none', 'view', 'write'];

/** Same shape check serde runs for `Message`; unknown fields are ignored. */
function isMessage(value: unknown): value is Message {
  if (!isObject(value) || !isString(value.session_id)) return false;
  switch (value.type) {
    case 'terminal_output':
      return isString(value.terminal_id) && isBytes(value.data);
    case 'terminal_input':
      return isString(value.terminal_id) && isString(value.user_id) && isBytes(value.data);
    case 'access_changed':
      return isString(value.user_id) && ACCESS_LEVELS.includes(value.access);
    case 'join_session':
      return true;
    case 'joined':
      return ACCESS_LEVELS.includes(value.access);
    default:
      return false;
  }
}

/** Equivalent of `serde_json::from_str::<Envelope>` succeeding (`version: u16`). */
function isEnvelope(value: unknown): value is Envelope {
  return isObject(value) && isUint(value.version, 0xffff) && isMessage(value.message);
}

/**
 * `JSON.parse` turns `1.0` and `1e0` into the integer 1, but serde rejects
 * them for integer fields. Every number in the wire is an integer, so a
 * number whose source text is not an integer literal becomes NaN and fails
 * the integer checks (the reviver context needs Node 21+; CI runs Node 24).
 */
function parseWire(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined && !/^-?\d+$/.test(context.source)
      ? Number.NaN
      : value,
  );
}

export type ParsedFrame = { ok: true; envelope: Envelope } | { ok: false; error: string };

/**
 * Same acceptance rules as the Rust relay: a frame that does not deserialize
 * into a complete `Envelope` is a message error and an envelope of another
 * version is a version error. Routing the accepted message is the hub's job,
 * which forwards the ORIGINAL text rather than a re-serialization.
 */
export function parseFrame(text: string): ParsedFrame {
  let parsed: unknown;
  try {
    parsed = parseWire(text);
  } catch {
    return { ok: false, error: INVALID_MESSAGE };
  }
  if (!isEnvelope(parsed)) return { ok: false, error: INVALID_MESSAGE };
  if (parsed.version !== PROTOCOL_VERSION) return { ok: false, error: INCOMPATIBLE_PROTOCOL_VERSION };
  return { ok: true, envelope: parsed };
}
