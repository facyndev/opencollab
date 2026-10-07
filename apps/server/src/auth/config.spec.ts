import { describe, expect, it } from 'vitest';

import { loadAuthConfig } from './config';

const base = { JWT_SECRET: 'x'.repeat(32), DATABASE_URL: 'postgresql://u:p@h/db' };

describe('loadAuthConfig', () => {
  it('fails fast without JWT_SECRET or with a short one', () => {
    expect(() => loadAuthConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/JWT_SECRET/);
    expect(() => loadAuthConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('fails fast without DATABASE_URL', () => {
    expect(() => loadAuthConfig({ JWT_SECRET: base.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('enables only providers with both id and secret', () => {
    const cfg = loadAuthConfig({
      ...base,
      GITHUB_CLIENT_ID: 'a',
      GITHUB_CLIENT_SECRET: 'b',
      GOOGLE_CLIENT_ID: 'only-id',
    });
    expect(Object.keys(cfg.oauth)).toEqual(['github']);
    expect(cfg.rateLimitEnabled).toBe(true);
  });

  describe('TRUST_PROXY', () => {
    it('is off by default and when explicitly false or 0', () => {
      expect(loadAuthConfig(base).trustProxy).toBe(false);
      for (const value of ['', 'false', 'FALSE', '0', ' ']) {
        expect(loadAuthConfig({ ...base, TRUST_PROXY: value }).trustProxy).toBe(false);
      }
    });

    it('accepts a hop count', () => {
      expect(loadAuthConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
      expect(loadAuthConfig({ ...base, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    });

    it('accepts a list of addresses, subnets and Express presets', () => {
      expect(loadAuthConfig({ ...base, TRUST_PROXY: 'loopback, 10.0.0.0/8 ,::1,192.168.1.5' }).trustProxy).toEqual([
        'loopback',
        '10.0.0.0/8',
        '::1',
        '192.168.1.5',
      ]);
    });

    it('rejects `true` (it would trust every hop and make the client IP spoofable) and garbage', () => {
      for (const value of ['true', '-1', '1.5', 'nope', '10.0.0.0/99', '999.1.1.1', 'loopback,,']) {
        expect(() => loadAuthConfig({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
      }
    });
  });

  describe('WEB_ORIGIN', () => {
    it('defaults to the web dev server (the desktop owns 1420)', () => {
      expect(loadAuthConfig(base).webOrigin).toBe('http://localhost:1421');
    });

    it('keeps only the origin of a valid http(s) URL', () => {
      expect(loadAuthConfig({ ...base, WEB_ORIGIN: 'https://app.x.com/' }).webOrigin).toBe('https://app.x.com');
      expect(loadAuthConfig({ ...base, WEB_ORIGIN: 'https://app.x.com:8443' }).webOrigin).toBe(
        'https://app.x.com:8443',
      );
    });

    it('fails fast on anything that is not an http(s) origin', () => {
      for (const value of ['nope', 'ftp://x.com', 'javascript:alert(1)', 'https://x.com/path', 'https://u:p@x.com']) {
        expect(() => loadAuthConfig({ ...base, WEB_ORIGIN: value }), value).toThrow(/WEB_ORIGIN/);
      }
    });
  });

  it('defaults and trims PUBLIC_BASE_URL', () => {
    expect(loadAuthConfig(base).publicBaseUrl).toBe('http://127.0.0.1:8787');
    expect(loadAuthConfig({ ...base, PUBLIC_BASE_URL: 'https://api.x.com/' }).publicBaseUrl).toBe(
      'https://api.x.com',
    );
  });
});
