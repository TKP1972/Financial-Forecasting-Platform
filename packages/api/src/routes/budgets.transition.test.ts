/**
 * Route-level tests for the budget workflow transition.
 *
 * These assert that the governance controls are actually *reached* by the HTTP
 * route. `assertSeparationOfDuties` is unit-tested in shared/src/rbac.test.ts,
 * and that test proves the rule is correct - but a correct rule that no request
 * ever reaches protects nothing. The gap between "the function works" and "the
 * endpoint calls the function" is precisely where authorisation defects live,
 * and it is invisible to a unit test of either side on its own.
 *
 * Everything here runs through app.inject(): the real router, the real auth
 * plugin, the real error mapper. Only the database is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeUser, authHeader, type TestUser } from '../test-support/harness.js';

// --------------------------------------------------------------------------
// Database double
//
// vi.hoisted, because vi.mock is lifted above the imports and the factory would
// otherwise close over a variable that does not exist yet.
// --------------------------------------------------------------------------
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  budget: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { buildApp } = await import('../app.js');

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const PREPARER = makeUser({ id: 'user-preparer', role: 'BUDGET_OWNER' });
const SUBMITTER = makeUser({ id: 'user-submitter', role: 'BUDGET_OWNER' });
const APPROVER = makeUser({ id: 'user-approver', role: 'FINANCE_MANAGER' });

/**
 * A budget sitting in SUBMITTED, prepared and submitted by different people,
 * for an amount inside a FINANCE_MANAGER's default limit of 2,000,000.
 */
function submittedBudget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'budget-1',
    name: 'Mobile Network OPEX',
    status: 'SUBMITTED',
    version: 3,
    totalAmount: { toString: () => '1500000.0000' },
    currency: 'USD',
    preparedById: PREPARER.id,
    submittedById: SUBMITTER.id,
    businessUnitId: 'bu-mobile',
    businessUnit: { code: 'MOB' },
    cycle: { status: 'ACTIVE', name: 'FY2026 Budget' },
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  await app.ready();

  // Default: the transaction succeeds. Tests that must not reach it assert
  // that it was never called.
  db.$transaction.mockResolvedValue({ id: 'budget-1', status: 'APPROVED', version: 4 });
});

/** Authenticate as `actor` and attempt to move `budget` to `to`. */
async function transition(actor: TestUser, to: string, budget = submittedBudget()) {
  db.user.findUnique.mockResolvedValue(actor);
  db.budget.findUnique.mockResolvedValue(budget);

  return app.inject({
    method: 'POST',
    url: '/api/v1/budgets/budget-1/transition',
    headers: authHeader(app, actor),
    payload: { to },
  });
}

// --------------------------------------------------------------------------

describe('POST /budgets/:id/transition - authentication', () => {
  it('rejects a request with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/budgets/budget-1/transition',
      payload: { to: 'APPROVED' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(db.budget.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/budgets/budget-1/transition',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { to: 'APPROVED' },
    });

    expect(response.statusCode).toBe(401);
    expect(db.budget.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a valid token for an account that has since been deactivated', async () => {
    // The token is genuine; the account is not. Re-reading the user on every
    // request is what makes deactivation take effect immediately instead of at
    // token expiry.
    const response = await transition({ ...APPROVER, isActive: false }, 'APPROVED');

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toMatch(/no longer active/i);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /budgets/:id/transition - separation of duties', () => {
  // The control this suite exists for. Each of these is a request that reaches
  // the handler, passes authentication and role seniority, and must still be
  // refused.

  it('refuses to let the preparer approve their own budget', async () => {
    const response = await transition(
      makeUser({ id: PREPARER.id, role: 'FINANCE_MANAGER' }),
      'APPROVED',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SEPARATION_OF_DUTIES');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to let the submitter approve the budget they submitted', async () => {
    const response = await transition(
      makeUser({ id: SUBMITTER.id, role: 'FINANCE_MANAGER' }),
      'APPROVED',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SEPARATION_OF_DUTIES');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('applies the same bar to LOCKED, not only to APPROVED', async () => {
    // LOCKED is an approval too: it makes the budget the reporting baseline.
    // A bar that covered only APPROVED would leave the more consequential
    // transition open.
    const response = await transition(makeUser({ id: PREPARER.id, role: 'CFO' }), 'LOCKED', {
      ...submittedBudget(),
      status: 'APPROVED',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SEPARATION_OF_DUTIES');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('has no ADMIN bypass', async () => {
    // CLAUDE.md states this control must not gain a role exemption, including
    // for ADMIN. ADMIN also has an unlimited approval limit, so if any role
    // could slip through on seniority it would be this one.
    const response = await transition(makeUser({ id: PREPARER.id, role: 'ADMIN' }), 'APPROVED');

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SEPARATION_OF_DUTIES');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('allows an approver who neither prepared nor submitted it', async () => {
    // The positive control. Without it, every assertion above would still pass
    // if the endpoint simply refused everything.
    const response = await transition(APPROVER, 'APPROVED');

    expect(response.statusCode).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('POST /budgets/:id/transition - role seniority', () => {
  it('refuses a role below the minimum for the target status', async () => {
    // APPROVED requires FINANCE_MANAGER. A BUDGET_OWNER is refused here, on
    // seniority, before delegated authority is ever consulted - which is why
    // the assertions in this file check the error code and not merely the 403.
    const response = await transition(
      makeUser({ id: 'user-other-owner', role: 'BUDGET_OWNER' }),
      'APPROVED',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(response.json().error.details).toMatchObject({
      required: 'FINANCE_MANAGER',
      actual: 'BUDGET_OWNER',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /budgets/:id/transition - delegated authority', () => {
  // 3,000,000 against FINANCE_MANAGER's default limit of 2,000,000: senior
  // enough for the transition, not authorised for the amount.
  const largeBudget = () => submittedBudget({ totalAmount: { toString: () => '3000000.0000' } });

  it('refuses an amount above the actor’s limit', async () => {
    const response = await transition(APPROVER, 'APPROVED', largeBudget());

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('DELEGATED_AUTHORITY_EXCEEDED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('honours a per-user limit above the role default', async () => {
    // Same role, same amount, same budget - only the per-user override differs,
    // so this isolates the override as the thing that grants authority.
    const response = await transition(
      makeUser({
        id: 'user-elevated',
        role: 'FINANCE_MANAGER',
        approvalLimit: { toString: () => '5000000' },
      }),
      'APPROVED',
      largeBudget(),
    );

    expect(response.statusCode).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('POST /budgets/:id/transition - workflow rules', () => {
  it('rejects an unknown target status before touching the database', async () => {
    const response = await transition(APPROVER, 'NOT_A_STATUS');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to reopen a locked budget', async () => {
    const response = await transition(APPROVER, 'DRAFT', {
      ...submittedBudget(),
      status: 'LOCKED',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 for a budget that does not exist', async () => {
    const response = await transition(APPROVER, 'APPROVED', null as never);

    expect(response.statusCode).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
