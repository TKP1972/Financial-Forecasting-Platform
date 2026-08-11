/**
 * Route-level tests for issuing a leadership pack.
 *
 * `report:publish_leadership` was in the permission matrix and in the user
 * manual for months while guarding no route at all — a documented capability
 * that did not exist. These assert the action it was always describing, and in
 * particular the two properties that make it a control rather than a button:
 *
 *   1. The pack is **built server-side**, not accepted from the request. A
 *      published record the caller could compose would record whatever they
 *      chose to send, which is the opposite of an issued artefact.
 *   2. It is **frozen**. The pack is otherwise rebuilt live from budgets,
 *      actuals and forecasts, so regenerating it later gives different numbers
 *      and a figure quoted in a meeting traces back to nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  budgetCycle: { findUnique: vi.fn(), findFirst: vi.fn() },
  budget: { findMany: vi.fn() },
  // aggregate as well as findMany: buildLeadershipPack asks for the latest
  // period that has actuals, so it can report through that period rather than
  // comparing a full-year budget against year-to-date spend.
  actual: { findMany: vi.fn(), aggregate: vi.fn() },
  risk: { findMany: vi.fn() },
  publishedReport: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const ANALYST = makeUser({ id: 'user-analyst', role: 'ANALYST' });
const BUDGET_OWNER = makeUser({ id: 'user-owner', role: 'BUDGET_OWNER' });
const FINANCE_MANAGER = makeUser({ id: 'user-fm', role: 'FINANCE_MANAGER' });
const CFO = makeUser({ id: 'user-cfo', role: 'CFO' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();

  db.budgetCycle.findUnique.mockResolvedValue({
    id: 'cycle-1',
    name: 'FY2026 Annual Operating Plan',
    fiscalYear: 2026,
    periodType: 'MONTH',
    baseCurrency: 'USD',
    fiscalStartMonth: 1,
    fiscalYearLabel: 'START',
    horizonYears: 1,
    actualsThroughPeriod: 6,
    status: 'OPEN',
  });
  db.budget.findMany.mockResolvedValue([]);
  db.actual.findMany.mockResolvedValue([]);
  // No actuals in this fixture, so the pack falls back to the full year.
  db.actual.aggregate.mockResolvedValue({ _max: { periodIndex: null } });
  db.risk.findMany.mockResolvedValue([]);
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.publishedReport.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'published-1',
      title: data.title,
      throughPeriod: data.throughPeriod,
      publishedAt: new Date('2026-08-11T12:00:00.000Z'),
    }),
  );
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));

  app = await buildApp();
});

const publish = (user: ReturnType<typeof makeUser>, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/reports/leadership-pack/publish',
    headers: authHeader(app, user),
    payload: body,
  });

describe('POST /reports/leadership-pack/publish', () => {
  it('lets a Finance Manager issue a pack', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    const res = await publish(FINANCE_MANAGER, { cycleId: 'cycle-1', throughPeriod: 6 });

    expect(res.statusCode).toBe(201);
    expect(db.publishedReport.create).toHaveBeenCalledOnce();
    const stored = db.publishedReport.create.mock.calls[0]![0].data;
    expect(stored.publishedById).toBe(FINANCE_MANAGER.id);
    expect(stored.throughPeriod).toBe(6);
    // The snapshot is present and is an object, not a string reference to
    // something that would have to be rebuilt to be read.
    expect(stored.snapshot).toBeTypeOf('object');
    expect(stored.snapshot).not.toBeNull();
  });

  it('builds the pack itself rather than storing what the caller sent', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    const res = await publish(CFO, {
      cycleId: 'cycle-1',
      // A caller trying to dictate the contents of the record.
      snapshot: { totals: { variance: '0.0000' }, note: 'nothing to see' },
      pack: { fabricated: true },
    });

    expect(res.statusCode).toBe(201);
    const stored = db.publishedReport.create.mock.calls[0]![0].data;
    expect(JSON.stringify(stored.snapshot)).not.toContain('fabricated');
    expect(JSON.stringify(stored.snapshot)).not.toContain('nothing to see');
  });

  it('records the publication in the audit trail', async () => {
    db.user.findUnique.mockResolvedValue(FINANCE_MANAGER);

    await publish(FINANCE_MANAGER, { cycleId: 'cycle-1', note: 'August board pack' });

    expect(db.auditLog.create).toHaveBeenCalledOnce();
    const entry = db.auditLog.create.mock.calls[0]![0].data;
    expect(entry.entityType).toBe('PublishedReport');
    expect(entry.changes).toContain('August board pack');
  });

  it.each([
    ['ANALYST', ANALYST],
    ['BUDGET_OWNER', BUDGET_OWNER],
  ])('refuses a %s, before any write', async (_label, user) => {
    db.user.findUnique.mockResolvedValue(user);

    const res = await publish(user, { cycleId: 'cycle-1' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.publishedReport.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('takes a caller-supplied title, and falls back to the cycle name without one', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    await publish(CFO, { cycleId: 'cycle-1', title: 'Q3 board pack' });
    expect(db.publishedReport.create.mock.calls[0]![0].data.title).toBe('Q3 board pack');

    vi.clearAllMocks();
    db.user.findUnique.mockResolvedValue(CFO);
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.publishedReport.create.mockResolvedValue({
      id: 'published-2',
      title: 'x',
      throughPeriod: null,
      publishedAt: new Date(),
    });
    db.auditLog.findFirst.mockResolvedValue(null);

    await publish(CFO, { cycleId: 'cycle-1' });
    expect(db.publishedReport.create.mock.calls[0]![0].data.title).toContain(
      'FY2026 Annual Operating Plan',
    );
    // No period given means the pack is cut at the cycle's own position.
    expect(db.publishedReport.create.mock.calls[0]![0].data.throughPeriod).toBeNull();
  });

  it('rejects a request with no cycle', async () => {
    db.user.findUnique.mockResolvedValue(CFO);

    const res = await publish(CFO, {});

    expect(res.statusCode).toBe(400);
    expect(db.publishedReport.create).not.toHaveBeenCalled();
  });
});

describe('GET /reports/published', () => {
  it('is readable by anyone who may read a report', async () => {
    // What has been issued, and by whom, is not privileged. Restricting it to
    // publishers would hide the control from the people it exists to reassure.
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.publishedReport.findMany.mockResolvedValue([
      {
        id: 'published-1',
        title: 'FY2026 leadership pack',
        throughPeriod: 6,
        note: null,
        publishedAt: new Date('2026-08-11T12:00:00.000Z'),
        cycle: { id: 'cycle-1', name: 'FY2026 AOP', fiscalYear: 2026 },
        publishedBy: { id: 'user-fm', firstName: 'Thandi', lastName: 'Mokoena' },
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published',
      headers: authHeader(app, ANALYST),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].publishedBy.name).toBe('Thandi Mokoena');
  });

  it('filters by cycle when asked, and lists everything when not', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.publishedReport.findMany.mockResolvedValue([]);

    await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published?cycleId=cycle-1',
      headers: authHeader(app, ANALYST),
    });
    expect(db.publishedReport.findMany.mock.calls[0]![0].where).toEqual({ cycleId: 'cycle-1' });

    await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published',
      headers: authHeader(app, ANALYST),
    });
    expect(db.publishedReport.findMany.mock.calls[1]![0].where).toEqual({});
  });

  it('handles an issued pack whose publisher has since been removed', async () => {
    // publishedById is SET NULL on user deletion, so the record outlives the
    // account. The pack must still be readable - losing the record because the
    // person left would defeat the point of issuing it.
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.publishedReport.findMany.mockResolvedValue([
      {
        id: 'published-1',
        title: 'FY2026 leadership pack',
        throughPeriod: null,
        note: null,
        publishedAt: new Date('2026-08-11T12:00:00.000Z'),
        cycle: { id: 'cycle-1', name: 'FY2026 AOP', fiscalYear: 2026 },
        publishedBy: null,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published',
      headers: authHeader(app, ANALYST),
    });

    expect(res.json().data[0].publishedBy).toBeNull();
  });

  it('names the publisher on a single issued pack', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.publishedReport.findUnique.mockResolvedValue({
      id: 'published-1',
      title: 'FY2026 leadership pack',
      throughPeriod: 6,
      note: 'August board review',
      publishedAt: new Date('2026-08-11T12:00:00.000Z'),
      snapshot: { totals: {} },
      cycle: { id: 'cycle-1', name: 'FY2026 AOP', fiscalYear: 2026 },
      publishedBy: { id: 'user-fm', firstName: 'Peter', lastName: 'Nakamura' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published/published-1',
      headers: authHeader(app, ANALYST),
    });

    expect(res.json().data.publishedBy.name).toBe('Peter Nakamura');
    expect(res.json().data.note).toBe('August board review');
  });

  it('404s on an issued pack that does not exist', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.publishedReport.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published/nope',
      headers: authHeader(app, ANALYST),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns the frozen pack verbatim rather than rebuilding it', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);
    const frozen = { cycle: { name: 'FY2026 AOP' }, totals: { budget: '1000.0000' } };
    db.publishedReport.findUnique.mockResolvedValue({
      id: 'published-1',
      title: 'FY2026 leadership pack',
      throughPeriod: 6,
      note: null,
      publishedAt: new Date('2026-08-11T12:00:00.000Z'),
      snapshot: frozen,
      cycle: { id: 'cycle-1', name: 'FY2026 AOP', fiscalYear: 2026 },
      publishedBy: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/published/published-1',
      headers: authHeader(app, ANALYST),
    });

    expect(res.json().data.pack).toEqual(frozen);
    // Nothing was recomputed to answer this.
    expect(db.budget.findMany).not.toHaveBeenCalled();
    expect(db.actual.findMany).not.toHaveBeenCalled();
  });
});
