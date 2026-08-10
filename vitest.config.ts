import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/a%20b/..."
// - a leading slash and percent-encoded spaces - which resolves to nothing.
const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.{test,spec}.{ts,tsx}',
      'packages/*/tests/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    // config.ts validates and freezes process.env at import time, so the API's
    // fake environment has to be in place before any test module loads. Harmless
    // for engine and shared, which read no environment at all.
    setupFiles: ['packages/api/src/test-support/setup-env.ts'],
    reporters: ['default'],
    // Each worker loads the whole engine, and the Monte Carlo suites allocate
    // large typed arrays. Unbounded parallelism exhausts memory on a normal
    // developer machine, so cap the pool rather than relying on the default.
    pool: 'threads',
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 4 },
    },
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // engine and shared only. The api floor is enforced separately, by
      // vitest.coverage-api.config.ts - glob-scoped thresholds in a single run
      // did not reliably exempt the matched files from the global gate, and a
      // second explicit config is clearer than one that silently does nothing.
      include: ['packages/engine/src/**/*.ts', 'packages/shared/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types.ts', '**/*.d.ts'],
      thresholds: {
        // The financial math is the part that must not be wrong.
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      '@ffp/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@ffp/engine': resolve(rootDir, 'packages/engine/src/index.ts'),
      // Mirrors packages/web/vite.config.ts. Web modules import each other as
      // '@/store/auth'; without this the tests resolve nothing.
      '@': resolve(rootDir, 'packages/web/src'),
    },
  },
});
