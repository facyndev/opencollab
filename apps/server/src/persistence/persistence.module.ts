import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import type { PrismaClient } from '../generated/prisma/client';
import { AuthRepository } from './auth.repository';
import { createPrismaClient } from './prisma';
import { SessionRepository } from './session.repository';
import { UserRepository } from './user.repository';
import { WorkspaceRepository } from './workspace.repository';

export const PRISMA = Symbol('PRISMA');

@Module({
  providers: [
    {
      provide: PRISMA,
      useFactory: (): PrismaClient => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required');
        return createPrismaClient(url);
      },
    },
    { provide: UserRepository, useFactory: (p: PrismaClient) => new UserRepository(p), inject: [PRISMA] },
    { provide: AuthRepository, useFactory: (p: PrismaClient) => new AuthRepository(p), inject: [PRISMA] },
    { provide: SessionRepository, useFactory: (p: PrismaClient) => new SessionRepository(p), inject: [PRISMA] },
    { provide: WorkspaceRepository, useFactory: (p: PrismaClient) => new WorkspaceRepository(p), inject: [PRISMA] },
  ],
  exports: [PRISMA, UserRepository, AuthRepository, SessionRepository, WorkspaceRepository],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
