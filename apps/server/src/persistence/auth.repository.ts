import type { UserId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import type { OAuthProvider } from '../generated/prisma/enums';
import { newUserData, toUserRecord, type NewUser, type UserRecord } from './user.repository';

export type ProviderKey = 'github' | 'google';
const toDb = (p: ProviderKey): OAuthProvider => p.toUpperCase() as OAuthProvider;

export interface RefreshRow {
  readonly userId: UserId;
  readonly familyId: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

export interface NewRefreshToken {
  userId: UserId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string;
}

export interface DesktopCodeRow {
  readonly userId: UserId;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
}

export interface IdentityInput {
  provider: ProviderKey;
  providerUserId: string;
  email?: string | null;
}

/** Credentials, OAuth identities, refresh tokens and desktop login codes. */
export class AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createUserWithPassword(user: NewUser, hash: string): Promise<UserRecord> {
    const row = await this.prisma.user.create({
      data: { ...newUserData(user), password: { create: { hash } } },
    });
    return toUserRecord(row);
  }

  async createUserWithIdentity(user: NewUser, identity: IdentityInput): Promise<UserRecord> {
    const row = await this.prisma.user.create({
      data: {
        ...newUserData(user),
        oauthIdentities: {
          create: {
            provider: toDb(identity.provider),
            providerUserId: identity.providerUserId,
            email: identity.email ?? null,
          },
        },
      },
    });
    return toUserRecord(row);
  }

  async getPasswordHash(userId: UserId): Promise<string | undefined> {
    const row = await this.prisma.passwordCredential.findUnique({ where: { userId } });
    return row?.hash;
  }

  async findIdentityUser(provider: ProviderKey, providerUserId: string): Promise<UserId | undefined> {
    const row = await this.prisma.oAuthIdentity.findUnique({
      where: { provider_providerUserId: { provider: toDb(provider), providerUserId } },
    });
    return row?.userId as UserId | undefined;
  }

  /** Throws a unique-violation when the identity or the user's provider slot is taken. */
  async linkIdentity(userId: UserId, identity: IdentityInput): Promise<void> {
    await this.prisma.oAuthIdentity.create({
      data: {
        userId,
        provider: toDb(identity.provider),
        providerUserId: identity.providerUserId,
        email: identity.email ?? null,
      },
    });
  }

  async insertRefreshToken(token: NewRefreshToken): Promise<void> {
    await this.prisma.refreshToken.create({ data: { ...token, userAgent: token.userAgent ?? null } });
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshRow | undefined> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row
      ? {
          userId: row.userId as UserId,
          familyId: row.familyId,
          revokedAt: row.revokedAt,
          expiresAt: row.expiresAt,
        }
      : undefined;
  }

  /** Atomically revokes a live token; false means somebody else already did (reuse). */
  async claimRefreshToken(tokenHash: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    });
    return count === 1;
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async insertDesktopCode(row: DesktopCodeRow & { codeHash: string }): Promise<void> {
    await this.prisma.desktopLoginCode.create({ data: row });
  }

  /** Single-use: the first caller burns the code; later callers get undefined. */
  async claimDesktopCode(codeHash: string, now: Date): Promise<DesktopCodeRow | undefined> {
    const { count } = await this.prisma.desktopLoginCode.updateMany({
      where: { codeHash, usedAt: null },
      data: { usedAt: now },
    });
    if (count !== 1) return undefined;
    const row = await this.prisma.desktopLoginCode.findUniqueOrThrow({ where: { codeHash } });
    return { userId: row.userId as UserId, codeChallenge: row.codeChallenge, expiresAt: row.expiresAt };
  }
}

export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
