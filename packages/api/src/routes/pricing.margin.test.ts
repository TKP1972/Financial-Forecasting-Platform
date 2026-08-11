/**
 * `pricing:view_margin` must be enforced by the API, not by the browser.
 *
 * This is the only field-level restriction in the product: an Analyst may build
 * and check a cost volume without seeing the profit position on it. That makes
 * it the one permission a UI can appear to honour while not honouring it at
 * all — hiding a number in a React component satisfies every screenshot, every
 * reviewer reading the page, and every test that asserts against the rendered
 * output, while the value travels to the browser in the response.
 *
 * It failed exactly that way. `GET /pricing/pursuits` selected `grossMargin`
 * straight out of Prisma and returned it under `pricing:read`, which a VIEWER
 * holds. The Pricing screen rendered "Restricted" over the top, and told the
 * user in as many words that margin was "withheld by the API, not merely hidden
 * here" — which was untrue for that endpoint.
 *
 * The cause was not a missing concept. `redactMargin` existed and was applied on
 * three of the four handlers that can carry a saved model's figures. It was a
 * rule applied by hand, once per call site, and missed once. So these tests are
 * written against the **rule** rather than the endpoint that broke: each
 * response is searched recursively for any disclosed profit figure, because
 * naming the fields you expect is precisely how the leak got in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  pursuit: { findMany: vi.fn() },
  pricingModel: { findUnique: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

// Roles either side of the boundary. Budget Owner is the lowest holder, so it
// is the one that would break first if the matrix were tightened by accident.
const WITHHELD = [
  makeUser({ id: 'u-viewer', role: 'VIEWER' }),
  makeUser({ id: 'u-analyst', role: 'ANALYST' }),
];
const HOLDERS = [
  makeUser({ id: 'u-owner', role: 'BUDGET_OWNER' }),
  makeUser({ id: 'u-fm', role: 'FINANCE_MANAGER' }),
  makeUser({ id: 'u-cfo', role: 'CFO' }),
];

/** A pursuit with a real, non-zero margin on its latest model. */
function pursuitRow() {
  return {
    id: 'pursuit-1',
    name: 'National backhaul refresh',
    client: 'Acme Telecom',
    stage: 'BID',
    contractType: 'FIXED_PRICE',
    probabilityOfWin: { toString: () => '0.4500' },
    durationMonths: 36,
    expectedAwardDate: new Date('2026-11-01T00:00:00.000Z'),
    businessUnit: { id: 'bu-1', code: 'MOB', name: 'Mobile' },
    pricingModels: [
      {
        id: 'model-1',
        version: 4,
        totalPrice: { toString: () => '73398319.6755' },
        grossMargin: { toString: () => '0.08006109' },
      },
    ],
  };
}

/**
 * Every key that names a profit position, anywhere in a response.
 *
 * Deliberately broad and matched by key name rather than by path: a margin
 * nested inside a per-year breakdown, a list row or a summary string is
 * disclosed just as thoroughly as a top-level one.
 */
const MARGIN_KEYS =
  /^(grossMargin|latestMargin|margin|markup|grossProfit|profit|fee|effectiveFeeRate|npv|irr)$/i;

function disclosedMargins(value: unknown, path = '$'): string[] {
  const found: string[] = [];
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...disclosedMargins(v, `${path}[${i}]`)));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (MARGIN_KEYS.test(key) && v !== null && v !== undefined && typeof v !== 'object') {
        // A redacted field is null, or the zero redactMargin substitutes.
        // Anything else is a real figure that reached someone who may not see it.
        const numeric = Number(v);
        if (Number.isFinite(numeric) && numeric !== 0) found.push(`${path}.${key}=${String(v)}`);
      }
      found.push(...disclosedMargins(v, `${path}.${key}`));
    }
  }
  return found;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.pursuit.findMany.mockResolvedValue([pursuitRow()]);
  app = await buildApp();
});

describe('GET /pricing/pursuits', () => {
  it.each(WITHHELD)('discloses no profit figure to a $role', async (user) => {
    db.user.findUnique.mockResolvedValue(user);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/pursuits',
      headers: authHeader(app, user),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(
      disclosedMargins(body),
      'a margin figure reached a role without pricing:view_margin',
    ).toEqual([]);
    // Specifically, and independently of the recursive search.
    expect(body.data[0].latestMargin).toBeNull();
  });

  it.each(WITHHELD)('still gives a $role the price, which is not restricted', async (user) => {
    db.user.findUnique.mockResolvedValue(user);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/pursuits',
      headers: authHeader(app, user),
    });

    // Over-restriction is as much a defect as under-restriction, and far less
    // likely to be reported: a user who cannot do their job assumes they lack a
    // permission rather than that the product is broken.
    expect(res.json().data[0].latestPrice).toBe('73398319.6755');
  });

  it.each(HOLDERS)('gives a $role the margin they are entitled to', async (user) => {
    db.user.findUnique.mockResolvedValue(user);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/pursuits',
      headers: authHeader(app, user),
    });

    expect(res.statusCode).toBe(200);
    // 0.08006109 as stored: a rate, not a percentage, at numeric(18,8).
    expect(res.json().data[0].latestMargin).toBe('0.08006109');
  });
});

