/**
 * The last routes nothing had ever called.
 *
 * Strategic objectives, budget consolidation, the entity audit trail, marking
 * notifications read, signing out, and the health probes. None had a route
 * test, an e2e suite or a browser journey touching them, which the reachability
 * check surfaced.
 *
 * They are lower-consequence than user administration or a governed publish, so
 * these are mostly reachability and gating: the route answers, it enforces the
 * permission it declares, and it refuses before writing. Two exceptions get
 * real assertions because they carry a judgement rather than a lookup:
 *
 *   - **`/objectives/target-check`** decides whether the strategic target
 *     shares add to 100%. A rounding-tolerant comparison against 1 is exactly
 *     the sort of thing that quietly reports "balanced" for 99.4%.
 *   - **`/notifications/read-all`** must only touch the caller's own rows. A
 *     mistake there marks somebody else's inbox read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  strategicObjective: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  budget: { findMany: vi.fn() },
  budgetCycle: { findUnique: vi.fn() },
  auditLog: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  notification: { updateMany: vi.fn() },
  refreshToken: { updateMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const VIEWER = makeUser({ id: 'u-viewer', role: 'VIEWER' });
const ANALYST = makeUser({ id: 'u-analyst', role: 'ANALYST' });
const FINANCE_MANAGER = makeUser({ id: 'u-fm', role: 'FINANCE_MANAGER' });
const ADMIN = makeUser({ id: 'u-admin', role: 'ADMIN' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.strategicObjective.findMany.mockResolvedValue([]);
  db.strategicObjective.findUnique.mockResolvedValue(null);
  db.budget.findMany.mockResolvedValue([]);
  db.budgetCycle.findUnique.mockResolvedValue({
    id: 'cycle-1',
    name: 'FY2026 Annual Budget',
    fiscalYear: 2026,
    baseCurrency: 'USD',
    periodType: 'MONTH',
  });
  db.auditLog.findMany.mockResolvedValue([]);
  db.auditLog.count.mockResolvedValue(0);
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.notification.updateMany.mockResolvedValue({ count: 3 });
  db.refreshToken.updateMany.mockResolvedValue({ count: 1 });
  db.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
  db.refreshToken.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    typeof fn === 'function' ? fn(db) : fn,
  );
  app = await buildApp();
});

const get = (url: string, actor: ReturnType<typeof makeUser>) =>
  app.inject({ method: 'GET', url, headers: authHeader(app, actor) });

// --------------------------------------------------------------------------

describe('strategic objectives', () => {
  it('lists objectives for anyone who may read a budget', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    expect((await get('/api/v1/org/objectives', VIEWER)).statusCode).toBe(200);
  });

  it('404s on an objective that does not exist', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await get('/api/v1/org/objectives/nope', VIEWER);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('needs settings:manage to create one, and refuses before writing', async () => {
    // An objective is the axis strategic alignment is measured on, so changing
    // the set changes what every budget line is scored against. A CFO does not
    // hold settings:manage; an administrator does.
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/org/objectives',
      headers: authHeader(app, FINANCE_MANAGER),
      payload: { code: 'H1-NEW', title: 'New objective', horizon: 'H1_CORE' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.strategicObjective.create).not.toHaveBeenCalled();
  });

  describe('target-check', () => {
    it('reports balanced when the shares total exactly one', async () => {
      db.user.findUnique.mockResolvedValue(ANALYST);
      db.strategicObjective.findMany.mockResolvedValue([
        { code: 'A', title: 'A', targetShare: '0.5' },
        { code: 'B', title: 'B', targetShare: '0.3' },
        { code: 'C', title: 'C', targetShare: '0.2' },
      ]);

      // Returned unwrapped, unlike almost every other route in the API, which
      // answers `{ data: ... }`. Asserted as it is rather than as it ought to
      // be - changing a response shape is a breaking change for any client
      // already reading it.
      const body = (await get('/api/v1/org/objectives/target-check', ANALYST)).json();

      expect(body.balanced).toBe(true);
      expect(body.totalTargetShare).toBeCloseTo(1, 10);
    });

    it('tolerates binary floating point rather than failing on 0.1 + 0.2', async () => {
      // 0.1 + 0.2 + 0.7 is 0.9999999999999999 in IEEE-754. A bare === 1 would
      // report a correctly balanced set as unbalanced, and whoever hit it would
      // spend an afternoon looking for the missing 0.0000000000000001.
      db.user.findUnique.mockResolvedValue(ANALYST);
      db.strategicObjective.findMany.mockResolvedValue([
        { code: 'A', title: 'A', targetShare: '0.1' },
        { code: 'B', title: 'B', targetShare: '0.2' },
        { code: 'C', title: 'C', targetShare: '0.7' },
      ]);

      expect((await get('/api/v1/org/objectives/target-check', ANALYST)).json().balanced).toBe(
        true,
      );
    });

    it('reports unbalanced when a real gap exists', async () => {
      // The tolerance must not be so generous that a genuine shortfall passes.
      // 94% is a missing six points of strategy, not a rounding artefact.
      db.user.findUnique.mockResolvedValue(ANALYST);
      db.strategicObjective.findMany.mockResolvedValue([
        { code: 'A', title: 'A', targetShare: '0.5' },
        { code: 'B', title: 'B', targetShare: '0.44' },
      ]);

      const body = (await get('/api/v1/org/objectives/target-check', ANALYST)).json();

      expect(body.balanced).toBe(false);
      expect(body.message).toBeTruthy();
    });
  });
});

// --------------------------------------------------------------------------

describe('budget consolidation', () => {
  it('consolidates every budget by default', async () => {
    // Deliberately not approved-only: a finance manager consolidating a cycle
    // mid-flight needs to see the drafts too, or the total understates what is
    // coming. The narrowing is opt-in and explicit.
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    const res = await get('/api/v1/budgets/consolidated/cycle-1', FINANCE_MANAGER);

    expect(res.statusCode).toBe(200);
    expect(db.budget.findMany.mock.calls[0]![0].where.status).toBeUndefined();
  });

  it('narrows to approved budgets when asked', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    await get('/api/v1/budgets/consolidated/cycle-1?approvedOnly=true', FINANCE_MANAGER);

    expect(db.budget.findMany.mock.calls[0]![0].where.status).toEqual({
      in: ['APPROVED', 'LOCKED'],
    });
  });

  it('treats approvedOnly=false as false, not as truthy', async () => {
    // z.coerce.boolean() would make the string "false" true. This is the trap
    // that queryBoolean exists for, asserted at a call site that uses it.
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    await get('/api/v1/budgets/consolidated/cycle-1?approvedOnly=false', FINANCE_MANAGER);

    expect(db.budget.findMany.mock.calls[0]![0].where.status).toBeUndefined();
  });
});

// --------------------------------------------------------------------------

describe('the entity audit trail', () => {
  it('needs audit:read', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await get('/api/v1/governance/audit/entity/Budget/budget-1', ANALYST);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('returns the history of one record for a finance manager', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    const res = await get('/api/v1/governance/audit/entity/Budget/budget-1', FINANCE_MANAGER);

    expect(res.statusCode).toBe(200);
    // Scoped to the record asked for, or "the history of this budget" would
    // quietly be "the history of everything".
    const where = db.auditLog.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ entityType: 'Budget', entityId: 'budget-1' });
  });
});

// --------------------------------------------------------------------------

describe('notifications and session end', () => {
  it('marks only the caller’s own notifications read', async () => {
    // The failure here is silent and other people's: a missing userId marks
    // every inbox in the deployment read.
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: authHeader(app, ANALYST),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(db.notification.updateMany.mock.calls[0]![0].where).toMatchObject({
      userId: ANALYST.id,
    });
  });

  it('refuses to mark anything read without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all' });

    expect(res.statusCode).toBe(401);
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });

  it('signs a user out', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: authHeader(app, ADMIN),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
  });
});

// --------------------------------------------------------------------------

describe('health probes', () => {
  // Unauthenticated on purpose: an orchestrator has no credentials, and a probe
  // that needed them would report the container unhealthy for the wrong reason.
  //
  // Mounted at the root rather than under /api/v1 - the rate limiter's allow
  // list keys off `/health`, so the prefix would have to change in two places
  // that do not know about each other.
  it('answers liveness without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });

    expect(res.statusCode).toBe(200);
  });

  it('answers readiness without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    // 200 when the database answers, 503 when it does not. Either is a valid
    // readiness answer; a 401 or a 500 would not be.
    expect([200, 503]).toContain(res.statusCode);
  });
});
