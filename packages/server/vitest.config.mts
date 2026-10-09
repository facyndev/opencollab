import { defineConfig } from 'vitest/config';

// Unit tests: no database required.
export default defineConfig({
  test: { include: ['src/**/*.spec.ts'], exclude: ['**/node_modules/**', '**/*.int.spec.ts'] },
});
