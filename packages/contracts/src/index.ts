// Wire contract: single source of the desktop <-> relay bytes (Envelope/Message).
// Zod schemas mirror `crates/protocol` field-for-field: snake_case on the
// wire, `Vec<u8>` as a JSON number array, `version: u16`. The Rust domain
// stays authoritative for the RULES; this package owns the BYTES.
// IDs travel as UUID strings. PROTOCOL_VERSION must match the desktop.

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** snake_case on the wire, mirroring `AccessLevelDto`. */
export const accessLevelSchema = z.enum(['none', 'view', 'write']);
export type AccessLevelDto = z.infer<typeof accessLevelSchema>;

/** A `Vec<u8>` serialized as a JSON number array. */
const bytesSchema = z.array(z.number().int().min(0).max(255));

/** Equivalent of serde's `version: u16`. */
const versionSchema = z.number().int().min(0).max(0xffff);

const terminalOutputSchema = z.object({
  type: z.literal('terminal_output'),
  session_id: z.string(),
  terminal_id: z.string(),
  data: bytesSchema,
});

const terminalInputSchema = z.object({
  type: z.literal('terminal_input'),
  session_id: z.string(),
  terminal_id: z.string(),
  user_id: z.string(),
  data: bytesSchema,
});

const accessChangedSchema = z.object({
  type: z.literal('access_changed'),
  session_id: z.string(),
  user_id: z.string(),
  access: accessLevelSchema,
});

/** Client -> server: subscribe this connection to a session. */
const joinSessionSchema = z.object({
  type: z.literal('join_session'),
  session_id: z.string(),
});

/** Server -> client: join accepted, with the access in force right now. */
const joinedSchema = z.object({
  type: z.literal('joined'),
  session_id: z.string(),
  access: accessLevelSchema,
});

/** Client -> server: a fresh access token to keep the socket alive (never the refresh token). */
const reauthSchema = z.object({
  type: z.literal('reauth'),
  token: z.string(),
});

/** Server -> client: renewal accepted; `expires_at` is unix seconds. */
const reauthenticatedSchema = z.object({
  type: z.literal('reauthenticated'),
  expires_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/**
 * Same shape check serde runs for `Message`. Objects strip unknown fields,
 * so extra keys are ignored exactly like serde does.
 */
export const messageSchema = z.discriminatedUnion('type', [
  terminalOutputSchema,
  terminalInputSchema,
  accessChangedSchema,
  joinSessionSchema,
  joinedSchema,
  reauthSchema,
  reauthenticatedSchema,
]);
export type Message = z.infer<typeof messageSchema>;

/** Equivalent of `serde_json::from_str::<Envelope>` succeeding (`version: u16`). */
export const envelopeSchema = z.object({
  version: versionSchema,
  message: messageSchema,
});
export interface Envelope {
  version: number;
  message: Message;
}

export const INCOMPATIBLE_PROTOCOL_VERSION = '{"error":"incompatible_protocol_version"}';
export const INVALID_MESSAGE = '{"error":"invalid_message"}';
/** Also answers unknown sessions, so existence is not revealed. */
export const FORBIDDEN = '{"error":"forbidden"}';
export const NOT_JOINED = '{"error":"not_joined"}';
/** A `reauth` token that is invalid or belongs to another user. */
export const UNAUTHORIZED = '{"error":"unauthorized"}';

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
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) return { ok: false, error: INVALID_MESSAGE };
  if (envelope.data.version !== PROTOCOL_VERSION)
    return { ok: false, error: INCOMPATIBLE_PROTOCOL_VERSION };
  return { ok: true, envelope: envelope.data };
}
