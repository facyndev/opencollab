import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { newUserId } from '../domain';
import type { AuthRepository, RefreshRow } from '../persistence/auth.repository';
import type { Clock } from './clock';
import type { AuthConfig } from './config';
import { WEB_REFRESH_GRACE_MS } from './refresh-policy';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_MS, SessionService } from './session.service';
import { SessionRevocations } from './session-revocations';
import { deriveKey } from './keys';
import { hashToken } from './tokens';

const SECRET = 'a-secret-long-enough-for-tests-0123456789';
const config = { jwtSecret: SECRET } as AuthConfig;

describe('SessionService.verifyAccessClaims', () => {
  const start = new Date('2026-10-06T12:00:00Z');
  let now = start;
  const clock: Clock = { now: () => now };
  const repo = { insertRefreshToken: async () => undefined } as unknown as AuthRepository;
  const service = new SessionService(repo, config, clock, new SessionRevocations());

  it('returns the user, the expiry (unix seconds) and the refresh family of a valid token', async () => {
    now = start;
    const userId = newUserId();
    const { accessToken } = await service.issue(userId, 'family-1');
    expect(service.verifyAccessClaims(accessToken)).toEqual({
      userId,
      expiresAt: Math.floor(start.getTime() / 1000) + ACCESS_TTL_SECONDS,
      familyId: 'family-1',
    });
    expect(service.verifyAccess(accessToken)).toBe(userId);
  });

  it('still verifies a token minted before the family claim existed (no family)', () => {
    const userId = newUserId();
    const iat = Math.floor(start.getTime() / 1000);
    const legacy = jwt.sign({ sub: userId, iat, exp: iat + ACCESS_TTL_SECONDS }, deriveKey(SECRET, 'access'), {
      algorithm: 'HS256',
      audience: 'access',
    });
    now = start;
    expect(service.verifyAccessClaims(legacy)).toEqual({
      userId,
      expiresAt: iat + ACCESS_TTL_SECONDS,
    });
  });

  it('rejects expired and malformed tokens', async () => {
    now = start;
    const { accessToken } = await service.issue(newUserId());
    now = new Date(start.getTime() + (ACCESS_TTL_SECONDS + 1) * 1000);
    expect(service.verifyAccessClaims(accessToken)).toBeUndefined();
    expect(service.verifyAccessClaims('garbage')).toBeUndefined();
  });
});

describe('SessionService family revocation', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const clock: Clock = { now: () => now };

  /** In-memory refresh rows, enough to drive logout and refresh. */
  function setup() {
    const rows = new Map<string, RefreshRow>();
    const revoked: string[] = [];
    const repo = {
      insertRefreshToken: async (row: RefreshRow & { tokenHash: string }) => void rows.set(row.tokenHash, row),
      findRefreshToken: async (hash: string) => rows.get(hash),
      rotateRefreshToken: async (oldHash: string, next: RefreshRow & { tokenHash: string }) => {
        const old = rows.get(oldHash);
        if (!old || old.revokedAt) return false;
        rows.set(oldHash, { ...old, revokedAt: now });
        rows.set(next.tokenHash, next);
        return true;
      },
      revokeFamily: async (familyId: string) => void revoked.push(familyId),
    } as unknown as AuthRepository;
    const revocations = new SessionRevocations();
    const events: string[] = [];
    revocations.subscribe((familyId) => events.push(familyId));
    return { service: new SessionService(repo, config, clock, revocations), events, revoked, rows };
  }

  it('announces the family on logout, after it was revoked in storage', async () => {
    const { service, events, revoked } = setup();
    const { refreshToken } = await service.issue(newUserId(), 'fam-a');
    await service.logout(refreshToken);
    expect(revoked).toEqual(['fam-a']);
    expect(events).toEqual(['fam-a']);
  });

  it('announces nothing when logging out with an unknown token', async () => {
    const { service, events } = setup();
    await service.logout('nope'.repeat(11));
    expect(events).toEqual([]);
  });

  it('announces the family when a spent refresh token is reused', async () => {
    const { service, events } = setup();
    const first = await service.issue(newUserId(), 'fam-b');
    await service.refresh(first.refreshToken);
    expect(events).toEqual([]);
    await expect(service.refresh(first.refreshToken)).rejects.toThrow();
    expect(events).toEqual(['fam-b']);
  });

  it('keeps the family on rotated access tokens', async () => {
    const { service } = setup();
    const first = await service.issue(newUserId(), 'fam-c');
    const { tokens } = await service.refresh(first.refreshToken);
    expect(service.verifyAccessClaims(tokens.accessToken)?.familyId).toBe('fam-c');
    expect(hashToken(tokens.refreshToken)).not.toBe(hashToken(first.refreshToken));
  });
});

