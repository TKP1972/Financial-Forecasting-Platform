/**
 * BASE_CURRENCY must reach every record that can carry a currency.
 *
 * Companion to org.currency.test.ts, which covers business units. The same
 * silent-failure path exists on all five: removing `.default('USD')` from the
 * shared contracts made `currency` optional, and Prisma accepts `undefined` by
 * falling back to the *column* default - still 'USD'. Nothing in the type
 * system, the response body or the test suite would object. A deployment could
 * set BASE_CURRENCY=EUR and quietly get USD rows on four of five models.
 *
 * So every assertion here is on the value handed to Prisma, never on the
 * response. The response looks correct either way, which is the whole problem.
 *
 * Budgets are deliberately absent: budget.service.ts resolves currency from the
 * budget's *cycle* (`payload.currency ?? cycle.baseCurrency`), which is a more
 * specific and more correct rule than a deployment-wide default. That path is
 * left alone, so there is nothing here to assert about it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  budgetCycle: { create: vi.fn() },
  rateCard: { create: vi.fn() },
  pricingModel: { create: vi.fn(), findFirst: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

// Audit appends run after each create and need the real chain; they have their
// own coverage. Unmocked, they turn a currency assertion into a 500.
vi.mock('../services/audit.service.js', () => ({
  appendAuditEntry: vi.fn(async () => ({ sequence: 1n, hash: 'test-hash' })),
}));

const { buildApp } = await import('../app.js');
const { config } = await import('../config.js');

/*
  A CFO, not an administrator.

  This suite used an ACTOR because it was the role that held everything, which
  stopped being true when the administrator lost its financial authority. The
  actor here is incidental to what is under test - the default currency - but
  picking the role that legitimately holds `cycle:manage` and `pricing:write`
  is the difference between a fixture and a fiction.
*/
const ACTOR = makeUser({ id: 'user-cfo', role: 'CFO' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  await app.ready();

  db.user.findUnique.mockResolvedValue(ACTOR);
  db.budgetCycle.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'cycle-1',
    ...data,
  }));
  db.rateCard.create.mockResolvedValue({ id: 'card-1', code: 'RC1', name: 'Card' });
  db.pricingModel.findFirst.mockResolvedValue(null);
  db.pricingModel.create.mockResolvedValue({ id: 'model-1', version: 1 });
});

/** The value actually handed to a Prisma create, by model. */
function sentToPrisma(model: { create: { mock: { calls: unknown[][] } } }, field: string): unknown {
  const call = model.create.mock.calls[0]?.[0] as Record<string, Record<string, unknown>>;
  return call?.data?.[field];
}

function post(url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, headers: authHeader(app, ACTOR), payload });
}

/**
 * Mirrors the engine's own worked fixture. An empty model is rejected with
 * CALCULATION_ERROR (422) - the engine will not price nothing, which is correct
 * and is not what this suite is testing. Shared by the persist and calculate
 * routes so both are exercised against an identical input.
 */
const model = (extra: Record<string, unknown> = {}) => ({
  name: 'Test Model',
  contractType: 'FIRM_FIXED_PRICE',
  years: 1,
  labour: [{ labourCategory: 'ENGINEER', hoursByYear: [1000], baseRate: '100.00' }],
  burdens: [{ pool: 'FRINGE', ratesByYear: ['0.30'] }],
  feeRate: '0.08',
  ...extra,
});

// --------------------------------------------------------------------------

describe('POST /cycles - baseCurrency default', () => {
  const cycle = (extra: Record<string, unknown> = {}) => ({
    name: 'FY2027 Budget',
    fiscalYear: 2027,
    opensAt: '2026-09-01',
    submissionDeadline: '2026-10-01',
    approvalDeadline: '2026-11-01',
    ...extra,
  });

  it('applies BASE_CURRENCY when the caller states none', async () => {
    const response = await post('/api/v1/cycles', cycle());

    expect(response.statusCode).toBe(201);
    expect(sentToPrisma(db.budgetCycle, 'baseCurrency')).toBe(config.BASE_CURRENCY);
    expect(sentToPrisma(db.budgetCycle, 'baseCurrency')).not.toBeUndefined();
  });

  it('honours an explicit baseCurrency', async () => {
    const response = await post('/api/v1/cycles', cycle({ baseCurrency: 'ZAR' }));

    expect(response.statusCode).toBe(201);
    expect(sentToPrisma(db.budgetCycle, 'baseCurrency')).toBe('ZAR');
  });

  it('still rejects a malformed code', async () => {
    const response = await post('/api/v1/cycles', cycle({ baseCurrency: 'RAND' }));

    expect(response.statusCode).toBe(400);
    expect(db.budgetCycle.create).not.toHaveBeenCalled();
  });
});

