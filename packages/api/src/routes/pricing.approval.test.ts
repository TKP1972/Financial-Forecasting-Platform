/**
 * Route-level tests for commercial sign-off on a bid price.
 *
 * The controls themselves are unit-tested in `shared/src/rbac.test.ts`. What
 * these assert is that the HTTP route actually *reaches* them — the gap between
 * "the rule is correct" and "the endpoint applies the rule" is where
 * authorisation defects live, and it is invisible to a unit test of either side.
 *
 * Four separate controls can refuse this endpoint and **three of them answer
 * 403**: role seniority (`FORBIDDEN`), separation of duties
 * (`SEPARATION_OF_DUTIES`) and delegated authority
 * (`DELEGATED_AUTHORITY_EXCEEDED`). A bare `expect(403)` would pass for the
 * wrong reason, so every refusal here asserts the error code.
 *
 * Each refusal also asserts that **no write was attempted** — a control that
 * refuses after modifying the row passes a status check while leaving damage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  pricingModel: { findUnique: vi.fn(), updateMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const PRICER = makeUser({ id: 'user-pricer', role: 'ANALYST' });
// 2,000,000 default limit — below the bid price used here, deliberately.
const FINANCE_MANAGER = makeUser({ id: 'user-fm', role: 'FINANCE_MANAGER' });
// Unlimited.
const CFO = makeUser({ id: 'user-cfo', role: 'CFO' });

/**
 * A saved bid at 73,398,319.6755 — the seeded pursuit's real figure.
 *
 * Chosen rather than a round number because it is above a Finance Manager's
 * 2,000,000 limit and below a CFO's unlimited one, which is what makes the
 * delegated-authority test meaningful rather than incidental.
 */
function savedModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    name: 'National backhaul refresh',
    version: 4,
    totalPrice: { toString: () => '73398319.6755' },
    currency: 'USD',
    approvedAt: null,
    approvedById: null,
    createdById: PRICER.id,
    pursuitId: 'pursuit-1',
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.pricingModel.findUnique.mockResolvedValue(savedModel());
  db.pricingModel.updateMany.mockResolvedValue({ count: 1 });
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  // Run the callback against the same doubles, so a guard that fires before the
  // transaction is distinguishable from one that fires inside it.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  app = await buildApp();
});

const approve = (user: ReturnType<typeof makeUser>, body: unknown = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/pricing/models/model-1/approve',
    headers: authHeader(app, user),
    payload: body,
  });

