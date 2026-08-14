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

describe('GET /governance/users', () => {
  it('lists the stored override, so reading and writing it back is a no-op', async () => {
    // The hazard this guards: if the list returned the *resolved* limit, an
    // admin form seeded from it and saved unchanged would write '0' into a
    // column that held null - turning "inherits the default" into an explicit
    // override that no longer tracks the policy table.
    db.user.findUnique.mockResolvedValue(ADMIN);
    db.user.findMany.mockResolvedValue([
      { ...ADMIN, approvalLimit: null, businessUnit: null, lockedUntil: null, lastLoginAt: null },
    ]);
    db.user.count.mockResolvedValue(1);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/governance/users',
      headers: authHeader(app, ADMIN),
    });

    expect(res.statusCode).toBe(200);
    const [row] = res.json().data;
    expect(row.approvalLimit).toBeNull();
    expect(row.effectiveApprovalLimit).toBe('0');
  });
});
