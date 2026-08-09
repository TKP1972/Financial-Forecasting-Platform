/**
 * BASE_CURRENCY must actually reach a created record.
 *
 * This is the test the typechecker could not give us. Removing `.default('USD')`
 * from the shared contracts made `currency` optional, and every consumer still
 * compiled - because Prisma accepts `undefined` and silently falls back to the
 * *column* default, which is still 'USD'. A deployment could set
 * BASE_CURRENCY=EUR, see no error anywhere, and get USD rows.
 *
 * So the assertion is on the value handed to Prisma, not on the response body:
 * the response would look correct either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  businessUnit: { create: vi.fn(), findUnique: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

// The route appends an audit entry after creating the unit. That path is
// covered by its own tests and needs the real chain; here it is noise, and
// leaving it unmocked turned a currency assertion into a 500.
vi.mock('../services/audit.service.js', () => ({
  appendAuditEntry: vi.fn(async () => ({ sequence: 1n, hash: 'test-hash' })),
}));

const { buildApp } = await import('../app.js');
const { config } = await import('../config.js');

const ADMIN = makeUser({ id: 'user-admin', role: 'ADMIN' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  await app.ready();
  db.user.findUnique.mockResolvedValue(ADMIN);
  db.businessUnit.create.mockImplementation(async ({ data }: { data: { currency: string } }) => ({
    id: 'bu-1',
    ...data,
    parent: null,
    owner: null,
  }));
});

/** The currency argument actually passed to prisma.businessUnit.create. */
function currencySentToPrisma(): unknown {
  const call = db.businessUnit.create.mock.calls[0]?.[0] as { data?: { currency?: unknown } };
  return call?.data?.currency;
}

async function createUnit(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/org/business-units',
    headers: authHeader(app, ADMIN),
    payload: body,
  });
}

describe('POST /org/business-units - currency default', () => {
  it('applies the configured BASE_CURRENCY when the caller states none', async () => {
    const response = await createUnit({ code: 'NEWBU', name: 'New Unit' });

    expect(response.statusCode).toBe(201);
    // Not `undefined` - that would let the Prisma column default decide, which
    // is the exact silent-USD failure this change exists to remove.
    expect(currencySentToPrisma()).toBe(config.BASE_CURRENCY);
    expect(currencySentToPrisma()).not.toBeUndefined();
  });

  it('honours an explicit currency over the configured default', async () => {
    const response = await createUnit({ code: 'EURBU', name: 'Euro Unit', currency: 'EUR' });

    expect(response.statusCode).toBe(201);
    expect(currencySentToPrisma()).toBe('EUR');
  });

  it('still rejects a malformed currency code', async () => {
    // Making the field optional must not make it unvalidated.
    const response = await createUnit({ code: 'BADBU', name: 'Bad', currency: 'EUROS' });

    expect(response.statusCode).toBe(400);
    expect(db.businessUnit.create).not.toHaveBeenCalled();
  });
});
