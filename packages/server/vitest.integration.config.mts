import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Integration tests: need DATABASE_URL; they run against a dedicated
// `<db>_test` database that the global setup recreates and migrates.
export default defineConfig({
  test: {
    include: ['src/**/*.int.spec.ts'],
    globalSetup: ['./src/persistence/test-global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
