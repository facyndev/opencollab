import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';

import { AUTH_CONFIG, type AuthConfig } from './auth/config';
import { applyHttpConfig } from './auth/http-config';
import { CLOCK } from './auth/clock';
import { OAUTH_PROVIDERS } from './auth/oauth-provider';
import { TestClock } from './auth/test-app';
import { PRISMA } from './persistence/persistence.module';
import { openTestClient } from './persistence/test-db';
import type { PrismaClient } from './generated/prisma/client';
import { AppModule } from './app.module';

// Boots the REAL AppModule (not the CollabModule-only test app) to prove the
// collab REST surface is wired into the production module graph and that its
// routes stay behind AccessGuard (S14: unauthenticated -> 401, not 404).
describe('AppModule collab route wiring (int)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    prisma = openTestClient();
    const config: AuthConfig = {
      jwtSecret: 'test-secret-test-secret-test-secret-test',
      databaseUrl: 'unused',
      publicBaseUrl: 'http://api.test',
      webOrigin: 'http://web.test',
      oauth: {},
      rateLimitEnabled: false,
      trustProxy: false,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRISMA)
      .useValue(prisma)
      .overrideProvider(AUTH_CONFIG)
      .useValue(config)
      .overrideProvider(OAUTH_PROVIDERS)
      .useValue({})
      .overrideProvider(CLOCK)
      .useValue(new TestClock())
      .compile();
    app = moduleRef.createNestApplication();
    applyHttpConfig(app, config);
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function statusOf(method: string, path: string): Promise<number> {
    const res = await fetch(`${baseUrl}${path}`, { method });
    return res.status;
  }

  it('still serves the existing health route', async () => {
    expect(await statusOf('GET', '/health')).toBe(200);
  });

  it('registers workspaces routes behind the access guard (S14)', async () => {
    expect(await statusOf('GET', '/workspaces')).toBe(401);
  });

  it('registers nested sessions routes behind the access guard (S14)', async () => {
    expect(await statusOf('GET', '/workspaces/00000000-0000-0000-0000-000000000000/sessions')).toBe(401);
  });

  it('registers terminals routes behind the access guard (S14)', async () => {
    expect(await statusOf('POST', '/sessions/00000000-0000-0000-0000-000000000000/terminals')).toBe(401);
  });

  it('registers invitations routes behind the access guard (S14)', async () => {
    expect(await statusOf('GET', '/invitations')).toBe(401);
    expect(await statusOf('POST', '/invitations/00000000-0000-0000-0000-000000000000/accept')).toBe(401);
  });
});
