import { describe, expect, it } from 'vitest';

import { classifyRefresh, classifyWebRefresh, WEB_REFRESH_GRACE_MS } from './refresh-policy';

const now = new Date('2026-01-01T00:00:00Z');
const later = new Date('2026-01-02T00:00:00Z');
const earlier = new Date('2025-12-31T00:00:00Z');

describe('classifyRefresh', () => {
  it('unknown when there is no row', () => {
    expect(classifyRefresh(undefined, now)).toBe('unknown');
  });

  it('valid when live and unexpired', () => {
    expect(classifyRefresh({ revokedAt: null, expiresAt: later }, now)).toBe('valid');
  });

  it('reuse when already revoked (even if also expired)', () => {
    expect(classifyRefresh({ revokedAt: earlier, expiresAt: later }, now)).toBe('reuse');
    expect(classifyRefresh({ revokedAt: earlier, expiresAt: earlier }, now)).toBe('reuse');
  });

  it('expired when unrevoked but past expiry (boundary included)', () => {
    expect(classifyRefresh({ revokedAt: null, expiresAt: earlier }, now)).toBe('expired');
    expect(classifyRefresh({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
  });
});

describe('classifyWebRefresh', () => {
  const rotated = (agoMs: number) => ({
    revokedAt: new Date(now.getTime() - agoMs),
    expiresAt: later,
  });

  it('behaves like classifyRefresh for unknown, valid and expired rows', () => {
    expect(classifyWebRefresh(undefined, true, now)).toBe('unknown');
    expect(classifyWebRefresh({ revokedAt: null, expiresAt: later }, true, now)).toBe('valid');
    expect(classifyWebRefresh({ revokedAt: null, expiresAt: earlier }, true, now)).toBe('expired');
  });

  it('grace for a token rotated inside the window while its family is alive', () => {
    expect(classifyWebRefresh(rotated(0), true, now)).toBe('grace');
    expect(classifyWebRefresh(rotated(WEB_REFRESH_GRACE_MS - 1), true, now)).toBe('grace');
  });

  it('reuse at and past the window edge', () => {
    expect(classifyWebRefresh(rotated(WEB_REFRESH_GRACE_MS), true, now)).toBe('reuse');
    expect(classifyWebRefresh(rotated(WEB_REFRESH_GRACE_MS + 1), true, now)).toBe('reuse');
  });

  it('reuse inside the window when the family was revoked', () => {
    expect(classifyWebRefresh(rotated(1000), false, now)).toBe('reuse');
  });

  it('reuse for a rotated token that is itself expired', () => {
    expect(classifyWebRefresh({ revokedAt: new Date(now.getTime() - 1000), expiresAt: earlier }, true, now)).toBe(
      'reuse',
    );
  });
});
