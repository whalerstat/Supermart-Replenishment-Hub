import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    // tests/ holds the Playwright smoke test (run by `databricks apps validate`), not vitest tests.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.databricks/**', 'tests/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
    },
  },
});