describe('POST /pricing/rate-cards - currency default', () => {
  const card = (extra: Record<string, unknown> = {}) => ({
    code: 'RC-TEST',
    name: 'Test Card',
    entries: [],
    ...extra,
  });

  it('applies BASE_CURRENCY when the caller states none', async () => {
    const response = await post('/api/v1/pricing/rate-cards', card());

    expect(response.statusCode).toBe(201);
    expect(sentToPrisma(db.rateCard, 'currency')).toBe(config.BASE_CURRENCY);
    expect(sentToPrisma(db.rateCard, 'currency')).not.toBeUndefined();
  });

  it('honours an explicit currency', async () => {
    const response = await post('/api/v1/pricing/rate-cards', card({ currency: 'GBP' }));

    expect(response.statusCode).toBe(201);
    expect(sentToPrisma(db.rateCard, 'currency')).toBe('GBP');
  });

  it('still rejects a malformed code', async () => {
    const response = await post('/api/v1/pricing/rate-cards', card({ currency: 'POUNDS' }));

    expect(response.statusCode).toBe(400);
    expect(db.rateCard.create).not.toHaveBeenCalled();
  });
});

describe('POST /pricing/models - currency default', () => {
  it('applies BASE_CURRENCY when the caller states none', async () => {
    const response = await post('/api/v1/pricing/models', model());

    expect(response.statusCode).toBe(201);
    expect(sentToPrisma(db.pricingModel, 'currency')).toBe(config.BASE_CURRENCY);
    expect(sentToPrisma(db.pricingModel, 'currency')).not.toBeUndefined();
  });

  it('honours an explicit currency', async () => {
    const response = await post('/api/v1/pricing/models', model({ currency: 'EUR' }));

    expect(response.statusCode).toBe(201);
    expect(sentToPrisma(db.pricingModel, 'currency')).toBe('EUR');
  });

  it('still rejects a malformed code', async () => {
    const response = await post('/api/v1/pricing/models', model({ currency: 'EUROS' }));

    expect(response.statusCode).toBe(400);
    expect(db.pricingModel.create).not.toHaveBeenCalled();
  });
});

describe('POST /pricing/calculate - the computed result carries a currency too', () => {
  // This route persists nothing, so the Prisma assertion above does not apply.
  // It still matters: the engine stamps a currency onto the returned build-up,
  // and a preview denominated differently from the model it becomes would be a
  // quiet inconsistency rather than an error.
  //
  // Honest limit, established by mutation testing rather than assumed: the
  // *default* case below is a weaker guard than the three suites above.
  // Removing `?? config.BASE_CURRENCY` from toEngineInput does NOT fail it,
  // because the engine applies its own `?? DEFAULT_CURRENCY` fallback and the
  // two resolve to the same value today. It would only catch a divergence once
  // a deployment sets BASE_CURRENCY to something other than DEFAULT_CURRENCY -
  // which is precisely when it would matter, so it is kept rather than deleted.
  // The explicit-currency case is a real guard at all times.
  it('stamps BASE_CURRENCY on a calculation with no stated currency', async () => {
    const response = await post('/api/v1/pricing/calculate', model());

    expect(response.statusCode).toBe(200);
    expect(response.json().data.currency).toBe(config.BASE_CURRENCY);
  });

  it('stamps an explicit currency when one is given', async () => {
    const response = await post('/api/v1/pricing/calculate', model({ currency: 'JPY' }));

    expect(response.statusCode).toBe(200);
    expect(response.json().data.currency).toBe('JPY');
  });
});
