import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

it('binds the local Postgres to loopback only', () => {
  const compose = readFileSync(join(process.cwd(), '..', '..', 'docker-compose.yml'), 'utf8');
  const ports = compose.match(/^\s*-\s*"?[\d.:]*5432:5432"?\s*$/gm) ?? [];
  expect(ports).toHaveLength(1);
  expect(ports[0]).toContain('127.0.0.1:5432:5432');
});
