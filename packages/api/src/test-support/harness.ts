/**
 * Route-test harness.
 *
 * `app.inject()` drives a request through the real router, the real content-type
 * parser, the real auth plugin and the real error mapper, in-process. No server,
 * no port, no Docker, no database. That is what makes it affordable to assert
 * the things that matter most - who is allowed to do what - on every run rather
 * than only during a full end-to-end pass.
 *
 * The database is the only thing faked. Each test file mocks '../db.js' and
 * supplies exactly the rows its scenario needs, so a test states its own
 * preconditions instead of depending on seed data.
 */
import type { FastifyInstance } from 'fastify';
import type { Role } from '@ffp/shared';

/** A user as the auth plugin expects to read it back from the database. */
export interface TestUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  isActive: boolean;
  businessUnitId: string | null;
  approvalLimit: { toString(): string } | null;
}

/**
 * A user row with sensible defaults.
 *
 * `approvalLimit` mimics Prisma's Decimal by being an object with toString(),
 * because that is what the auth plugin calls on it. Passing a plain string here
 * would make the test pass against behaviour the real client does not have.
 */
export function makeUser(overrides: Partial<TestUser> & { id: string; role: Role }): TestUser {
  return {
    email: `${overrides.id}@ffp.test`,
    firstName: 'Test',
    lastName: 'User',
    isActive: true,
    businessUnitId: null,
    approvalLimit: null,
    ...overrides,
  };
}

/**
 * Mint an access token for a user.
 *
 * Signed with the app's own JWT machinery rather than a hand-rolled token, so
 * these tests exercise the same verification path a real request takes. A
 * hand-built token would only prove that our own encoder matches our own
 * decoder.
 */
export type TokenSubject = Pick<TestUser, 'id' | 'email' | 'role'> &
  Partial<Pick<TestUser, 'businessUnitId'>>;

export function tokenFor(app: FastifyInstance, user: TokenSubject) {
  return app.jwt.sign({
    sub: user.id,
    email: user.email,
    role: user.role,
    businessUnitId: user.businessUnitId ?? null,
  });
}

/** Authorization header for a user. */
export function authHeader(app: FastifyInstance, user: TokenSubject) {
  return { authorization: `Bearer ${tokenFor(app, user)}` };
}
