import { newUserId, type UserId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';

export interface UserRecord {
  readonly id: UserId;
  readonly username: string;
  readonly email: string | null;
  readonly displayName: string;
}

export interface NewUser {
  id?: UserId;
  username: string;
  email?: string;
  displayName: string;
}

type Row = { id: string; username: string; email: string | null; displayName: string };

const toRecord = (row: Row): UserRecord => ({
  id: row.id as UserId,
  username: row.username,
  email: row.email,
  displayName: row.displayName,
});

// username and email are citext columns: lookups and uniqueness ignore case.
export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(user: NewUser): Promise<UserRecord> {
    const row = await this.prisma.user.create({
      data: {
        id: user.id ?? newUserId(),
        username: user.username,
        email: user.email ?? null,
        displayName: user.displayName,
      },
    });
    return toRecord(row);
  }

  async findById(id: UserId): Promise<UserRecord | undefined> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toRecord(row) : undefined;
  }

  async findByUsernameOrEmail(identifier: string): Promise<UserRecord | undefined> {
    // Raw SQL: the explicit ::citext cast guarantees a case-insensitive comparison.
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT "id", "username", "email", "displayName" FROM "User"
      WHERE "username" = ${identifier}::citext OR "email" = ${identifier}::citext
      LIMIT 1`;
    return rows[0] ? toRecord(rows[0]) : undefined;
  }
}
