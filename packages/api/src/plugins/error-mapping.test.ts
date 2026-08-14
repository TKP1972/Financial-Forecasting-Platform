/**
 * The translation layer every route depends on and none of them owns.
 *
 * Handlers throw `AppError` for things they decide, and let Prisma throw for
 * things the database decides — a duplicate email, a foreign key that still has
 * children, a row that is not there. What the caller sees for those is decided
 * entirely here, and it had no direct test: a `P2002` mapped to 500 would turn
 * "that email is already registered" into "something went wrong", which is the
 * difference between a form a user can correct and a support ticket.
 *
 * Driven through a real route rather than by calling the mapper, because the
 * mapper is only correct if the plugin is actually reached: `instanceof
 * Prisma.PrismaClientKnownRequestError` is the branch, and an error that merely
 * carries a `code` property falls past it to the 500 handler. That mistake was
 * made while writing these.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { makeUser, authHeader } from '../test-support/harness.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  forecastRun: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

const VIEWER = makeUser({ id: 'u-viewer', role: 'VIEWER' });

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue(VIEWER);
  db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  app = await buildApp();
});

/** Any authenticated read; the route is incidental, the thrown error is not. */
const trigger = () =>
  app.inject({
    method: 'GET',
    url: '/api/v1/forecasts/runs/run-1',
    headers: authHeader(app, VIEWER),
  });

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('database said no', {
    code,
    clientVersion: 'test',
    ...(meta ? { meta } : {}),
  });

describe('Prisma errors become answers a caller can act on', () => {
  it('maps a unique violation to 409 and names the field', async () => {
    // The field name is the whole value of this branch: "a record with this
    // email already exists" tells a user what to change. "Conflict" does not.
    db.forecastRun.findUnique.mockRejectedValue(prismaError('P2002', { target: ['email'] }));

    const res = await trigger();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(res.json().error.message).toContain('email');
  });

  it('handles a unique violation whose target is a bare string', async () => {
    // Prisma reports `target` as an array for a composite key and a string for
    // a single column, depending on the connector. Both reach this branch.
    db.forecastRun.findUnique.mockRejectedValue(prismaError('P2002', { target: 'code' }));

    const res = await trigger();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('code');
  });

  it('handles a unique violation with no target at all', async () => {
    db.forecastRun.findUnique.mockRejectedValue(prismaError('P2002'));

    const res = await trigger();

    expect(res.statusCode).toBe(409);
    // Falls back to a generic word rather than printing "undefined" at a user.
    expect(res.json().error.message).not.toContain('undefined');
  });

  it('maps a foreign-key violation to 409, not to a server error', async () => {
    // Deleting an account that budget lines still reference is the caller's
    // mistake to fix, not a fault.
    db.forecastRun.findUnique.mockRejectedValue(prismaError('P2003'));

    const res = await trigger();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('maps a missing record to 404', async () => {
    db.forecastRun.findUnique.mockRejectedValue(prismaError('P2025'));

    const res = await trigger();

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('maps an unrecognised Prisma code to 400 rather than 500', async () => {
    // An unknown database complaint is more likely a bad request than a broken
    // server, and answering 400 keeps it out of the error budget that pages
    // somebody at night.
    db.forecastRun.findUnique.mockRejectedValue(prismaError('P2099'));

    const res = await trigger();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('maps a Prisma validation error to 400 without leaking the query', async () => {
    // These carry the generated SQL and the model shape. Useful in a log,
    // never in a response.
    db.forecastRun.findUnique.mockRejectedValue(
      new Prisma.PrismaClientValidationError('Argument `where` is missing.', {
        clientVersion: 'test',
      }),
    );

    const res = await trigger();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.json())).not.toContain('where');
  });

  it('answers 500 for an error it does not recognise, without echoing it', async () => {
    db.forecastRun.findUnique.mockRejectedValue(new Error('connection pool exhausted at 0x7f'));

    const res = await trigger();

    expect(res.statusCode).toBe(500);
    // The internals stay in the log. A caller gets something safe to show.
    expect(JSON.stringify(res.json())).not.toContain('0x7f');
  });
});

describe('health probes report what an orchestrator needs', () => {
  it('is ready when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database).toBe('ok');
  });

  it('is 503, not 500, when the database does not answer', async () => {
    // The distinction matters operationally: 503 takes the container out of
    // rotation and lets the orchestrator retry, while a 500 reads as an
    // application fault and can trip an error budget for a dependency outage.
    db.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe('unavailable');
  });

  it('stays alive even when the database is down', async () => {
    // Liveness asks "is this process working", not "are its dependencies".
    // Conflating them makes an orchestrator restart a healthy container over
    // and over while the real problem is elsewhere.
    db.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.inject({ method: 'GET', url: '/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
