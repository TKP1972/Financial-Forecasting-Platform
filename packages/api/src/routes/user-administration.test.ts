/**
 * User administration: the routes that decide who can do anything else.
 *
 * These had no test and no end-to-end coverage at all, which the reachability
 * check surfaced. Creating a user, changing their role and changing a password
 * are the highest-privilege operations in the platform - every other control
 * rests on them being right - and three genuine controls sat here unasserted:
 *
 *   1. **The self-lockout guard.** An administrator may not deactivate or demote
 *      their own account. If the last administrator did, nobody could administer
 *      users again and the only fix would be a database edit.
 *   2. **Session revocation on password change.** Changing a password after a
 *      suspected compromise is pointless if the attacker's existing session
 *      survives it.
 *   3. **`user:manage` gating**, asserted before any write - a control that
 *      raises after creating the user has still created the user.
 *
 * The password itself is never asserted by value, only that what is stored is
 * not what was sent. A test that compared hashes would break with the hashing
 * parameters and teach nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  refreshToken: { updateMany: vi.fn(), deleteMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');
// Imported rather than faked: the success path has to verify a real hash, and
// a stubbed verifier would assert nothing about the check it replaces.
const { hashPassword } = await import('../services/auth.service.js');

const ADMIN = makeUser({ id: 'u-admin', role: 'ADMIN' });
const CFO = makeUser({ id: 'u-cfo', role: 'CFO' });
const ANALYST = makeUser({ id: 'u-analyst', role: 'ANALYST' });
const FINANCE_MANAGER = makeUser({ id: 'u-fm', role: 'FINANCE_MANAGER' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.refreshToken.updateMany.mockResolvedValue({ count: 2 });
  db.refreshToken.deleteMany.mockResolvedValue({ count: 2 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    typeof fn === 'function' ? fn(db) : fn,
  );
  app = await buildApp();
});

// --------------------------------------------------------------------------

describe('POST /auth/users', () => {
  const create = (actor: ReturnType<typeof makeUser>, body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/users',
      headers: authHeader(app, actor),
      payload: body,
    });

  const VALID = {
    // Mixed case, no padding: `z.string().email()` rejects surrounding
    // whitespace outright, so the route's own `.trim()` can never fire. Case
    // normalisation is the part that does real work.
    email: 'New.Person@FFP.Local',
    password: 'Str0ng!Passw0rd',
    firstName: 'New',
    lastName: 'Person',
    role: 'ANALYST',
  };

  it('lets an administrator create a user', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);
    db.user.create.mockResolvedValue({
      id: 'u-new',
      email: 'new.person@ffp.local',
      firstName: 'New',
      lastName: 'Person',
      role: 'ANALYST',
    });

    const res = await create(ADMIN, VALID);

    expect(res.statusCode).toBe(201);
    expect(db.user.create).toHaveBeenCalledOnce();
  });

  it('never stores the password as supplied', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);
    db.user.create.mockResolvedValue({
      id: 'u-new',
      email: 'x',
      firstName: 'x',
      lastName: 'x',
      role: 'ANALYST',
    });

    await create(ADMIN, VALID);

    const stored = db.user.create.mock.calls[0]![0].data;
    expect(stored).not.toHaveProperty('password');
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.passwordHash).not.toContain(VALID.password);
  });

  it('lowercases the email so it cannot be duplicated by case', async () => {
    // The unique constraint is on the stored value, so "A@b.com" and "a@b.com"
    // must not become two accounts.
    db.user.findUnique.mockResolvedValue(ADMIN);
    db.user.create.mockResolvedValue({
      id: 'u-new',
      email: 'x',
      firstName: 'x',
      lastName: 'x',
      role: 'ANALYST',
    });

    await create(ADMIN, VALID);

    expect(db.user.create.mock.calls[0]![0].data.email).toBe('new.person@ffp.local');
  });

  it('records the creation, with the role granted', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);
    db.user.create.mockResolvedValue({
      id: 'u-new',
      email: 'new.person@ffp.local',
      firstName: 'New',
      lastName: 'Person',
      role: 'ANALYST',
    });

    await create(ADMIN, VALID);

    const entry = db.auditLog.create.mock.calls[0]![0].data;
    expect(entry.entityType).toBe('User');
    // The role is the whole point of the entry: "who granted this person their
    // access" is the question an auditor asks.
    expect(entry.changes).toContain('ANALYST');
  });

  it.each([
    ['CFO', CFO],
    ['FINANCE_MANAGER', FINANCE_MANAGER],
    ['ANALYST', ANALYST],
  ])('refuses a %s, before any write', async (_label, actor) => {
    // user:manage is ADMIN-only. A CFO outranks everyone in finance and still
    // may not mint accounts - the platform is not their identity system.
    db.user.findUnique.mockResolvedValue(actor);

    const res = await create(actor, VALID);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('rejects a weak password rather than storing it', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);

    const res = await create(ADMIN, { ...VALID, password: 'short' });

    expect(res.statusCode).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------

describe('PATCH /governance/users/:id', () => {
  const patch = (actor: ReturnType<typeof makeUser>, id: string, body: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/governance/users/${id}`,
      headers: authHeader(app, actor),
      payload: body,
    });

  it('lets an administrator change another user’s role', async () => {
    db.user.findUnique
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce({ ...ANALYST, id: 'u-other' });
    db.user.update.mockResolvedValue({
      id: 'u-other',
      email: 'a@b.c',
      role: 'BUDGET_OWNER',
      isActive: true,
    });

    const res = await patch(ADMIN, 'u-other', { role: 'BUDGET_OWNER' });

    expect(res.statusCode).toBe(200);
    expect(db.user.update).toHaveBeenCalledOnce();
  });

  it('refuses an administrator deactivating their own account', async () => {
    // The self-lockout guard. If the last administrator does this, nobody can
    // administer users again and the only remedy is a database edit.
    db.user.findUnique.mockResolvedValueOnce(ADMIN).mockResolvedValueOnce(ADMIN);

    const res = await patch(ADMIN, ADMIN.id, { isActive: false });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses an administrator demoting themselves', async () => {
    db.user.findUnique.mockResolvedValueOnce(ADMIN).mockResolvedValueOnce(ADMIN);

    const res = await patch(ADMIN, ADMIN.id, { role: 'ANALYST' });

    expect(res.statusCode).toBe(409);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('allows an administrator to change their own account harmlessly', async () => {
    // The guard must be about lockout, not about self-edits in general.
    // Re-asserting ADMIN on yourself is a no-op, not a danger.
    db.user.findUnique.mockResolvedValueOnce(ADMIN).mockResolvedValueOnce(ADMIN);
    db.user.update.mockResolvedValue({
      id: ADMIN.id,
      email: 'a@b.c',
      role: 'ADMIN',
      isActive: true,
    });

    const res = await patch(ADMIN, ADMIN.id, { role: 'ADMIN' });

    expect(res.statusCode).toBe(200);
  });

  it('404s on a user that does not exist', async () => {
    db.user.findUnique.mockResolvedValueOnce(ADMIN).mockResolvedValueOnce(null);

    const res = await patch(ADMIN, 'nobody', { isActive: false });

    expect(res.statusCode).toBe(404);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses a non-administrator, before any write', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    const res = await patch(CFO, 'u-other', { role: 'ADMIN' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------

describe('GET /governance/users and /governance/roles', () => {
  it('needs user:read to list users', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/governance/users',
      headers: authHeader(app, ANALYST),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('lets a finance manager list users', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);
    db.user.findMany.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/governance/users',
      headers: authHeader(app, FINANCE_MANAGER),
    });

    expect(res.statusCode).toBe(200);
  });

  it('shows the permission matrix to any signed-in user', async () => {
    // Deliberately only authenticated: everyone should be able to see what
    // their role can do, and what the next one up can. Hiding it makes every
    // refusal look arbitrary.
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/governance/roles',
      headers: authHeader(app, ANALYST),
    });

    expect(res.statusCode).toBe(200);
  });

  it('refuses the matrix to a caller with no token at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/governance/roles' });

    expect(res.statusCode).toBe(401);
  });
});

// --------------------------------------------------------------------------

describe('GET /auth/me and POST /auth/change-password', () => {
  it('returns the signed-in user without their password hash', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(app, ANALYST),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');
  });

  it('refuses a password change when the current password is wrong', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);
    // A hash that will not verify against anything supplied here.
    db.user.findUniqueOrThrow.mockResolvedValue({ ...ANALYST, passwordHash: 'not-a-real-hash' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(app, ANALYST),
      payload: { currentPassword: 'wrong-one', newPassword: 'Str0ng!Passw0rd' },
    });

    expect(res.statusCode).toBe(401);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('changes the password and revokes every existing session', async () => {
    // The control the header of this file claims and, until now, did not
    // assert. Changing a password after a suspected compromise is pointless if
    // the attacker's session survives it, so the revocation is the point rather
    // than a side effect.
    const current = 'C0rrect!Horse9';
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.user.findUniqueOrThrow.mockResolvedValue({
      ...ANALYST,
      passwordHash: await hashPassword(current),
    });
    db.user.update.mockResolvedValue({ ...ANALYST });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(app, ANALYST),
      payload: { currentPassword: current, newPassword: 'A!different9Pass' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionsRevoked).toBeGreaterThan(0);
    // Stored re-hashed, never as supplied.
    const stored = db.user.update.mock.calls[0]![0].data.passwordHash;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('A!different9Pass');
  });

  it('refuses a new password identical to the current one', async () => {
    // Otherwise "change your password" is satisfiable by not changing it, and
    // the revocation above becomes a way to log everyone out for nothing.
    const current = 'C0rrect!Horse9';
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.user.findUniqueOrThrow.mockResolvedValue({
      ...ANALYST,
      passwordHash: await hashPassword(current),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(app, ANALYST),
      payload: { currentPassword: current, newPassword: current },
    });

    expect(res.statusCode).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('rejects a weak new password before touching the account', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.user.findUniqueOrThrow.mockResolvedValue({ ...ANALYST, passwordHash: 'not-a-real-hash' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(app, ANALYST),
      payload: { currentPassword: 'whatever', newPassword: 'short' },
    });

    expect(res.statusCode).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
