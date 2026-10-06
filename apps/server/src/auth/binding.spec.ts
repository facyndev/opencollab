import { describe, expect, it } from 'vitest';

import { BINDING_COOKIE, bindingHash, clearCookie, readCookie, setCookie } from './binding';

describe('binding cookie', () => {
  it('reads a named cookie among others and tolerates garbage', () => {
    expect(readCookie(`a=1; ${BINDING_COOKIE}=abc_-9; b=2`, BINDING_COOKIE)).toBe('abc_-9');
    expect(readCookie(undefined, BINDING_COOKIE)).toBeUndefined();
    expect(readCookie('a=1; b', BINDING_COOKIE)).toBeUndefined();
  });

  it('sets a hardened, path-scoped, 10 minute cookie; Secure only on https', () => {
    const http = setCookie('v', false);
    expect(http).toContain(`${BINDING_COOKIE}=v`);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/auth/oauth', 'Max-Age=600']) {
      expect(http).toContain(attr);
    }
    expect(http).not.toContain('Secure');
    expect(setCookie('v', true)).toContain('Secure');
  });

  it('clears the cookie on the same path', () => {
    expect(clearCookie(false)).toContain('Max-Age=0');
    expect(clearCookie(false)).toContain('Path=/auth/oauth');
  });

  it('hashes deterministically', () => {
    expect(bindingHash('a')).toBe(bindingHash('a'));
    expect(bindingHash('a')).not.toBe(bindingHash('b'));
  });
});
