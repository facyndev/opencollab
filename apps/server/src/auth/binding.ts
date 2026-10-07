import { createHash } from 'node:crypto';

import { STATE_TTL_SECONDS } from './state';

/**
 * Browser binding for OAuth flows. A flow start sets a cookie with a random
 * value; the signed state carries only its hash, and the callback must present
 * the cookie. A state URL forwarded to another browser (login/link CSRF) is
 * therefore useless: that browser has no matching cookie.
 *
 * The cookie is named after the flow (the state carries the flow id), so two
 * logins started in the same browser keep separate cookies instead of the
 * second overwriting the first. It lives exactly as long as the state.
 */
const COOKIE_PREFIX = 'oc_oauth_';
const PATH = '/auth/oauth';

export const bindingCookieName = (flow: string): string => `${COOKIE_PREFIX}${flow}`;

export const bindingHash = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

const attributes = (secure: boolean): string =>
  `Path=${PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export const setCookie = (flow: string, value: string, secure: boolean): string =>
  `${bindingCookieName(flow)}=${value}; ${attributes(secure)}; Max-Age=${STATE_TTL_SECONDS}`;

export const clearCookie = (flow: string, secure: boolean): string =>
  `${bindingCookieName(flow)}=; ${attributes(secure)}; Max-Age=0`;

/** Minimal Cookie header parser: returns the value of `name`, if present. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}
