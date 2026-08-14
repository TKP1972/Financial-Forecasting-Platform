/**
 * The route that made driver-based planning reachable.
 *
 * `drivers` was seeded from the beginning and read by nothing. The engine could
 * build a driver forecast and compare scenarios, and `/drivers/build` and
 * `/scenarios/compare` both worked — but each takes drivers in the request
 * body, so a client had no way to discover what drivers existed. The capability
 * was complete and unreachable, which is the fifth instance of that shape in
 * this codebase.
 *
 * The property worth protecting is the one that makes the screen possible:
 * **this response round-trips**. A caller takes it, edits it, and posts it back
 * to `/scenarios/compare` without reshaping anything. If the two shapes drift,
 * the planner breaks in a way that looks like a UI bug.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { driverSchema } from '@ffp/shared';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  driver: { findMany: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const VIEWER = makeUser({ id: 'u-viewer', role: 'VIEWER' });
const ANALYST = makeUser({ id: 'u-analyst', role: 'ANALYST' });

function driverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'driver-1',
    code: 'SUBS_POST',
    name: 'Postpaid subscribers',
    unit: 'subscribers',
    description: null,
    businessUnit: { id: 'bu-1', code: 'MOB', name: 'Mobile Networks' },
    volumes: ['100000.0000', '102000.0000', '104000.0000'],
    unitRate: '45.0000',
    // Prisma returns a Decimal; the route must stringify it rather than leak
    // the object into JSON.
    growthRate: { toString: () => '0.02000000' },
    isActive: true,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.driver.findMany.mockResolvedValue([driverRow()]);
  app = await buildApp();
});

const list = (user: ReturnType<typeof makeUser>, query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/v1/forecasts/drivers${query}`,
    headers: authHeader(app, user),
  });

describe('GET /forecasts/drivers', () => {
  it('is readable by anyone who can read a forecast', async () => {
    // Deliberately forecast:read, not forecast:run. Seeing which drivers the
    // business plans on is not the same as running a projection with them.
    db.user.findUnique.mockResolvedValue(VIEWER);

    const res = await list(VIEWER);

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('returns a shape that posts straight back to the scenario endpoint', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    const driver = list(ANALYST);
    const body = (await driver).json().data[0];

    // The actual round-trip, validated against the contract the compare and
    // build endpoints parse with. This is the assertion that keeps the planner
    // working: if either side drifts, this fails here rather than in a browser.
    const parsed = driverSchema.safeParse({
      code: body.code,
      name: body.name,
      unit: body.unit,
      volumes: body.volumes,
      unitRate: body.unitRate,
      ...(body.growthRate ? { growthRate: body.growthRate } : {}),
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('stringifies the growth rate rather than leaking a Decimal', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    expect((await list(ANALYST)).json().data[0].growthRate).toBe('0.02000000');
  });

  it('reports a null growth rate rather than omitting it', async () => {
    // A driver with no growth is the common case. The field must still be
    // present so a client can tell "no growth" from "field missing".
    db.user.findUnique.mockResolvedValue(ANALYST);
    db.driver.findMany.mockResolvedValue([driverRow({ growthRate: null })]);

    const body = (await list(ANALYST)).json().data[0];

    expect(body).toHaveProperty('growthRate');
    expect(body.growthRate).toBeNull();
  });

  it('hides inactive drivers by default and includes them on request', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    await list(ANALYST);
    expect(db.driver.findMany.mock.calls[0]![0].where).toEqual({ isActive: true });

    await list(ANALYST, '?includeInactive=true');
    expect(db.driver.findMany.mock.calls[1]![0].where).toEqual({});
  });

  it('treats includeInactive=false as false, not as truthy', async () => {
    // z.coerce.boolean() would make the string "false" true. queryBoolean is
    // used precisely because that trap has bitten this codebase before.
    db.user.findUnique.mockResolvedValue(ANALYST);

    await list(ANALYST, '?includeInactive=false');

    expect(db.driver.findMany.mock.calls[0]![0].where).toEqual({ isActive: true });
  });

  it('filters by business unit when asked', async () => {
    db.user.findUnique.mockResolvedValue(ANALYST);

    await list(ANALYST, '?businessUnitId=bu-1');

    expect(db.driver.findMany.mock.calls[0]![0].where).toEqual({
      isActive: true,
      businessUnitId: 'bu-1',
    });
  });
});
