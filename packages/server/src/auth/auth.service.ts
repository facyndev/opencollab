import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import type { UserId } from '../domain';
import { AuthRepository, isUniqueViolation } from '../persistence/auth.repository';
import { UserRepository, type UserRecord } from '../persistence/user.repository';
import { PasswordService } from './password.service';
import { SessionService, type TokenPair } from './session.service';

export interface UserView {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  emailVerifiedAt: string | null;
}

export type WebRefreshOutcome =
  | { kind: 'rotated'; tokens: TokenPair }
  | { kind: 'grace'; access: Omit<TokenPair, 'refreshToken'> };

export type AuthResult = { user: UserView } & TokenPair;

export const toUserView = (u: UserRecord): UserView => ({
  id: u.id,
  username: u.username,
  email: u.email,
  displayName: u.displayName,
  emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
});

const BAD_CREDENTIALS = 'Invalid credentials';

@Injectable()
export class AuthService {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(AuthRepository) private readonly auth: AuthRepository,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async register(
    input: { username: string; email?: string; password: string; displayName?: string },
    userAgent?: string,
  ): Promise<AuthResult> {
    if (await this.users.isUsernameTaken(input.username)) {
      throw new ConflictException('Username already taken');
    }
    if (input.email && (await this.users.isEmailTaken(input.email))) {
      throw new ConflictException('Email already registered');
    }
    const hash = await this.passwords.hash(input.password);
    try {
      const user = await this.auth.createUserWithPassword(
        {
          username: input.username,
          email: input.email,
          displayName: input.displayName ?? input.username,
        },
        hash,
      );
      return await this.start(user, userAgent);
    } catch (error) {
      // Lost a race against a concurrent signup.
      if (isUniqueViolation(error)) throw new ConflictException('Username or email already taken');
      throw error;
    }
  }

  async login(identifier: string, password: string, userAgent?: string): Promise<AuthResult> {
    const user = await this.users.findByUsernameOrEmail(identifier);
    const hash = user ? await this.auth.getPasswordHash(user.id) : undefined;
    if (!user || !hash) {
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    if (!(await this.passwords.verify(hash, password))) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    return this.start(user, userAgent);
  }

  async refresh(refreshToken: string, userAgent?: string): Promise<TokenPair> {
    return (await this.sessions.refresh(refreshToken, userAgent)).tokens;
  }

  /** Web refresh: like `refresh`, but a just-rotated token (second tab) gets only an access token. */
  async refreshWeb(refreshToken: string, userAgent?: string): Promise<WebRefreshOutcome> {
    const result = await this.sessions.refreshWeb(refreshToken, userAgent);
    if (result.kind === 'rotated') return { kind: 'rotated', tokens: result.tokens };
    const { kind: _kind, userId: _userId, ...access } = result;
    return { kind: 'grace', access };
  }

  /** The user holding a live web session, read without rotating its refresh token. */
  sessionUser(refreshToken: string): Promise<UserId | undefined> {
    return this.sessions.sessionUser(refreshToken);
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.logout(refreshToken);
  }

  findUser(id: UserId): Promise<UserRecord | undefined> {
    return this.users.findById(id);
  }

  /** Opens a session (new refresh family) for an authenticated user. */
  async start(user: UserRecord, userAgent?: string): Promise<AuthResult> {
    return { user: toUserView(user), ...(await this.sessions.issue(user.id, undefined, userAgent)) };
  }
}
