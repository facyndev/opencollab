import { newUserId, type UserId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';

export interface UserRecord {
  readonly id: UserId;
  readonly username: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly emailVerifiedAt: Date | null;
}

export interface NewUser {
  id?: UserId;
  username: string;
  email?: string;
  emailVerifiedAt?: Date;
  displayName: string;
}

type Row = {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  emailVerifiedAt: Date | null;
};

export const toUserRecord = (row: Row): UserRecord => ({
  id: row.id as UserId,
  username: row.username,
  email: row.email,
  displayName: row.displayName,
  emailVerifiedAt: row.emailVerifiedAt,
});

export const newUserData = (user: NewUser) => ({
  id: user.id ?? newUserId(),
  username: user.username,
  email: user.email ?? null,
  emailVerifiedAt: user.emailVerifiedAt ?? null,
  displayName: user.displayName,
});

// username and email are citext columns: lookups and uniqueness ignore case.
export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(user: NewUser): Promise<UserRecord> {
    return toUserRecord(await this.prisma.user.create({ data: newUserData(user) }));
  }

  async findById(id: UserId): Promise<UserRecord | undefined> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toUserRecord(row) : undefined;
  }

  // An identifier containing `@` is an email, anything else a username. The
  // two namespaces never overlap, so a login is never ambiguous.
  async findByUsernameOrEmail(identifier: string): Promise<UserRecord | undefined> {
    // Raw SQL: the explicit ::citext cast guarantees a case-insensitive comparison.
    const rows = identifier.includes('@')
      ? await this.prisma.$queryRaw<Row[]>`
          SELECT "id", "username", "email", "displayName", "emailVerifiedAt" FROM "User"
          WHERE "email" = ${identifier}::citext LIMIT 1`
      : await this.prisma.$queryRaw<Row[]>`
          SELECT "id", "username", "email", "displayName", "emailVerifiedAt" FROM "User"
          WHERE "username" = ${identifier}::citext LIMIT 1`;
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM "User" WHERE "username" = ${username}::citext LIMIT 1`;
    return rows.length > 0;
  }

  async isEmailTaken(email: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM "User" WHERE "email" = ${email}::citext LIMIT 1`;
    return rows.length > 0;
  }
}
