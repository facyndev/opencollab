import { describe, expect, it } from 'vitest';

import { newUserId } from '../domain';
import type { AuthRepository } from '../persistence/auth.repository';
import type { Clock } from './clock';
import type { AuthConfig } from './config';
import { ACCESS_TTL_SECONDS, SessionService } from './session.service';

describe('SessionService.verifyAccessClaims', () => {
  const start = new Date('2026-10-06T12:00:00Z');
  let now = start;
  const clock: Clock = { now: () => now };
  const repo = { insertRefreshToken: async () => undefined } as unknown as AuthRepository;
  const service = new SessionService(repo, { jwtSecret: 'a-secret-long-enough-for-tests-0123456789' } as AuthConfig, clock);

  it('returns the user and the expiry (unix seconds) of a valid token', async () => {
    now = start;
    const userId = newUserId();
    const { accessToken } = await service.issue(userId);
    expect(service.verifyAccessClaims(accessToken)).toEqual({
      userId,
      expiresAt: Math.floor(start.getTime() / 1000) + ACCESS_TTL_SECONDS,
    });
    expect(service.verifyAccess(accessToken)).toBe(userId);
  });

  it('rejects expired and malformed tokens', async () => {
    now = start;
    const { accessToken } = await service.issue(newUserId());
    now = new Date(start.getTime() + (ACCESS_TTL_SECONDS + 1) * 1000);
    expect(service.verifyAccessClaims(accessToken)).toBeUndefined();
    expect(service.verifyAccessClaims('garbage')).toBeUndefined();
  });
});
