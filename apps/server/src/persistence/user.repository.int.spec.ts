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
