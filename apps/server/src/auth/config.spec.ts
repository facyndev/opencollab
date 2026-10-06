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

  it('defaults and trims PUBLIC_BASE_URL', () => {
    expect(loadAuthConfig(base).publicBaseUrl).toBe('http://127.0.0.1:8787');
    expect(loadAuthConfig({ ...base, PUBLIC_BASE_URL: 'https://api.x.com/' }).publicBaseUrl).toBe(
      'https://api.x.com',
    );
  });
});
