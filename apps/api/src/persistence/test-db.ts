import { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma';

// Integration tests never touch the dev database: they use `<db>_test`.
export function testDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'];
  if (!base) throw new Error('DATABASE_URL is required for integration tests');
  const url = new URL(base);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

export function openTestClient(): PrismaClient {
  return createPrismaClient(testDatabaseUrl());
}

// Deletes every row (children cascade); keeps the schema.
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "User", "Workspace", "Session", "Invitation" RESTART IDENTITY CASCADE',
  );
}
