import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { PrismaClient } from '../generated/prisma/client';
import { AuthModule } from '../auth/auth.module';
import { applyHttpConfig } from '../auth/http-config';
import { AUTH_CONFIG, type AuthConfig } from '../auth/config';
import { CLOCK } from '../auth/clock';
import { OAUTH_PROVIDERS } from '../auth/oauth-provider';
import { TestClock } from '../auth/test-app';
import { PRISMA } from '../persistence/persistence.module';
import { openTestClient } from '../persistence/test-db';
import { CollabModule } from './collab.module';

export const TEST_SECRET = 'test-secret-test-secret-test-secret-test';

export interface CollabTestApp {
  app: INestApplication;
  prisma: PrismaClient;
  clock: TestClock;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startCollabTestApp(): Promise<CollabTestApp> {
  const prisma = openTestClient();
  const clock = new TestClock();
  const config: AuthConfig = {
    jwtSecret: TEST_SECRET,
    databaseUrl: 'unused',
    publicBaseUrl: 'http://api.test',
    webOrigin: 'http://web.test',
    oauth: {},
    rateLimitEnabled: false,
    trustProxy: false,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AuthModule, CollabModule] })
    .overrideProvider(PRISMA)
    .useValue(prisma)
    .overrideProvider(AUTH_CONFIG)
    .useValue(config)
    .overrideProvider(OAUTH_PROVIDERS)
    .useValue({})
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication();
  applyHttpConfig(app, config);
  await app.listen(0, '127.0.0.1');
  return {
    app,
    prisma,
    clock,
    baseUrl: await app.getUrl(),
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}
