/** Subprotocol every client must offer; the token rides next to it. */
export const SUBPROTOCOL = 'opencollab.v1';

const BEARER_PREFIX = 'bearer.';

/**
 * The access token from `Sec-WebSocket-Protocol: opencollab.v1, bearer.<jwt>`.
 * Browsers cannot set an `Authorization` header on a WebSocket, so the token
 * travels as a subprotocol entry. Undefined unless the header is a single
 * well-formed value with `opencollab.v1` and exactly one non-empty bearer entry.
 */
export function bearerFromProtocols(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const entries = header.split(',').map((entry) => entry.trim());
  if (!entries.includes(SUBPROTOCOL)) return undefined;
  const bearers = entries.filter((entry) => entry.startsWith(BEARER_PREFIX));
  if (bearers.length !== 1) return undefined;
  const token = bearers[0]!.slice(BEARER_PREFIX.length);
  return token === '' ? undefined : token;
}
