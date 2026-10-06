import { describe, expect, it } from 'vitest';

import { classifyRefresh } from './refresh-policy';

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
