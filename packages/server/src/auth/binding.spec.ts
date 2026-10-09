import { describe, expect, it } from 'vitest';

import { bindingCookieName, bindingHash, clearCookie, readCookie, setCookie } from './binding';
import { STATE_TTL_SECONDS } from './state';

describe('binding cookie', () => {
  it('reads a named cookie among others and tolerates garbage', () => {
    const name = bindingCookieName('f1');
    expect(readCookie(`a=1; ${name}=abc_-9; b=2`, name)).toBe('abc_-9');
    expect(readCookie(undefined, name)).toBeUndefined();
    expect(readCookie('a=1; b', name)).toBeUndefined();
  });

  it('names the cookie after the flow so simultaneous flows do not collide', () => {
    expect(bindingCookieName('f1')).not.toBe(bindingCookieName('f2'));
    expect(setCookie('f1', 'v', false)).toContain(`${bindingCookieName('f1')}=v`);
    const jar = `${bindingCookieName('f1')}=one; ${bindingCookieName('f2')}=two`;
    expect(readCookie(jar, bindingCookieName('f1'))).toBe('one');
    expect(readCookie(jar, bindingCookieName('f2'))).toBe('two');
  });

  it('sets a hardened, path-scoped cookie that lives as long as the state; Secure only on https', () => {
    const http = setCookie('f1', 'v', false);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/auth/oauth', `Max-Age=${STATE_TTL_SECONDS}`]) {
      expect(http).toContain(attr);
    }
    expect(http).not.toContain('Secure');
    expect(setCookie('f1', 'v', true)).toContain('Secure');
  });

  it('clears that flow\'s cookie on the same path', () => {
    const cleared = clearCookie('f1', false);
    expect(cleared).toContain(`${bindingCookieName('f1')}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/auth/oauth');
  });

  it('hashes deterministically', () => {
    expect(bindingHash('a')).toBe(bindingHash('a'));
    expect(bindingHash('a')).not.toBe(bindingHash('b'));
  });
});
