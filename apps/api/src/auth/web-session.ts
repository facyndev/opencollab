import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { readCookie } from './binding';
import { REFRESH_TTL_MS } from './session.service';

/**
 * Web sessions keep the refresh token in an httpOnly cookie that only `/auth`
 * ever receives; the access token goes in the JSON body and lives in memory.
 * `SameSite=Strict` already withholds the cookie from cross-site requests; the
 * CSRF header below is the second layer (a cross-site form cannot set it).
 */
const COOKIE_NAME = 'oc_refresh';
export const CSRF_HEADER = 'x-opencollab-csrf';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `Secure` everywhere except plain-http local development (browsers drop it there otherwise). */
export function isSecureBase(publicBaseUrl: string): boolean {
  try {
    const url = new URL(publicBaseUrl);
    return !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return true;
  }
}

const attributes = (secure: boolean): string =>
  `Path=/auth; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

export const setRefreshCookie = (token: string, secure: boolean): string =>
  `${COOKIE_NAME}=${token}; ${attributes(secure)}; Max-Age=${Math.floor(REFRESH_TTL_MS / 1000)}`;

export const clearRefreshCookie = (secure: boolean): string =>
  `${COOKIE_NAME}=; ${attributes(secure)}; Max-Age=0`;

export const refreshCookie = (cookieHeader: string | undefined): string | undefined =>
  readCookie(cookieHeader, COOKIE_NAME);

export const hasCsrfHeader = (value: string | string[] | undefined): boolean => value === '1';

/**
 * Every route that reads or sets the web session needs the custom header: a
 * cross-site form or `<img>` cannot add it, and a cross-origin `fetch` that
 * does would need a CORS preflight, which this server never grants (CORS is
 * off by design: the web is served same-origin through a proxy).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    if (!hasCsrfHeader(req.headers[CSRF_HEADER])) throw new ForbiddenException();
    return true;
  }
}
