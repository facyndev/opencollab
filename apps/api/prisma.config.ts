import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7: the connection URL lives here, not in schema.prisma.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] },
});
