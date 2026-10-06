import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { PrismaClient } from '../generated/prisma/client';
import { PRISMA } from '../persistence/persistence.module';
import { openTestClient } from '../persistence/test-db';
import { AuthModule } from './auth.module';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { CLOCK, type Clock } from './clock';
import {
  OAUTH_PROVIDERS,
  type OAuthProviderPort,
  type ProviderName,
  type ProviderProfile,
} from './oauth-provider';

export class FakeProvider implements OAuthProviderPort {
  /** code -> profile the "provider" returns for it. */
  readonly profiles = new Map<string, ProviderProfile>();
  lastAuthorization?: { state: string; codeChallenge: string; redirectUri: string };
  /** When set, `exchange` rejects with it (simulates provider outages). */
  failWith?: Error;
  lastExchange?: { code: string; codeVerifier: string; redirectUri: string };

  constructor(readonly name: ProviderName) {}

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.lastAuthorization = input;
    return `https://fake.test/${this.name}/authorize?state=${encodeURIComponent(input.state)}`;
  }

  async exchange(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<ProviderProfile> {
    this.lastExchange = input;
    if (this.failWith) throw this.failWith;
    const profile = this.profiles.get(input.code);
    if (!profile) throw new Error('invalid code');
    return profile;
  }
}

export class TestClock implements Clock {
  current = new Date();
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const TEST_SECRET = 'test-secret-test-secret-test-secret-test';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaClient;
  clock: TestClock;
  github: FakeProvider;
  google: FakeProvider;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startTestApp(
  options: { rateLimitEnabled?: boolean; providers?: ProviderName[] } = {},
): Promise<TestApp> {
  const prisma = openTestClient();
  const clock = new TestClock();
  const github = new FakeProvider('github');
  const google = new FakeProvider('google');
  const enabled = options.providers ?? ['github'];
  const config: AuthConfig = {
    jwtSecret: TEST_SECRET,
    databaseUrl: 'unused',
    publicBaseUrl: 'http://api.test',
    oauth: {},
    rateLimitEnabled: options.rateLimitEnabled ?? false,
  };
  const providers = {
    ...(enabled.includes('github') ? { github } : {}),
    ...(enabled.includes('google') ? { google } : {}),
  };
  const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(PRISMA)
    .useValue(prisma)
    .overrideProvider(AUTH_CONFIG)
    .useValue(config)
    .overrideProvider(OAUTH_PROVIDERS)
    .useValue(providers)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  return {
    app,
    prisma,
    clock,
    github,
    google,
    baseUrl: await app.getUrl(),
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}
