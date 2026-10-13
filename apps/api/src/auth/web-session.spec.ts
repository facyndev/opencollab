import { describe, expect, it } from 'vitest';

import { REFRESH_TTL_MS } from './session.service';
import {
  CSRF_HEADER,
  clearRefreshCookie,
  hasCsrfHeader,
  isSecureBase,
  refreshCookie,
  setRefreshCookie,
} from './web-session';

describe('refresh cookie', () => {
  it('is httpOnly, strict, scoped to /auth and lives as long as the refresh token', () => {
    const header = setRefreshCookie('tok', true);
    for (const attr of ['oc_refresh=tok', 'HttpOnly', 'SameSite=Strict', 'Path=/auth', 'Secure']) {
      expect(header).toContain(attr);
    }
    expect(header).toContain(`Max-Age=${REFRESH_TTL_MS / 1000}`);
  });

  it('drops Secure only for plain-http local development', () => {
    expect(setRefreshCookie('tok', false)).not.toContain('Secure');
    expect(isSecureBase('https://api.x.com')).toBe(true);
    expect(isSecureBase('http://api.x.com')).toBe(true);
    for (const local of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      expect(isSecureBase(local), local).toBe(false);
    }
  });

  it('is expired by clearRefreshCookie with the same scope', () => {
    const header = clearRefreshCookie(true);
    for (const attr of ['oc_refresh=;', 'Max-Age=0', 'Path=/auth', 'HttpOnly', 'SameSite=Strict']) {
      expect(header).toContain(attr);
    }
  });

  it('reads the token from a Cookie header', () => {
    expect(refreshCookie('a=1; oc_refresh=abc; b=2')).toBe('abc');
    expect(refreshCookie('a=1')).toBeUndefined();
    expect(refreshCookie(undefined)).toBeUndefined();
  });
});

describe('CSRF header', () => {
  it('requires the exact marker value', () => {
    expect(CSRF_HEADER).toBe('x-opencollab-csrf');
    expect(hasCsrfHeader('1')).toBe(true);
    for (const bad of [undefined, '', '0', 'true', ['1', '1']]) expect(hasCsrfHeader(bad)).toBe(false);
  });
});
