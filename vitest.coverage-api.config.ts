/**
 * Coverage gate for `api`, kept separate from the main run.
 *
 * The engine is gated at 90% lines / 85% branches because the financial maths is
 * the part that must not be wrong. `api` cannot meet that bar yet and pretending
 * otherwise would just mean a red build that someone eventually deletes.
 *
 * Two configs rather than one run with glob-scoped thresholds: those did not
 * reliably exempt the matched files from the global gate, and a config that
 * silently fails to apply is worse than an explicit second one.
 *
 *   npm run test:coverage:api
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/api/src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['packages/api/src/test-support/setup-env.ts'],
    pool: 'threads',
    poolOptions: { threads: { minThreads: 1, maxThreads: 4 } },
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/api',
      include: ['packages/api/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/types.ts',
        '**/*.d.ts',
        // Process entry points and the seed script: bootstrap and data, with no
        // branching logic worth asserting. Counting them would dilute the number
        // and invite excluding something that does matter.
        'packages/api/src/server.ts',
        'packages/api/src/seed.ts',
        'packages/api/src/test-support/**',
      ],
      /**
       * A ratchet, not a target.
       *
       * api sat at zero *measured* coverage - it was not in any include list, so
       * nothing would have reported a fall. These numbers sit just under what the
       * current route tests achieve. Raise them deliberately as more suites land;
       * never lower them to make a build pass.
       */
      thresholds: {
        // Raised when route coverage reached 109 of 109.
        //
        // Branches dipped to 78.4 on the way: exercising a route's happy path
        // pulls every unexercised branch in its file into the denominator, so
        // the ratio falls while absolute coverage only rises. Rather than
        // re-base the threshold downward, the dip was closed by testing the
        // two places that most deserved it - the Prisma error mapping every
        // route depends on (65.5 -> 88.4) and the readiness probe's
        // database-down branch (60 -> 83.3). Both were worth a test on their
        // own merits, which is the test of whether covering a branch is real
        // work or box-ticking.
        lines: 33,
        functions: 45,
        branches: 80,
        statements: 33,
      },
    },
  },
  resolve: {
    alias: {
      '@ffp/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@ffp/engine': resolve(rootDir, 'packages/engine/src/index.ts'),
    },
  },
});