describe('SessionService revoked families', () => {
  const start = new Date('2026-10-06T12:00:00Z');
  let now = start;
  const clock: Clock = { now: () => now };

  function setup() {
    now = start;
    const rows = new Map<string, RefreshRow>();
    const repo = {
      insertRefreshToken: async (row: RefreshRow & { tokenHash: string }) => void rows.set(row.tokenHash, row),
      findRefreshToken: async (hash: string) => rows.get(hash),
      revokeFamily: async () => undefined,
    } as unknown as AuthRepository;
    return new SessionService(repo, config, clock, new SessionRevocations());
  }

  it('rejects a still-valid access token of a revoked family, for claims and for the HTTP guard path', async () => {
    const service = setup();
    const userId = newUserId();
    const revoked = await service.issue(userId, 'fam-r');
    const other = await service.issue(userId, 'fam-ok');
    expect(service.verifyAccess(revoked.accessToken)).toBe(userId);
    await service.logout(revoked.refreshToken);
    expect(service.verifyAccessClaims(revoked.accessToken)).toBeUndefined();
    expect(service.verifyAccess(revoked.accessToken)).toBeUndefined();
    expect(service.verifyAccess(other.accessToken)).toBe(userId);
  });

  it('rejects the family after a refresh-token reuse as well', async () => {
    const rows = new Map<string, RefreshRow>();
    const repo = {
      insertRefreshToken: async (row: RefreshRow & { tokenHash: string }) => void rows.set(row.tokenHash, row),
      findRefreshToken: async (hash: string) => rows.get(hash),
      rotateRefreshToken: async (oldHash: string, next: RefreshRow & { tokenHash: string }) => {
        const old = rows.get(oldHash);
        if (!old || old.revokedAt) return false;
        rows.set(oldHash, { ...old, revokedAt: start });
        rows.set(next.tokenHash, next);
        return true;
      },
      revokeFamily: async () => undefined,
    } as unknown as AuthRepository;
    now = start;
    const service = new SessionService(repo, config, clock, new SessionRevocations());
    const first = await service.issue(newUserId(), 'fam-reuse');
    const rotated = await service.refresh(first.refreshToken);
    await expect(service.refresh(first.refreshToken)).rejects.toThrow();
    expect(service.verifyAccessClaims(rotated.tokens.accessToken)).toBeUndefined();
  });

  it('prunes expired records when a new family is revoked, so the set stays bounded', async () => {
    const service = setup();
    for (const id of ['f1', 'f2', 'f3']) {
      const { refreshToken } = await service.issue(newUserId(), id);
      await service.logout(refreshToken);
    }
    expect(service.revokedFamilyCount()).toBe(3);
    now = new Date(start.getTime() + (ACCESS_TTL_SECONDS + 1) * 1000);
    const { refreshToken } = await service.issue(newUserId(), 'f4');
    await service.logout(refreshToken);
    expect(service.revokedFamilyCount()).toBe(1);
  });
});

describe('SessionRevocations', () => {
  it('notifies every subscriber, stops after unsubscribe and survives a throwing listener', () => {
    const revocations = new SessionRevocations();
    const seen: string[] = [];
    revocations.subscribe(() => {
      throw new Error('boom');
    });
    const off = revocations.subscribe((id) => seen.push(id));
    revocations.publish('f1');
    off();
    revocations.publish('f2');
    expect(seen).toEqual(['f1']);
  });
});

