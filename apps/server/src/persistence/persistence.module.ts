import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import type { PrismaClient } from '../generated/prisma/client';
import { AuthRepository } from './auth.repository';
import { createPrismaClient } from './prisma';
import { UserRepository } from './user.repository';

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
  ],
  exports: [PRISMA, UserRepository, AuthRepository],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
