/**
 * Forecast run history and publication.
 *
 * `forecast:publish` is a governed permission — publishing marks a run as fit
 * to build a budget on — and these three routes had no test, no e2e suite and
 * no journey touching them.
 *
 * The interesting one is publish, because every other governed action in the
 * platform guards itself and this one does not: the budget transition guards on
 * status and version, the pricing approval guards on `approvedAt: null` and
 * answers CONFLICT on a race. Publish is a bare `update`, so these assert what
 * it actually does rather than what the pattern elsewhere would suggest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  forecastRun: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const VIEWER = makeUser({ id: 'u-viewer', role: 'VIEWER' });
const ANALYST = makeUser({ id: 'u-analyst', role: 'ANALYST' });
const OWNER = makeUser({ id: 'u-owner', role: 'BUDGET_OWNER' });

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    name: 'Mobile salaries FY2026',
    method: 'HOLT_WINTERS_ADDITIVE',
    autoSelected: true,
    horizon: 6,
    mape: { toString: () => '0.03800000' },
    mase: { toString: () => '0.61000000' },
    rmse: { toString: () => '12345.6000' },
    // The route stringifies these, so the double has to behave like a Decimal
    // rather than a number - a plain number has no toString the route can rely
    // on for precision, and confidenceLevel is not optional.
    confidenceLevel: { toString: () => '0.95000000' },
    scenarios: [],
    publishedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.forecastRun.findMany.mockResolvedValue([runRow()]);
  db.forecastRun.findUnique.mockResolvedValue(runRow());
  db.forecastRun.update.mockResolvedValue({
    id: 'run-1',
    name: 'Mobile salaries FY2026',
    publishedAt: new Date('2026-08-11T00:00:00.000Z'),
  });
  db.auditLog.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    typeof fn === 'function' ? fn(db) : fn,
  );
  app = await buildApp();
});

describe('GET /forecasts/runs', () => {
  it('lists runs for anyone who may read a forecast', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forecasts/runs',
      headers: authHeader(app, VIEWER),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('bounds the page size so a caller cannot ask for everything', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forecasts/runs?limit=5000',
      headers: authHeader(app, ANALYST),
    });

    // Rejected rather than silently clamped: a caller who asked for 5000 and
    // received 25 would believe they had them all.
    expect(res.statusCode).toBe(400);
  });

  it('filters by business unit when asked', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    await app.inject({
      method: 'GET',
      url: '/api/v1/forecasts/runs?businessUnitId=bu-1',
      headers: authHeader(app, ANALYST),
    });

    expect(db.forecastRun.findMany.mock.calls[0]![0].where).toEqual({ businessUnitId: 'bu-1' });
  });
});

describe('GET /forecasts/runs/:id', () => {
  it('returns a single run', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forecasts/runs/run-1',
      headers: authHeader(app, VIEWER),
    });

    expect(res.statusCode).toBe(200);
  });

  it('404s on a run that does not exist, rather than 500ing', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);
    db.forecastRun.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forecasts/runs/nope',
      headers: authHeader(app, VIEWER),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('POST /forecasts/runs/:id/publish', () => {
  const publish = (actor: ReturnType<typeof makeUser>, id = 'run-1') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/forecasts/runs/${id}/publish`,
      headers: authHeader(app, actor),
      payload: {},
    });

  it('lets a budget owner publish a run', async () => {
    // forecast:publish is held from Budget Owner upwards - the person
    // accountable for the numbers, not the person who produced them.
    db.user.findUnique.mockResolvedValue(OWNER);

    const res = await publish(OWNER);

    expect(res.statusCode).toBe(200);
    expect(res.json().data.publishedAt).toBeTruthy();
  });

  it('records the publication in the audit trail', async () => {
    db.user.findUnique.mockResolvedValue(OWNER);

    await publish(OWNER);

    const entry = db.auditLog.create.mock.calls[0]![0].data;
    expect(entry.entityType).toBe('ForecastRun');
    expect(entry.action).toBe('APPROVE');
  });

  it('refuses an analyst, before any write', async () => {
    // An analyst may run a forecast and may not declare it fit to budget on.
    // That separation is the whole point of the permission.
    db.user.findUnique.mockResolvedValue(ANALYST);

    const res = await publish(ANALYST);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(db.forecastRun.update).not.toHaveBeenCalled();
  });

  it('refuses a viewer, before any write', async () => {
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await publish(VIEWER);

    expect(res.statusCode).toBe(403);
    expect(db.forecastRun.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a run that does not exist', async () => {
    // The handler is a bare `update` with no existence check, so a missing row
    // surfaces as a Prisma P2025 rather than a deliberate NOT_FOUND. That is
    // fine *because* the error plugin maps P2025 to 404 - this asserts the
    // mapping, since without it a mistyped id would be a server error.
    //
    // Constructed as a real PrismaClientKnownRequestError: the plugin branches
    // on `instanceof`, so an Error with a `code` property looks nothing like
    // one and falls through to the 500 handler.
    db.user.findUnique.mockResolvedValue(OWNER);
    db.forecastRun.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );

    const res = await publish(OWNER, 'nope');

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
