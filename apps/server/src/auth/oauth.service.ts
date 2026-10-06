import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { UserId } from '../domain';
import { AuthRepository, isUniqueViolation } from '../persistence/auth.repository';
import { UserRepository, type UserRecord } from '../persistence/user.repository';
import { AuthService, toUserView, type AuthResult } from './auth.service';
import { CLOCK, type Clock } from './clock';
import { AUTH_CONFIG, type AuthConfig } from './config';
import {
  OAUTH_PROVIDERS,
  isProviderName,
  type OAuthProviderPort,
  type OAuthProviders,
  type ProviderProfile,
} from './oauth-provider';
import { SessionService } from './session.service';
import { pkceVerifierFor, signState, verifyState, type OAuthState } from './state';
import { generateToken, hashToken, s256, verifyPkceS256 } from './tokens';
import { pickAvailableUsername, sanitizeUsername } from './username';

export const DESKTOP_CODE_TTL_MS = 60_000;
export const DESKTOP_CALLBACK = 'opencollab://auth/callback';

export type CallbackOutcome =
  | { kind: 'login'; result: AuthResult }
  | { kind: 'desktop'; redirectUrl: string }
  | { kind: 'linked'; provider: string };

const MAX_CREATE_ATTEMPTS = 3;

@Injectable()
export class OAuthService {
  constructor(
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProviders,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(AuthRepository) private readonly auth: AuthRepository,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** Disabled (unconfigured) and unknown providers are indistinguishable: 404. */
  private provider(name: string): OAuthProviderPort {
    const provider = isProviderName(name) ? this.providers[name] : undefined;
    if (!provider) throw new NotFoundException();
    return provider;
  }

  private redirectUri(provider: OAuthProviderPort): string {
    return `${this.config.publicBaseUrl}/auth/oauth/${provider.name}/callback`;
  }

  private authorizationUrl(
    provider: OAuthProviderPort,
    base: Omit<OAuthState, 'nonce' | 'provider'>,
  ): string {
    const nonce = randomBytes(16).toString('base64url');
    const state = signState(
      { ...base, provider: provider.name, nonce },
      this.config.jwtSecret,
      this.clock.now(),
    );
    return provider.authorizationUrl({
      state,
      codeChallenge: s256(pkceVerifierFor(this.config.jwtSecret, nonce)),
      redirectUri: this.redirectUri(provider),
    });
  }

  start(name: string, client: 'web' | 'desktop', codeChallenge?: string): string {
    const provider = this.provider(name);
    if (client === 'desktop' && !codeChallenge) {
      throw new BadRequestException('code_challenge is required for the desktop client');
    }
    return this.authorizationUrl(provider, {
      intent: 'login',
      client,
      ...(client === 'desktop' ? { codeChallenge } : {}),
    });
  }

  startLink(name: string, userId: UserId): string {
    return this.authorizationUrl(this.provider(name), {
      intent: 'link',
      client: 'web',
      linkUserId: userId,
    });
  }

  async callback(
    name: string,
    query: { code?: string; state?: string; error?: string },
    userAgent?: string,
  ): Promise<CallbackOutcome> {
    const provider = this.provider(name);
    const state = query.state
      ? verifyState(query.state, this.config.jwtSecret, this.clock.now())
      : undefined;
    if (!state || state.provider !== provider.name) throw new BadRequestException('Invalid state');
    if (query.error || !query.code) throw new BadRequestException('Authorization was not granted');

    let profile: ProviderProfile;
    try {
      profile = await provider.exchange({
        code: query.code,
        codeVerifier: pkceVerifierFor(this.config.jwtSecret, state.nonce),
        redirectUri: this.redirectUri(provider),
      });
    } catch {
      throw new BadRequestException('Could not complete the provider sign-in');
    }

    if (state.intent === 'link') return this.link(provider, state, profile);

    const user = await this.resolveUser(provider, profile);
    if (state.client === 'desktop') return this.desktopRedirect(user.id, state.codeChallenge ?? '');
    return { kind: 'login', result: await this.authService.start(user, userAgent) };
  }

  private async link(
    provider: OAuthProviderPort,
    state: OAuthState,
    profile: ProviderProfile,
  ): Promise<CallbackOutcome> {
    const userId = state.linkUserId as UserId | undefined;
    if (!userId || !(await this.users.findById(userId))) {
      throw new BadRequestException('Invalid state');
    }
    const owner = await this.auth.findIdentityUser(provider.name, profile.providerUserId);
    if (owner && owner !== userId) {
      throw new ConflictException('This account is linked to another user');
    }
    if (!owner) {
      try {
        await this.auth.linkIdentity(userId, {
          provider: provider.name,
          providerUserId: profile.providerUserId,
          email: profile.email,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Provider already linked');
        throw error;
      }
    }
    return { kind: 'linked', provider: provider.name };
  }

  /**
   * Existing identity: its user. Otherwise a NEW user, never matched by email:
   * an email match would let whoever controls a provider account (or a lax
   * provider) take over a password account.
   */
  private async resolveUser(
    provider: OAuthProviderPort,
    profile: ProviderProfile,
  ): Promise<UserRecord> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const existing = await this.auth.findIdentityUser(provider.name, profile.providerUserId);
      if (existing) {
        const user = await this.users.findById(existing);
        if (user) return user;
      }
      try {
        return await this.createUser(provider, profile);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new ConflictException('Could not create the account, try again');
  }

  private async createUser(
    provider: OAuthProviderPort,
    profile: ProviderProfile,
  ): Promise<UserRecord> {
    const base = sanitizeUsername(profile.login ?? profile.displayName ?? 'user');
    const username = await pickAvailableUsername(base, (u) => this.users.isUsernameTaken(u));
    const emailUsable =
      profile.emailVerified && !!profile.email && !(await this.users.isEmailTaken(profile.email));
    return this.auth.createUserWithIdentity(
      {
        username,
        displayName: profile.displayName ?? profile.login ?? username,
        ...(emailUsable
          ? { email: profile.email as string, emailVerifiedAt: this.clock.now() }
          : {}),
      },
      { provider: provider.name, providerUserId: profile.providerUserId, email: profile.email },
    );
  }

  private async desktopRedirect(userId: UserId, codeChallenge: string): Promise<CallbackOutcome> {
    const code = generateToken();
    await this.auth.insertDesktopCode({
      codeHash: hashToken(code),
      userId,
      codeChallenge,
      expiresAt: new Date(this.clock.now().getTime() + DESKTOP_CODE_TTL_MS),
    });
    return { kind: 'desktop', redirectUrl: `${DESKTOP_CALLBACK}?code=${encodeURIComponent(code)}` };
  }

  /** Any attempt burns the code first, so a wrong verifier cannot be retried. */
  async exchangeDesktopCode(
    code: string,
    codeVerifier: string,
    userAgent?: string,
  ): Promise<AuthResult> {
    const now = this.clock.now();
    const row = await this.auth.claimDesktopCode(hashToken(code), now);
    const user = row ? await this.users.findById(row.userId) : undefined;
    if (!row || !user || row.expiresAt <= now || !verifyPkceS256(codeVerifier, row.codeChallenge)) {
      throw new BadRequestException('Invalid or expired code');
    }
    return { user: toUserView(user), ...(await this.sessions.issue(user.id, undefined, userAgent)) };
  }
}