describe('SessionService web refresh (grace window) and read-only session lookup', () => {
  const start = new Date('2026-10-06T12:00:00Z');
  let now = start;
  const clock: Clock = { now: () => now };

  type Row = RefreshRow & { tokenHash: string };

  /** Stateful in-memory refresh rows: rotation stamps `revokedAt`, family revocation stamps the live ones. */
  function setup() {
    now = start;
    const rows = new Map<string, Row>();
    const repo = {
      insertRefreshToken: async (row: Row) => void rows.set(row.tokenHash, row),
      findRefreshToken: async (hash: string) => rows.get(hash),
      rotateRefreshToken: async (oldHash: string, next: Row, at: Date) => {
        const old = rows.get(oldHash);
        if (!old || old.revokedAt) return false;
        rows.set(oldHash, { ...old, revokedAt: at });
        rows.set(next.tokenHash, next);
        return true;
      },
      revokeFamily: async (familyId: string, at: Date) => {
        for (const [hash, row] of rows) {
          if (row.familyId === familyId && !row.revokedAt) rows.set(hash, { ...row, revokedAt: at });
        }
      },
      familyHasLiveToken: async (familyId: string, at: Date) =>
        [...rows.values()].some(
          (row) => row.familyId === familyId && !row.revokedAt && row.expiresAt.getTime() > at.getTime(),
        ),
    } as unknown as AuthRepository;
    return { service: new SessionService(repo, config, clock, new SessionRevocations()), rows };
  }

  it('rotates a live token normally', async () => {
    const { service } = setup();
    const userId = newUserId();
    const first = await service.issue(userId, 'fam-1');
    const result = await service.refreshWeb(first.refreshToken);
    expect(result.kind).toBe('rotated');
    expect(result.kind === 'rotated' && result.tokens.refreshToken).not.toBe(first.refreshToken);
  });

  it('inside the window a rotated token gets only an access token of the same family, and nothing rotates', async () => {
    const { service, rows } = setup();
    const userId = newUserId();
    const first = await service.issue(userId, 'fam-1');
    const winner = await service.refreshWeb(first.refreshToken);
    expect(winner.kind).toBe('rotated');
    const rowsBefore = rows.size;
    now = new Date(start.getTime() + WEB_REFRESH_GRACE_MS - 1);
    const replay = await service.refreshWeb(first.refreshToken);
    expect(replay.kind).toBe('grace');
    if (replay.kind !== 'grace') return;
    expect('refreshToken' in replay).toBe(false);
    expect(service.verifyAccessClaims(replay.accessToken)).toMatchObject({ userId, familyId: 'fam-1' });
    expect(rows.size).toBe(rowsBefore);
    // The successor the winner got is untouched and still rotates.
    expect(winner.kind === 'rotated' && (await service.refreshWeb(winner.tokens.refreshToken)).kind).toBe('rotated');
  });

  it('after the window it is reuse again: family revoked, rejected', async () => {
    const { service } = setup();
    const first = await service.issue(newUserId(), 'fam-1');
    const winner = await service.refreshWeb(first.refreshToken);
    now = new Date(start.getTime() + WEB_REFRESH_GRACE_MS);
    await expect(service.refreshWeb(first.refreshToken)).rejects.toThrow();
    expect(winner.kind === 'rotated' && service.verifyAccessClaims(winner.tokens.accessToken)).toBeUndefined();
  });

  it('inside the window but with the family revoked it is rejected', async () => {
    const { service } = setup();
    const first = await service.issue(newUserId(), 'fam-1');
    const winner = await service.refreshWeb(first.refreshToken);
    if (winner.kind !== 'rotated') throw new Error('expected rotation');
    await service.logout(winner.tokens.refreshToken);
    now = new Date(start.getTime() + 1000);
    await expect(service.refreshWeb(first.refreshToken)).rejects.toThrow();
  });

  it('the strict refresh keeps no grace', async () => {
    const { service } = setup();
    const first = await service.issue(newUserId(), 'fam-1');
    await service.refresh(first.refreshToken);
    now = new Date(start.getTime() + 1000);
    await expect(service.refresh(first.refreshToken)).rejects.toThrow();
  });

  it('a concurrent web refresh that lost the rotation gets grace instead of killing the family', async () => {
    const { service } = setup();
    const userId = newUserId();
    const first = await service.issue(userId, 'fam-1');
    const [a, b] = await Promise.all([
      service.refreshWeb(first.refreshToken),
      service.refreshWeb(first.refreshToken),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['grace', 'rotated']);
    const winner = a.kind === 'rotated' ? a : b;
    expect(winner.kind === 'rotated' && (await service.refreshWeb(winner.tokens.refreshToken)).kind).toBe('rotated');
  });

  describe('sessionUser (read-only)', () => {
    it('resolves the user of a live token without rotating it', async () => {
      const { service, rows } = setup();
      const userId = newUserId();
      const first = await service.issue(userId, 'fam-1');
      expect(await service.sessionUser(first.refreshToken)).toBe(userId);
      expect(await service.sessionUser(first.refreshToken)).toBe(userId);
      expect(rows.size).toBe(1);
      expect([...rows.values()][0]?.revokedAt).toBeFalsy();
    });

    it('is undefined for unknown, rotated, revoked-family and expired tokens', async () => {
      const { service } = setup();
      expect(await service.sessionUser('nope')).toBeUndefined();
      const first = await service.issue(newUserId(), 'fam-1');
      const next = await service.refresh(first.refreshToken);
      expect(await service.sessionUser(first.refreshToken)).toBeUndefined();
      expect(await service.sessionUser(next.tokens.refreshToken)).toBeDefined();
      await service.logout(next.tokens.refreshToken);
      expect(await service.sessionUser(next.tokens.refreshToken)).toBeUndefined();
      const other = await service.issue(newUserId(), 'fam-2');
      now = new Date(start.getTime() + REFRESH_TTL_MS);
      expect(await service.sessionUser(other.refreshToken)).toBeUndefined();
    });
  });
});
