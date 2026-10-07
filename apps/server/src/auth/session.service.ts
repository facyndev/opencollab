import { randomUUID } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';

import type { UserId } from '../domain';
import { AuthRepository, type NewRefreshToken } from '../persistence/auth.repository';
import { CLOCK, type Clock } from './clock';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { deriveKey } from './keys';
import { classifyRefresh } from './refresh-policy';
import { SessionRevocations } from './session-revocations';
import { generateToken, hashToken } from './tokens';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 3_600_000;
const AUDIENCE = 'access';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AccessClaims {
  userId: UserId;
  expiresAt: number;
  /** Refresh family the token belongs to; absent on tokens minted before the claim. */
  familyId?: string;
}

const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

@Injectable()
export class SessionService {
  private readonly key: string;

  constructor(
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(AUTH_CONFIG) config: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SessionRevocations) private readonly revocations: SessionRevocations,
  ) {
    this.key = deriveKey(config.jwtSecret, AUDIENCE);
  }

  /** Mints an access JWT plus a refresh token (new family unless rotating one). */
  async issue(userId: UserId, familyId: string = randomUUID(), userAgent?: string): Promise<TokenPair> {
    return this.mint(userId, familyId, userAgent, (row) => this.repo.insertRefreshToken(row));
  }

  private async mint(
    userId: UserId,
    familyId: string,
    userAgent: string | undefined,
    persist: (row: NewRefreshToken) => Promise<void>,
  ): Promise<TokenPair> {
    const now = this.clock.now();
    const accessToken = jwt.sign(
      { sub: userId, sid: familyId, iat: seconds(now), exp: seconds(now) + ACCESS_TTL_SECONDS },
      this.key,
      { algorithm: 'HS256', audience: AUDIENCE },
    );
    const refreshToken = generateToken();
    await persist({
      userId,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
      userAgent,
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, tokenType: 'Bearer' };
  }

  /** The user id of a valid access token, or undefined. */
  verifyAccess(token: string): UserId | undefined {
    return this.verifyAccessClaims(token)?.userId;
  }

  /**
   * The user, the expiry (unix seconds) and the refresh family (`sid`) of a
   * valid access token, or undefined. A token without `sid` (minted before the
   * claim existed) still verifies; it just has no family, so a family
   * revocation cannot reach its sockets and it lapses with its own expiry.
   */
  verifyAccessClaims(token: string): AccessClaims | undefined {
    try {
      const claims = jwt.verify(token, this.key, {
        algorithms: ['HS256'],
        audience: AUDIENCE,
        clockTimestamp: seconds(this.clock.now()),
      }) as jwt.JwtPayload;
      if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return undefined;
      return {
        userId: claims.sub as UserId,
        expiresAt: claims.exp,
        ...(typeof claims['sid'] === 'string' ? { familyId: claims['sid'] } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** Rotates a refresh token; presenting a spent one revokes its whole family. */
  async refresh(presented: string, userAgent?: string): Promise<{ userId: UserId; tokens: TokenPair }> {
    const now = this.clock.now();
    const hash = hashToken(presented);
    const row = await this.repo.findRefreshToken(hash);
    const verdict = classifyRefresh(row, now);
    if (row && verdict === 'reuse') await this.revoke(row.familyId, now);
    if (!row || verdict !== 'valid') throw new UnauthorizedException('Invalid refresh token');
    // Claim + insert are one transaction: a failed insert leaves the old token usable
    // for the client's retry. Of two concurrent rotations only one wins; the loser is a reuse.
    const tokens = await this.mint(row.userId, row.familyId, userAgent, async (next) => {
      if (!(await this.repo.rotateRefreshToken(hash, next, now))) {
        await this.revoke(row.familyId, now);
        throw new UnauthorizedException('Invalid refresh token');
      }
    });
    return { userId: row.userId, tokens };
  }

  /** Revokes the family of the presented token. Unknown tokens are a silent no-op. */
  async logout(presented: string): Promise<void> {
    const row = await this.repo.findRefreshToken(hashToken(presented));
    if (row) await this.revoke(row.familyId, this.clock.now());
  }

  /** Revokes in storage first, then tells live listeners to drop that family's sockets. */
  private async revoke(familyId: string, now: Date): Promise<void> {
    await this.repo.revokeFamily(familyId, now);
    this.revocations.publish(familyId);
  }
}
