import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newUserId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import { openTestClient, truncateAll } from './test-db';
import { UserRepository } from './user.repository';

describe('UserRepository', () => {
  let prisma: PrismaClient;
  let users: UserRepository;

  beforeAll(() => {
    prisma = openTestClient();
    users = new UserRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('creates and finds by id', async () => {
    const created = await users.create({
      username: 'Ana',
      email: 'ana@example.com',
      displayName: 'Ana P',
    });
    expect(await users.findById(created.id)).toEqual({
      id: created.id,
      username: 'Ana',
      email: 'ana@example.com',
      displayName: 'Ana P',
      emailVerifiedAt: null,
    });
  });

  it('persists the id the caller supplies', async () => {
    const id = newUserId();
    const created = await users.create({ id, username: 'bob', displayName: 'Bob' });
    expect(created.id).toBe(id);
    expect(created.email).toBeNull();
  });

  it('returns undefined for an unknown id', async () => {
    expect(await users.findById(newUserId())).toBeUndefined();
  });

  it('finds by username or email, ignoring case', async () => {
    const created = await users.create({
      username: 'Ana',
      email: 'Ana@Example.com',
      displayName: 'Ana',
    });
    expect((await users.findByUsernameOrEmail('ANA'))?.id).toBe(created.id);
    expect((await users.findByUsernameOrEmail('ana@example.COM'))?.id).toBe(created.id);
    expect(await users.findByUsernameOrEmail('nobody')).toBeUndefined();
  });

  it('treats an identifier with @ as an email only, never as a username', async () => {
    const holder = await users.create({ username: 'a@b.com', displayName: 'Odd' });
    const owner = await users.create({ username: 'real', email: 'a@b.com', displayName: 'Real' });
    expect(holder.id).not.toBe(owner.id);
    expect((await users.findByUsernameOrEmail('a@b.com'))?.id).toBe(owner.id);
  });

  it('treats an identifier without @ as a username only', async () => {
    await users.create({ username: 'other', email: 'ana@example.com', displayName: 'O' });
    expect(await users.findByUsernameOrEmail('ana')).toBeUndefined();
  });

  it('reports taken usernames and emails ignoring case', async () => {
    await users.create({ username: 'Ana', email: 'Ana@Example.com', displayName: 'A' });
    expect(await users.isUsernameTaken('aNA')).toBe(true);
    expect(await users.isUsernameTaken('bob')).toBe(false);
    expect(await users.isEmailTaken('ana@example.COM')).toBe(true);
    expect(await users.isEmailTaken('zed@example.com')).toBe(false);
  });

  it('stores emailVerifiedAt when given', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const created = await users.create({
      username: 'v',
      email: 'v@example.com',
      emailVerifiedAt: at,
      displayName: 'V',
    });
    expect(created.emailVerifiedAt).toEqual(at);
  });

  it('rejects a username that differs only by case', async () => {
    await users.create({ username: 'Ana', displayName: 'A' });
    await expect(users.create({ username: 'aNA', displayName: 'B' })).rejects.toThrow();
  });

  it('rejects an email that differs only by case', async () => {
    await users.create({ username: 'a', email: 'x@example.com', displayName: 'A' });
    await expect(
      users.create({ username: 'b', email: 'X@EXAMPLE.com', displayName: 'B' }),
    ).rejects.toThrow();
  });
});