describe('a pursuit with nothing priced yet', () => {
  // The list has to answer for a pursuit that has no saved model at all -
  // every "latest" field falls back rather than reading index 0 of an empty
  // array. Worth its own case because the fallback is the state a pursuit is in
  // on the day it is created.
  it('reports nulls rather than failing', async () => {
    db.user.findUnique.mockResolvedValue(HOLDERS[0]!);
    db.pursuit.findMany.mockResolvedValue([{ ...pursuitRow(), pricingModels: [] }]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/pursuits',
      headers: authHeader(app, HOLDERS[0]!),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({
      latestPrice: null,
      latestMargin: null,
      latestModelId: null,
      latestApprovedAt: null,
    });
  });

  it('reports nulls to a non-holder too, without disclosing anything', async () => {
    db.user.findUnique.mockResolvedValue(WITHHELD[0]!);
    db.pursuit.findMany.mockResolvedValue([{ ...pursuitRow(), pricingModels: [] }]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/pursuits',
      headers: authHeader(app, WITHHELD[0]!),
    });

    expect(disclosedMargins(res.json())).toEqual([]);
  });
});

describe('GET /pricing/models/:id', () => {
  const model = (approvedBy: unknown) => ({
    id: 'model-1',
    name: 'National backhaul refresh',
    version: 4,
    contractType: 'MANAGED_SERVICE',
    currency: 'USD',
    years: 3,
    createdById: 'user-pricer',
    approvedAt: approvedBy ? new Date('2026-08-11T00:00:00.000Z') : null,
    approvedBy,
    pursuit: { id: 'pursuit-1', name: 'Backhaul', client: 'Acme', stage: 'BID' },
    input: {},
    result: {
      margin: { grossProfit: '5000.0000', grossMargin: '0.08', markup: '0.09' },
      effectiveFeeRate: '0.07',
      npv: '1234.0000',
      irr: '0.11',
      years: [],
      totals: { profit: '5000.0000', fee: '100.0000' },
    },
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  it('names the approver when the version is signed off', async () => {
    db.user.findUnique.mockResolvedValue(HOLDERS[2]!);
    db.pricingModel.findUnique.mockResolvedValue(
      model({ id: 'user-cfo', firstName: 'Nomsa', lastName: 'Dlamini' }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/models/model-1',
      headers: authHeader(app, HOLDERS[2]!),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.approvedBy.name).toBe('Nomsa Dlamini');
  });

  it('returns a null approver when it is not signed off', async () => {
    db.user.findUnique.mockResolvedValue(HOLDERS[2]!);
    db.pricingModel.findUnique.mockResolvedValue(model(null));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/models/model-1',
      headers: authHeader(app, HOLDERS[2]!),
    });

    expect(res.json().data.approvedBy).toBeNull();
    expect(res.json().data.approvedAt).toBeNull();
  });

  it('redacts the profit position for a non-holder', async () => {
    // Sign-off state is a governance fact and stays visible; the margin inside
    // the model does not.
    db.user.findUnique.mockResolvedValue(WITHHELD[1]!);
    db.pricingModel.findUnique.mockResolvedValue(
      model({ id: 'user-cfo', firstName: 'Nomsa', lastName: 'Dlamini' }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/models/model-1',
      headers: authHeader(app, WITHHELD[1]!),
    });

    expect(res.json().data.approvedBy.name).toBe('Nomsa Dlamini');
    expect(disclosedMargins(res.json().data.result)).toEqual([]);
  });

  it('404s on a model that does not exist', async () => {
    db.user.findUnique.mockResolvedValue(HOLDERS[2]!);
    db.pricingModel.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/models/nope',
      headers: authHeader(app, HOLDERS[2]!),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('the recursive search itself', () => {
  // A detector that never fires reads exactly like a control that works, so the
  // instrument is checked against a payload that is known to be leaking.
  it('finds a disclosed margin nested anywhere', () => {
    expect(disclosedMargins({ data: [{ latestMargin: '0.08' }] })).toEqual([
      '$.data[0].latestMargin=0.08',
    ]);
    expect(disclosedMargins({ a: { b: { years: [{ profit: '12.5' }] } } })).toEqual([
      '$.a.b.years[0].profit=12.5',
    ]);
  });

  it('tolerates the redacted forms, so a correct response is not flagged', () => {
    // null for the nullable fields, '0.0000' for the money ones redactMargin
    // zeroes rather than nulls.
    expect(
      disclosedMargins({
        margin: { grossMargin: null, grossProfit: '0.0000' },
        irr: null,
        npv: '0.0000',
      }),
    ).toEqual([]);
  });
});
