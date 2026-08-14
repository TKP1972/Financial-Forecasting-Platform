/**
 * What happens when signing in does not work.
 *
 * The success path is exercised everywhere - every other suite signs in to get
 * a token. The failure paths were exercised nowhere, and they are the ones
 * carrying the security properties:
 *
 *   - a wrong password and an unknown address are indistinguishable, so the
 *     endpoint cannot be used to enumerate who holds an account
 *   - repeated failures lock the account rather than allowing unlimited guesses
 *   - a deactivated account cannot sign in even with the correct password
 *
 * These are asserted at the route rather than the service, because the mapping
 * from a thrown error to a status code and error code is part of the control:
 * a lockout that surfaced as a 500 would be a defect no service-level test
 * could see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  refreshToken: { create: vi.fn(), updateMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');
const { hashPassword } = await import('../services/auth.service.js');

const PASSWORD = 'Correct!Horse26';
const ANALYST = makeUser({ id: 'u-analyst', role: 'ANALYST' });

let app: FastifyInstance;
let storedHash: string;

beforeEach(async () => {
  vi.clearAllMocks();
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.user.update.mockResolvedValue({});
  db.refreshToken.create.mockResolvedValue({});
  storedHash ??= await hashPassword(PASSWORD);
  app = await buildApp();
});

const signIn = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

describe('POST /auth/login failure paths', () => {
  it('an unknown address and a wrong password answer identically', async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknown = await signIn('nobody@ffp.local', PASSWORD);

    db.user.findUnique.mockResolvedValue({
      ...ANALYST,
      passwordHash: storedHash,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    const wrong = await signIn(ANALYST.email, 'not-the-password');

    // Same status, same code, same message: nothing distinguishes an account
    // that exists from one that does not.
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe(wrong.json().error.code);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('counts a failure towards the lockout rather than forgetting it', async () => {
    db.user.findUnique.mockResolvedValue({
      ...ANALYST,
      passwordHash: storedHash,
      failedLoginCount: 0,
      lockedUntil: null,
    });

    await signIn(ANALYST.email, 'wrong');

    // First failure of five: the count advances and no lock is set yet.
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLoginCount: 1, lockedUntil: null }),
      }),
    );
  });

  it('locks the account on the final permitted failure', async () => {
    // MAX_LOGIN_ATTEMPTS is 5 in the test environment, so the fifth failure is
    // the one that locks. Hand-checked against the fake env, not read from it.
    db.user.findUnique.mockResolvedValue({
      ...ANALYST,
      passwordHash: storedHash,
      failedLoginCount: 4,
      lockedUntil: null,
    });

    await signIn(ANALYST.email, 'wrong');

    const [[call]] = db.user.update.mock.calls;
    // The counter resets and a lock is stamped: a locked account does not keep
    // counting, or it could never be unlocked by waiting.
    expect(call.data.failedLoginCount).toBe(0);
    expect(call.data.lockedUntil).toBeInstanceOf(Date);
    expect(call.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a locked account before checking the password at all', async () => {
    db.user.findUnique.mockResolvedValue({
      ...ANALYST,
      passwordHash: storedHash,
      failedLoginCount: 0,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    // Correct password, still refused - otherwise the lock would only slow an
    // attacker down rather than stopping them.
    const res = await signIn(ANALYST.email, PASSWORD);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses a deactivated account holding the right password', async () => {
    db.user.findUnique.mockResolvedValue({
      ...ANALYST,
      isActive: false,
      passwordHash: storedHash,
      failedLoginCount: 0,
      lockedUntil: null,
    });

    const res = await signIn(ANALYST.email, PASSWORD);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
