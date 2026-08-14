/**
 * The risk register, and the one control inside it that is easy to miss.
 *
 * `PATCH /risk/risks/:id` is guarded by `risk:write`, which an Analyst holds.
 * But **formally accepting a risk** — setting `response` to `ACCEPT` — is a
 * different act: it is a decision to carry an exposure rather than treat it, and
 * it requires `risk:accept`, held from Finance Manager upwards. So the route
 * checks a *second* permission inside a handler already guarded by a first.
 *
 * That is the sort of control a reader skims past. It also only fires on the
 * **transition into** acceptance (`existing.response !== 'ACCEPT'`), so
 * re-saving an already-accepted risk does not re-challenge the editor — correct,
 * and worth pinning, because a naive tightening would lock an Analyst out of
 * editing any accepted risk's mitigation notes.
 *
 * None of it had a test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  risk: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  simulation: { findMany: vi.fn(), findUnique: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const VIEWER = makeUser({ id: 'u-viewer', role: 'VIEWER' });
const ANALYST = makeUser({ id: 'u-analyst', role: 'ANALYST' });
const OWNER = makeUser({ id: 'u-owner', role: 'BUDGET_OWNER' });
const FINANCE_MANAGER = makeUser({ id: 'u-fm', role: 'FINANCE_MANAGER' });

const NEW_RISK = {
  title: 'Backhaul lease renewal above indexation',
  category: 'FINANCIAL',
  probability: 3,
  impact: 4,
  financialImpact: '2500000.0000',
  response: 'MITIGATE',
};

function riskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'risk-1',
    title: 'Backhaul lease renewal above indexation',
    description: null,
    category: 'FINANCIAL',
    businessUnitId: null,
    probability: 3,
    impact: 4,
    financialImpact: { toString: () => '2500000.0000' },
    response: 'MITIGATE',
    mitigationPlan: null,
    residualProbability: null,
    residualImpact: null,
    ownerId: null,
    status: 'OPEN',
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.risk.findMany.mockResolvedValue([riskRow()]);
  db.risk.findUnique.mockResolvedValue(riskRow());
  db.risk.create.mockResolvedValue(riskRow());
  db.risk.update.mockResolvedValue(riskRow());
  db.simulation.findMany.mockResolvedValue([]);
  db.simulation.findUnique.mockResolvedValue(null);
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    typeof fn === 'function' ? fn(db) : fn,
  );
  app = await buildApp();
});

const patch = (actor: ReturnType<typeof makeUser>, body: unknown, id = 'risk-1') =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/risk/risks/${id}`,
    headers: authHeader(app, actor),
    payload: body,
  });

describe('POST /risk/risks', () => {
  const create = (actor: ReturnType<typeof makeUser>, body: unknown = NEW_RISK) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/risk/risks',
      headers: authHeader(app, actor),
      payload: body,
    });

  it('lets an analyst raise a risk', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await create(ANALYST);

    expect(res.statusCode).toBe(201);
    expect(db.risk.create).toHaveBeenCalledOnce();
  });

  it('refuses a viewer, before any write', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await create(VIEWER);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.risk.create).not.toHaveBeenCalled();
  });

  it('rejects a heat-map score outside 1-5 rather than storing it', async () => {
    // The score drives severity and expected value. A 9 would silently produce
    // an off-scale exposure that no chart axis expects.
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await create(ANALYST, { ...NEW_RISK, impact: 9 });

    expect(res.statusCode).toBe(400);
    expect(db.risk.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /risk/risks/:id — accepting a risk is a second permission', () => {
  it('lets an analyst edit a risk that is not being accepted', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await patch(ANALYST, { mitigationPlan: 'Renegotiate ahead of renewal.' });

    expect(res.statusCode).toBe(200);
    expect(db.risk.update).toHaveBeenCalledOnce();
  });

  it('refuses an analyst formally accepting a risk', async () => {
    // The substantive control. `risk:write` lets them describe and treat a
    // risk; deciding to carry it is a Finance Manager's call.
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await patch(ANALYST, { response: 'ACCEPT' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.risk.update).not.toHaveBeenCalled();
  });

  it('refuses a budget owner too — seniority alone is not the test', async () => {
    // A Budget Owner outranks an Analyst and still lacks risk:accept. If this
    // ever passes, the check has been replaced by a role comparison.
    db.user.findUnique.mockResolvedValue(OWNER);

    const res = await patch(OWNER, { response: 'ACCEPT' });

    expect(res.statusCode).toBe(403);
    expect(db.risk.update).not.toHaveBeenCalled();
  });

  it('lets a finance manager accept it', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    const res = await patch(FINANCE_MANAGER, { response: 'ACCEPT' });

    expect(res.statusCode).toBe(200);
    expect(db.risk.update).toHaveBeenCalledOnce();
  });

  it('does not re-challenge an editor on a risk that is already accepted', async () => {
    // The guard is on the *transition* into acceptance. Re-saving an accepted
    // risk must not lock an Analyst out of its mitigation notes - which is what
    // a naive "response === ACCEPT" check would do.
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.risk.findUnique.mockResolvedValue(riskRow({ response: 'ACCEPT' }));

    const res = await patch(ANALYST, {
      response: 'ACCEPT',
      mitigationPlan: 'Reviewed, no change.',
    });

    expect(res.statusCode).toBe(200);
    expect(db.risk.update).toHaveBeenCalledOnce();
  });

  it('404s on a risk that does not exist', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);
    db.risk.findUnique.mockResolvedValue(null);

    const res = await patch(FINANCE_MANAGER, { response: 'ACCEPT' }, 'nope');

    expect(res.statusCode).toBe(404);
    expect(db.risk.update).not.toHaveBeenCalled();
  });
});

describe('GET /risk/register — every filter actually filters', () => {
  /**
   * Four independent optional filters, each a spread that contributes nothing
   * when absent. A filter that quietly does not narrow is a defect this
   * codebase has already shipped once, on the cycle list, so each is asserted
   * on the `where` the route builds rather than on the rows that come back -
   * a fake database would return the same rows either way.
   */
  const register = (actor: ReturnType<typeof makeUser>, query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/risk/register${query}`,
      headers: authHeader(app, actor),
    });

  it('applies no filter when none is asked for', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    await register(VIEWER);

    expect(db.risk.findMany.mock.calls[0]![0].where).toEqual({});
  });

  it.each([
    ['businessUnitId', 'bu-1'],
    ['budgetId', 'budget-1'],
    ['pursuitId', 'pursuit-1'],
    ['status', 'MONITORING'],
  ])('narrows by %s', async (field, value) => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    await register(VIEWER, `?${field}=${value}`);

    expect(db.risk.findMany.mock.calls[0]![0].where).toEqual({ [field]: value });
  });

  it('combines filters rather than letting the last one win', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    await register(VIEWER, '?businessUnitId=bu-1&status=OPEN');

    expect(db.risk.findMany.mock.calls[0]![0].where).toEqual({
      businessUnitId: 'bu-1',
      status: 'OPEN',
    });
  });

  it('refuses a caller without risk:read', async () => {
    // Every role holds risk:read, so this asserts the guard is present at all
    // by removing the token rather than by finding a role that lacks it.
    const res = await app.inject({ method: 'GET', url: '/api/v1/risk/register' });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /risk/simulations', () => {
  it('lists simulations for anyone who may read risk', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/risk/simulations',
      headers: authHeader(app, VIEWER),
    });

    expect(res.statusCode).toBe(200);
  });

  it('bounds the page size rather than accepting any number', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/risk/simulations?limit=99999',
      headers: authHeader(app, VIEWER),
    });

    expect(res.statusCode).toBe(400);
  });

  it('404s on a simulation that does not exist', async () => {
    // A published contingency figure is quoted by its run. Asking for one that
    // is not there must say so rather than return an empty shell that reads as
    // a zero contingency.
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/risk/simulations/nope',
      headers: authHeader(app, VIEWER),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