describe('POST /pricing/models/:id/approve', () => {
  it('lets a CFO approve a price someone else built', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    const res = await approve(CFO, { comment: 'Board reviewed 11 Aug' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.approvedById).toBe(CFO.id);
    expect(db.pricingModel.updateMany).toHaveBeenCalledOnce();
    // Guarded on the row still being unapproved, so two approvers racing the
    // same version cannot both win.
    expect(db.pricingModel.updateMany.mock.calls[0]![0].where).toMatchObject({
      id: 'model-1',
      approvedAt: null,
    });
  });

  it('records the approval in the audit trail', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    await approve(CFO);

    expect(db.auditLog.create).toHaveBeenCalledOnce();
    const entry = db.auditLog.create.mock.calls[0]![0].data;
    expect(entry.action).toBe('APPROVE');
    expect(entry.entityType).toBe('PricingModel');
    // The price is in the summary: "what was signed off" must be answerable
    // from the trail without re-reading a mutable row.
    expect(entry.summary).toContain('73398319.6755');
  });

  it('refuses an ANALYST for want of the permission, before any write', async () => {
    db.user.findUnique.mockResolvedValue(PRICER);

    const res = await approve(PRICER);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.pricingModel.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the person who built the price, by separation of duties', async () => {
    // A CFO who is also the author. Seniority is not a bypass — that is the
    // entire point of the control.
    const cfoWhoPriced = makeUser({ id: 'user-cfo-priced', role: 'CFO' });
    db.user.findUnique.mockResolvedValue(cfoWhoPriced);
    db.pricingModel.findUnique.mockResolvedValue(savedModel({ createdById: cfoWhoPriced.id }));

    const res = await approve(cfoWhoPriced);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SEPARATION_OF_DUTIES');
    expect(db.pricingModel.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an approver whose delegated authority is below the price', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    const res = await approve(FINANCE_MANAGER);

    expect(res.statusCode).toBe(403);
    // Distinct from FORBIDDEN: the role is right, the amount is not. Reporting
    // this as a permissions problem would send someone to the wrong fix.
    expect(res.json().error.code).toBe('DELEGATED_AUTHORITY_EXCEEDED');
    expect(db.pricingModel.updateMany).not.toHaveBeenCalled();
  });

  it('lets a Finance Manager approve a price inside their limit', async () => {
    // The same control, passing — so the test above is known to be measuring
    // the amount rather than the role.
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);
    db.pricingModel.findUnique.mockResolvedValue(
      savedModel({ totalPrice: { toString: () => '1500000.0000' } }),
    );

    const res = await approve(FINANCE_MANAGER);

    expect(res.statusCode).toBe(200);
    expect(db.pricingModel.updateMany).toHaveBeenCalledOnce();
  });

  it('refuses to approve a version that is already approved', async () => {
    db.user.findUnique.mockResolvedValue(CFO);
    db.pricingModel.findUnique.mockResolvedValue(
      savedModel({ approvedAt: new Date('2026-08-01T00:00:00.000Z'), approvedById: 'someone' }),
    );

    const res = await approve(CFO);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(db.pricingModel.updateMany).not.toHaveBeenCalled();
  });

  it('reports a concurrent approval as a conflict rather than succeeding', async () => {
    // The row was unapproved when read and approved by the time of the write.
    db.user.findUnique.mockResolvedValue(CFO);
    db.pricingModel.updateMany.mockResolvedValue({ count: 0 });

    const res = await approve(CFO);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('404s on a model that does not exist', async () => {
    db.user.findUnique.mockResolvedValue(CFO);
    db.pricingModel.findUnique.mockResolvedValue(null);

    const res = await approve(CFO);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('POST /pricing/models/:id/withdraw-approval', () => {
  const withdraw = (user: ReturnType<typeof makeUser>, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/pricing/models/model-1/withdraw-approval',
      headers: authHeader(app, user),
      payload: body,
    });

  const approved = () =>
    savedModel({ approvedAt: new Date('2026-08-01T00:00:00.000Z'), approvedById: CFO.id });

  it('clears the sign-off and records why', async () => {
    db.user.findUnique.mockResolvedValue(CFO);
    db.pricingModel.findUnique.mockResolvedValue(approved());

    const res = await withdraw(CFO, { reason: 'Scope changed after client call' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.approvedAt).toBeNull();
    expect(db.pricingModel.updateMany.mock.calls[0]![0].data).toMatchObject({
      approvedAt: null,
      approvedById: null,
    });
    const entry = db.auditLog.create.mock.calls[0]![0].data;
    expect(entry.action).toBe('REJECT');
    expect(entry.changes).toContain('Scope changed after client call');
  });

  it('allows an approver other than the one who signed it off', async () => {
    // Deliberate: a price whose assumptions have moved must stop being approved
    // regardless of who is available. Requiring the original approver would
    // leave a stale sign-off standing exactly when someone has spotted it.
    const otherCfo = makeUser({ id: 'user-cfo-2', role: 'CFO' });
    db.user.findUnique.mockResolvedValue(otherCfo);
    db.pricingModel.findUnique.mockResolvedValue(approved());

    const res = await withdraw(otherCfo);

    expect(res.statusCode).toBe(200);
  });

  it('refuses a role without pricing:approve, before any write', async () => {
    db.user.findUnique.mockResolvedValue(PRICER);
    db.pricingModel.findUnique.mockResolvedValue(approved());

    const res = await withdraw(PRICER);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.pricingModel.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to withdraw an approval that was never given', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    const res = await withdraw(CFO);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(db.pricingModel.updateMany).not.toHaveBeenCalled();
  });
});
