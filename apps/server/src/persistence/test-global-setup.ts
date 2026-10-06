import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { Client } from 'pg';

import { testDatabaseUrl } from './test-db';

// Recreates `<db>_test` and applies the real migrations to it.
export default async function setup(): Promise<void> {
  const target = new URL(testDatabaseUrl());
  const name = target.pathname.slice(1);
  const admin = new URL(target);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    { env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'pipe' },
  );
}
