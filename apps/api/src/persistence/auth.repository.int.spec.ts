import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/prisma/client';
import { AuthRepository } from './auth.repository';
import { openTestClient, truncateAll } from './test-db';
import { UserRepository } from './user.repository';

describe('AuthRepository.rotateRefreshToken', () => {
  let prisma: PrismaClient;
  let repo: AuthRepository;
  let userId: Awaited<ReturnType<UserRepository['create']>>['id'];
  const FAMILY = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
  const now = new Date('2026-01-01T00:00:00Z');
  const expiresAt = new Date('2026-02-01T00:00:00Z');

  beforeAll(() => {
    prisma = openTestClient();
    repo = new AuthRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await truncateAll(prisma);
    userId = (await new UserRepository(prisma).create({ username: 'ana', displayName: 'Ana' })).id;
    await repo.insertRefreshToken({ userId, familyId: FAMILY, tokenHash: 'old', expiresAt });
  });

  it('revokes the old token and stores the new one together', async () => {
    const ok = await repo.rotateRefreshToken('old', { userId, familyId: FAMILY, tokenHash: 'new', expiresAt }, now);
    expect(ok).toBe(true);
    expect((await repo.findRefreshToken('old'))?.revokedAt).toEqual(now);
    expect((await repo.findRefreshToken('new'))?.revokedAt).toBeNull();
  });

  it('returns false and stores nothing when the old token was already spent', async () => {
    await repo.rotateRefreshToken('old', { userId, familyId: FAMILY, tokenHash: 'new', expiresAt }, now);
    const again = await repo.rotateRefreshToken('old', { userId, familyId: FAMILY, tokenHash: 'new2', expiresAt }, now);
    expect(again).toBe(false);
    expect(await repo.findRefreshToken('new2')).toBeUndefined();
  });

  it('is all-or-nothing: a failing insert leaves the old token valid and the family intact', async () => {
    // Re-using an existing hash makes the INSERT fail after the claim succeeded.
    await expect(
      repo.rotateRefreshToken('old', { userId, familyId: FAMILY, tokenHash: 'old', expiresAt }, now),
    ).rejects.toThrow();
    expect((await repo.findRefreshToken('old'))?.revokedAt).toBeNull();
    expect(await prisma.refreshToken.count({ where: { revokedAt: { not: null } } })).toBe(0);
  });
});

describe('AuthRepository.familyHasLiveToken', () => {
  let prisma: PrismaClient;
  let repo: AuthRepository;
  const FAMILY = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
  const now = new Date('2026-01-01T00:00:00Z');
  const expiresAt = new Date('2026-02-01T00:00:00Z');
  let userId: Awaited<ReturnType<UserRepository['create']>>['id'];

  beforeAll(() => {
    prisma = openTestClient();
    repo = new AuthRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await truncateAll(prisma);
    userId = (await new UserRepository(prisma).create({ username: 'ana', displayName: 'Ana' })).id;
    await repo.insertRefreshToken({ userId, familyId: FAMILY, tokenHash: 'old', expiresAt });
  });

  it('is true while a token of the family is live, also after a rotation', async () => {
    expect(await repo.familyHasLiveToken(FAMILY, now)).toBe(true);
    await repo.rotateRefreshToken('old', { userId, familyId: FAMILY, tokenHash: 'new', expiresAt }, now);
    expect(await repo.familyHasLiveToken(FAMILY, now)).toBe(true);
  });

  it('is false once the family is revoked, for an unknown family and when every token expired', async () => {
    await repo.rotateRefreshToken('old', { userId, familyId: FAMILY, tokenHash: 'new', expiresAt }, now);
    expect(await repo.familyHasLiveToken(FAMILY, expiresAt)).toBe(false);
    await repo.revokeFamily(FAMILY, now);
    expect(await repo.familyHasLiveToken(FAMILY, now)).toBe(false);
    expect(await repo.familyHasLiveToken('00000000-0000-4000-8000-000000000000', now)).toBe(false);
  });
});
