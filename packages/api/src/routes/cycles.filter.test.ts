/**
 * Narrowing the cycle list by status.
 *
 * Nothing in this platform is deleted (DEL-01), so this list only grows. After
 * a few fiscal years most of it is finished work, and a selector that offers
 * fifteen cycles where three are live is a worse tool than one that offers
 * three.
 *
 * The important property is that **the default did not change**. A list
 * endpoint that starts hiding rows is a bad surprise for every caller already
 * relying on it — the e2e suites, the cycle selectors on four screens, and any
 * integration built against it. Narrowing is opt-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  budgetCycle: { findMany: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const VIEWER = makeUser({ id: 'user-viewer', role: 'VIEWER' });

function cycleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cycle-1',
    name: 'FY2026 Annual Operating Plan',
    fiscalYear: 2026,
    periodType: 'MONTH',
    status: 'OPEN',
    opensAt: new Date('2025-10-01T00:00:00.000Z'),
    submissionDeadline: new Date('2025-11-15T00:00:00.000Z'),
    approvalDeadline: new Date('2025-12-01T00:00:00.000Z'),
    baseCurrency: 'USD',
    horizonYears: 1,
    fiscalStartMonth: 1,
    fiscalYearLabel: 'START',
    actualsThroughPeriod: 0,
    rollingHorizonPeriods: 0,
    guidanceNotes: null,
    _count: { budgets: 4, assumptions: 3, targets: 2 },
    guidance: null,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue(VIEWER);
  db.budgetCycle.findMany.mockResolvedValue([cycleRow()]);
  app = await buildApp();
});

const list = (query = '') =>
  app.inject({ method: 'GET', url: `/api/v1/cycles${query}`, headers: authHeader(app, VIEWER) });

describe('GET /cycles', () => {
  it('returns every cycle when no status is given', async () => {
    const res = await list();

    expect(res.statusCode).toBe(200);
    // An empty `where` rather than a filtered one: the default must not narrow.
    expect(db.budgetCycle.findMany.mock.calls[0]![0].where).toEqual({});
  });

  it('narrows to a single status', async () => {
    await list('?status=OPEN');

    expect(db.budgetCycle.findMany.mock.calls[0]![0].where).toEqual({ status: { in: ['OPEN'] } });
  });

  it('accepts several statuses, which is how "in progress" is expressed', async () => {
    await list('?status=PLANNING,OPEN,CONSOLIDATING');

    expect(db.budgetCycle.findMany.mock.calls[0]![0].where).toEqual({
      status: { in: ['PLANNING', 'OPEN', 'CONSOLIDATING'] },
    });
  });

  it('tolerates spacing and casing, because a query string is typed by people', async () => {
    await list('?status=open, closed');

    expect(db.budgetCycle.findMany.mock.calls[0]![0].where).toEqual({
      status: { in: ['OPEN', 'CLOSED'] },
    });
  });

  it('treats an empty status as no filter rather than as "match nothing"', async () => {
    // A UI binding an empty select value must not accidentally ask for a list
    // that can never match.
    await list('?status=');

    expect(db.budgetCycle.findMany.mock.calls[0]![0].where).toEqual({});
  });

  it('rejects an unknown status instead of silently returning everything', async () => {
    const res = await list('?status=ARCHIVED');

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    // The message has to name the valid values, or the caller is guessing.
    expect(res.json().error.message).toContain('PLANNING');
    expect(db.budgetCycle.findMany).not.toHaveBeenCalled();
  });

  it('rejects a mix of valid and invalid rather than quietly dropping the bad one', async () => {
    const res = await list('?status=OPEN,NONSENSE');

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('NONSENSE');
    expect(db.budgetCycle.findMany).not.toHaveBeenCalled();
  });
});
