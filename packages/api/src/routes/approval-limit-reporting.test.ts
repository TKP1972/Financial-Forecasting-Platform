/**
 * The approval limit an endpoint reports, and the one it enforces.
 *
 * `approvalLimit` is nullable on the user row and nullable in the policy table,
 * and the two nulls mean opposite things. Stored `null` means "no override,
 * inherit the role default". Reported `null` means "unlimited" - that is what
 * `DEFAULT_APPROVAL_LIMITS.CFO` uses it for. They collide on exactly one role:
 * ADMIN, stored null, default '0'. `POST /auth/login` once returned the stored
 * column under a name every client reads as policy, so it described the
 * administrator as having no ceiling while every approval path held them to
 * zero. Both sides were individually correct, which is why nothing caught it.
 *
 * The fix is not to pick one meaning. It is to return both facts under names
 * that cannot be confused, and these tests hold that property:
 *
 *   - `approvalLimit` is the stored override, so a client that reads a user
 *     and writes it back does not convert an inherited default into an
 *     explicit override
 *   - `effectiveApprovalLimit` is what applies, and is the field the approval
 *     services actually enforce
 *
 * Expected values are hand-checked against DEFAULT_APPROVAL_LIMITS rather than
 * computed from it. A test that derived them would pass against any table.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  refreshToken: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

/** Prisma returns Decimal, not string. The harness mimics that; so must this. */
const decimal = (value: string) => ({ toString: () => value });

const ADMIN = makeUser({ id: 'u-admin', role: 'ADMIN' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  app = await buildApp();
});

describe('GET /auth/me', () => {
  const me = (actor: ReturnType<typeof makeUser>) =>
    app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(app, actor) });

  it('reports the administrator as capped at zero, not unlimited', async () => {
    // Stored null - the seeded administrator has no override.
    db.user.findUnique.mockResolvedValue({ ...ADMIN, approvalLimit: null });

    const res = await me(ADMIN);
    const user = res.json().user;

    expect(res.statusCode).toBe(200);
    // The two fields disagree, and that disagreement is the point.
    expect(user.approvalLimit).toBeNull();
    expect(user.effectiveApprovalLimit).toBe('0');
  });

  it('still reports the CFO as unlimited, which is what null legitimately means', async () => {
    const cfo = makeUser({ id: 'u-cfo', role: 'CFO' });
    db.user.findUnique.mockResolvedValue({ ...cfo, approvalLimit: null });

    const user = (await me(cfo)).json().user;

    expect(user.approvalLimit).toBeNull();
    // DEFAULT_APPROVAL_LIMITS.CFO is null: no ceiling.
    expect(user.effectiveApprovalLimit).toBeNull();
  });

  it('an override is reported in both fields, because it is both', async () => {
    // A finance manager capped below their 2,000,000 default.
    const fm = makeUser({ id: 'u-fm', role: 'FINANCE_MANAGER' });
    db.user.findUnique.mockResolvedValue({ ...fm, approvalLimit: decimal('500000') });

    const user = (await me(fm)).json().user;

    expect(user.approvalLimit).toBe('500000');
    expect(user.effectiveApprovalLimit).toBe('500000');
  });

  it('a zero override is preserved rather than read as absent', async () => {
    // '0' is falsy. Any resolution written with `||` instead of `??` would
    // discard this and report the CFO's unlimited default instead.
    const cfo = makeUser({ id: 'u-cfo-capped', role: 'CFO' });
    db.user.findUnique.mockResolvedValue({ ...cfo, approvalLimit: decimal('0') });

    const user = (await me(cfo)).json().user;

    expect(user.approvalLimit).toBe('0');
    expect(user.effectiveApprovalLimit).toBe('0');
  });
});

describe('POST /auth/refresh', () => {
  // The site that was easiest to miss. Fixing only the login response would
  // have left a token rotation quietly restoring the wrong answer a few
  // minutes into every session - the hardest kind of regression to attribute,
  // because sign-in looks correct and the value changes later without anyone
  // touching it.
  it('rotation reports the same two limits sign-in did', async () => {
    db.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: ADMIN.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...ADMIN, approvalLimit: null },
    });
    db.refreshToken.update.mockResolvedValue({});
    db.refreshToken.create.mockResolvedValue({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'whatever-the-client-holds' },
    });

    expect(res.statusCode).toBe(200);
    const { user } = res.json();
    expect(user.approvalLimit).toBeNull();
    expect(user.effectiveApprovalLimit).toBe('0');
  });

  // The rotation guards themselves had no route-level test. They are reached
  // through the same handler as the above, and each one is a real control
  // rather than an error path worth skipping.

  it('a replayed token revokes every session rather than merely being refused', async () => {
    // Presenting an already-revoked token means a replay or a stolen token.
    // Refusing this one request would leave the thief's other sessions alive.
    db.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-used',
      userId: ADMIN.id,
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: ADMIN,
    });
    db.refreshToken.updateMany.mockResolvedValue({ count: 3 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'replayed' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    // The wholesale revocation is the control; the 401 alone is not.
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: ADMIN.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('an expired token is refused without revoking anything', async () => {
    db.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-old',
      userId: ADMIN.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      user: ADMIN,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'expired' },
    });

    expect(res.statusCode).toBe(401);
    // Expiry is ordinary, not suspicious - it must not trip the replay response.
    expect(db.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('a deactivated account cannot refresh its way back in', async () => {
    db.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-2',
      userId: ADMIN.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { ...ADMIN, isActive: false },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'still-valid-but-account-is-not' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('an unknown token is refused', async () => {
    db.refreshToken.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'never-issued' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /governance/users', () => {
  it('lists the stored override, so reading and writing it back is a no-op', async () => {
    // The hazard this guards: if the list returned the *resolved* limit, an
    // admin form seeded from it and saved unchanged would write '0' into a
    // column that held null - turning "inherits the default" into an explicit
    // override that no longer tracks the policy table.
    db.user.findUnique.mockResolvedValue(ADMIN);
    db.user.findMany.mockResolvedValue([
      { ...ADMIN, approvalLimit: null, businessUnit: null, lockedUntil: null, lastLoginAt: null },
      // Both paths in one list: a row with no override and a row with one. A
      // Decimal that is present exercises the `?.toString()` side that a
      // null-only fixture leaves unrun.
      {
        ...makeUser({ id: 'u-owner', role: 'BUDGET_OWNER' }),
        approvalLimit: decimal('100000'),
        businessUnit: null,
        lockedUntil: null,
        lastLoginAt: null,
      },
    ]);
    db.user.count.mockResolvedValue(2);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/governance/users',
      headers: authHeader(app, ADMIN),
    });

    expect(res.statusCode).toBe(200);
    const [admin, owner] = res.json().data;

    // No override: stored null, and the ADMIN default applies.
    expect(admin.approvalLimit).toBeNull();
    expect(admin.effectiveApprovalLimit).toBe('0');

    // An override: reported as stored, and it is also what applies. Written
    // back unchanged this is a no-op, which is the property being protected -
    // BUDGET_OWNER's default is 250000, so had the list reported the resolved
    // value under the stored name, saving the form would have silently raised
    // this user's ceiling.
    expect(owner.approvalLimit).toBe('100000');
    expect(owner.effectiveApprovalLimit).toBe('100000');
  });
});
