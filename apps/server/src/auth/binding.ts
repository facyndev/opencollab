import { createHash } from 'node:crypto';

/**
 * Browser binding for OAuth flows. A flow start sets this cookie with a random
 * value; the signed state carries only its hash, and the callback must present
 * the cookie. A state URL forwarded to another browser (login/link CSRF) is
 * therefore useless: that browser has no matching cookie.
 */
export const BINDING_COOKIE = 'oc_oauth';
export const BINDING_TTL_SECONDS = 10 * 60; // same lifetime as the signed state
const PATH = '/auth/oauth';

export const bindingHash = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

const attributes = (secure: boolean): string =>
  `Path=${PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export const setCookie = (value: string, secure: boolean): string =>
  `${BINDING_COOKIE}=${value}; ${attributes(secure)}; Max-Age=${BINDING_TTL_SECONDS}`;

export const clearCookie = (secure: boolean): string =>
  `${BINDING_COOKIE}=; ${attributes(secure)}; Max-Age=0`;

/** Minimal Cookie header parser: returns the value of `name`, if present. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}
