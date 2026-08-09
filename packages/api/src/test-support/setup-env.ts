/**
 * Environment for the API test suite.
 *
 * Runs as a Vitest `setupFile`, before any test module is imported, because
 * config.ts validates and freezes the environment at import time.
 *
 * SKIP_DOTENV is set deliberately: without it the tests would read the
 * developer's real .env, which means they would pass or fail depending on
 * whose machine they run on and would not run at all on a CI box that has no
 * .env file. The values below are fixed, fake, and the only ones these tests
 * ever see.
 *
 * DATABASE_URL is syntactically valid and points nowhere. Nothing in these
 * tests reaches a database - the Prisma client is mocked per test file - but
 * Prisma's constructor insists on a parseable URL.
 */
process.env.SKIP_DOTENV = 'true';
process.env.NODE_ENV = 'test';

process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/ffp_test?schema=public';

// 64 hex characters each. Length is what config validates; these are not
// secrets and must never be used anywhere real.
process.env.JWT_SECRET = 'test'.repeat(16);
process.env.AUDIT_HASH_SALT = 'salt'.repeat(16);

// Keep the suite quiet and deterministic.
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';

// Background workers must never start under test.
process.env.NOTIFICATION_DISPATCH_SECONDS = '0';
process.env.DEADLINE_SCAN_SECONDS = '0';
process.env.NOTIFICATION_TRANSPORT = 'none';

// The real limit is 10/minute on login; a route test that asserts a 403 should
// never be able to fail with a 429 because a sibling test used up the budget.
process.env.RATE_LIMIT_MAX = '100000';
