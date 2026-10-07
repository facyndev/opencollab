import { randomUUID } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';

import type { UserId } from '../domain';
import { AuthRepository, type NewRefreshToken } from '../persistence/auth.repository';
import { CLOCK, type Clock } from './clock';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { deriveKey } from './keys';
import { classifyRefresh, classifyWebRefresh } from './refresh-policy';
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

export type WebRefreshResult =
  | { kind: 'rotated'; userId: UserId; tokens: TokenPair }
  | ({ kind: 'grace'; userId: UserId } & Omit<TokenPair, 'refreshToken'>);

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
  /**
   * Revoked refresh families -> when the record may be dropped (their newest
   * access token has expired by then). Per process: a multi-instance deploy
   * would need a shared store for this.
   */
  private readonly revokedFamilies = new Map<string, number>();

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

  private signAccess(userId: UserId, familyId: string, now: Date) {
    const accessToken = jwt.sign(
      { sub: userId, sid: familyId, iat: seconds(now), exp: seconds(now) + ACCESS_TTL_SECONDS },
      this.key,
      { algorithm: 'HS256', audience: AUDIENCE },
    );
    return { accessToken, expiresIn: ACCESS_TTL_SECONDS, tokenType: 'Bearer' as const };
  }

  /** The user id of a valid access token, or undefined. */
  verifyAccess(token: string): UserId | undefined {
    return this.verifyAccessClaims(token)?.userId;
  }

  /**
   * The user, the expiry (unix seconds) and the refresh family (`sid`) of a
   * valid access token, or undefined. A token without `sid` (minted before the
   * claim existed) still verifies; it just has no family, so a family
   * revocation cannot reach its sockets and it lapses with its own expiry. A
   * token whose family was revoked is rejected even before its `exp`.
   */
  verifyAccessClaims(token: string): AccessClaims | undefined {
    try {
      const claims = jwt.verify(token, this.key, {
        algorithms: ['HS256'],
        audience: AUDIENCE,
        clockTimestamp: seconds(this.clock.now()),
      }) as jwt.JwtPayload;
      if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return undefined;
      const familyId = claims['sid'];
      if (typeof familyId === 'string' && this.isRevoked(familyId, this.clock.now().getTime())) return undefined;
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
    const result = await this.rotate(presented, userAgent, false);
    if (result.kind !== 'rotated') throw new UnauthorizedException('Invalid refresh token');
    return { userId: result.userId, tokens: result.tokens };
  }

  /**
   * Web variant of `refresh`: a token rotated less than `WEB_REFRESH_GRACE_MS` ago
   * (a second tab sharing the cookie) gets only a fresh access token of the same
   * family. Nothing rotates and no refresh token is returned, so a replay inside
   * the window never yields one; the browser already holds the successor.
   */
  async refreshWeb(presented: string, userAgent?: string): Promise<WebRefreshResult> {
    const result = await this.rotate(presented, userAgent, true);
    if (result.kind === 'invalid') throw new UnauthorizedException('Invalid refresh token');
    return result;
  }

  /**
   * The user behind a live refresh token (exists, unrevoked, unexpired, family
   * alive), without rotating or touching it. For routes that only need to know
   * who holds the web session.
   */
  async sessionUser(presented: string): Promise<UserId | undefined> {
    const row = await this.repo.findRefreshToken(hashToken(presented));
    return classifyRefresh(row, this.clock.now()) === 'valid' ? row?.userId : undefined;
  }

  private async rotate(
    presented: string,
    userAgent: string | undefined,
    grace: boolean,
  ): Promise<WebRefreshResult | { kind: 'invalid' }> {
    const now = this.clock.now();
    const hash = hashToken(presented);
    const row = await this.repo.findRefreshToken(hash);
    const verdict = grace
      ? classifyWebRefresh(row, row ? await this.repo.familyHasLiveToken(row.familyId, now) : false, now)
      : classifyRefresh(row, now);
    if (row && verdict === 'grace') return this.graceAccess(row.userId, row.familyId, now);
    if (row && verdict === 'reuse') await this.revoke(row.familyId, now);
    if (!row || verdict !== 'valid') return { kind: 'invalid' };
    // Claim + insert are one transaction: a failed insert leaves the old token usable
    // for the client's retry. Of two concurrent rotations only one wins; the loser is a reuse.
    let lost = false;
    const tokens = await this.mint(row.userId, row.familyId, userAgent, async (next) => {
      if (!(await this.repo.rotateRefreshToken(hash, next, now))) {
        lost = true;
        // On the web the loser is just a second tab: the winner's successor must survive.
        if (!grace) await this.revoke(row.familyId, now);
        throw new UnauthorizedException('Invalid refresh token');
      }
    }).catch((error: unknown) => {
      if (lost && grace) return undefined;
      throw error;
    });
    if (tokens) return { kind: 'rotated', userId: row.userId, tokens };
    // The loser gets grace only under the same rule as a replay: the family must still be alive
    // (a logout racing the claim must not hand out a fresh access token).
    if (!(await this.repo.familyHasLiveToken(row.familyId, now))) return { kind: 'invalid' };
    return this.graceAccess(row.userId, row.familyId, now);
  }

  private graceAccess(userId: UserId, familyId: string, now: Date): WebRefreshResult {
    return { kind: 'grace', userId, ...this.signAccess(userId, familyId, now) };
  }

  /** Revokes the family of the presented token. Unknown tokens are a silent no-op. */
  async logout(presented: string): Promise<void> {
    const row = await this.repo.findRefreshToken(hashToken(presented));
    if (row) await this.revoke(row.familyId, this.clock.now());
  }

  /** Revokes in storage first, then tells live listeners to drop that family's sockets. */
  private async revoke(familyId: string, now: Date): Promise<void> {
    await this.repo.revokeFamily(familyId, now);
    this.prune(now.getTime());
    // Access tokens of this family are still valid until their `exp`: remember the
    // revocation for as long as the newest of them can live.
    this.revokedFamilies.set(familyId, now.getTime() + ACCESS_TTL_SECONDS * 1000);
    this.revocations.publish(familyId);
  }

  /** Number of revoked families still remembered (bounded by access-token lifetime). */
  revokedFamilyCount(): number {
    return this.revokedFamilies.size;
  }

  private isRevoked(familyId: string, nowMs: number): boolean {
    return (this.revokedFamilies.get(familyId) ?? 0) > nowMs;
  }

  private prune(nowMs: number): void {
    for (const [familyId, until] of this.revokedFamilies) {
      if (until <= nowMs) this.revokedFamilies.delete(familyId);
    }
  }
}
