/**
 * Returning a budget for revision must clear the sign-offs that are now stale.
 *
 * The transition service already does this for DRAFT, and its comment states
 * exactly why: *"leaving them in place would let a stale approval carry over
 * onto edited numbers."*
 *
 * That reasoning applies identically to IN_REVIEW, which `replaceBudgetLines`
 * also treats as editable — and `APPROVED -> IN_REVIEW` is a legal transition.
 * So an approved budget could be pulled back, edited, and still carry the
 * approver and approval date of the numbers that person actually signed off.
 * The web app displays both fields, so the stale value is not merely stored, it
 * is shown.
 *
 * These tests assert the data handed to Prisma, because the response body does
 * not include the cleared fields and would look correct either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  budget: { findUnique: vi.fn(), update: vi.fn() },
  budgetVersion: { create: vi.fn() },
  approval: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: db }));
vi.mock('./audit.service.js', () => ({
  appendAuditEntry: vi.fn(async () => ({ sequence: 1n, hash: 'test-hash' })),
}));
vi.mock('./notification.service.js', () => ({
  notificationsForTransition: vi.fn(async () => []),
  enqueueNotifications: vi.fn(async () => 0),
  resolveApprovers: vi.fn(async () => []),
}));

const { transitionBudget } = await import('./budget.service.js');

const CFO = {
  id: 'user-cfo',
  email: 'cfo@ffp.test',
  firstName: 'Casey',
  lastName: 'Ofori',
  role: 'CFO' as const,
  businessUnitId: null,
  approvalLimit: null,
};

/** An approved budget, signed off by someone other than the actor. */
function approvedBudget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'budget-1',
    name: 'Mobile OPEX',
    status: 'APPROVED',
    version: 4,
    totalAmount: { toString: () => '500000.0000' },
    currency: 'USD',
    preparedById: 'user-analyst',
    submittedById: 'user-owner',
    businessUnitId: 'bu-1',
    businessUnit: { code: 'MOB' },
    cycle: { status: 'OPEN', name: 'FY2026' },
    ...overrides,
  };
}

/** The `data` object handed to prisma.budget.update. */
function updatePayload(): Record<string, unknown> {
  const call = db.budget.update.mock.calls[0]?.[0] as { data?: Record<string, unknown> };
  return call?.data ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  // Execute the callback so the writes inside the transaction are observable.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      budget: db.budget,
      budgetVersion: db.budgetVersion,
      approval: db.approval,
      // snapshotVersion freezes the lines, so the fake transaction needs them.
      budgetLine: { findMany: vi.fn(async () => []) },
      auditLog: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      notification: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    }),
  );
  db.budget.update.mockResolvedValue({ id: 'budget-1' });
  db.budgetVersion.create.mockResolvedValue({ id: 'version-1' });
  db.approval.create.mockResolvedValue({ id: 'approval-1' });
});

describe('returning an APPROVED budget to IN_REVIEW', () => {
  it('clears the approval, because IN_REVIEW is editable', async () => {
    db.budget.findUnique.mockResolvedValue(approvedBudget());

    await transitionBudget('budget-1', 'IN_REVIEW', CFO);

    const data = updatePayload();
    expect(data.status).toBe('IN_REVIEW');
    // The whole point: an approval that no longer corresponds to the numbers
    // must not survive into a state where those numbers can change.
    expect(data.approvedBy).toEqual({ disconnect: true });
    expect(data.approvedAt).toBeNull();
  });

  it('clears the submission too, matching what DRAFT already does', async () => {
    db.budget.findUnique.mockResolvedValue(approvedBudget());

    await transitionBudget('budget-1', 'IN_REVIEW', CFO);

    const data = updatePayload();
    expect(data.submittedBy).toEqual({ disconnect: true });
    expect(data.submittedAt).toBeNull();
  });

  it('leaves the preparer alone', async () => {
    // preparedById records who originated the budget and is not a sign-off.
    // Clearing it would break the separation-of-duties check, which bars the
    // preparer from approving regardless of how many revisions have happened.
    db.budget.findUnique.mockResolvedValue(approvedBudget());

    await transitionBudget('budget-1', 'IN_REVIEW', CFO);

    expect(updatePayload()).not.toHaveProperty('preparedBy');
  });
});

describe('the existing DRAFT behaviour is unchanged', () => {
  it('returning a REJECTED budget to DRAFT still clears both sign-offs', async () => {
    db.budget.findUnique.mockResolvedValue(
      approvedBudget({ status: 'REJECTED', approvedById: null }),
    );

    await transitionBudget('budget-1', 'DRAFT', CFO);

    const data = updatePayload();
    expect(data.approvedBy).toEqual({ disconnect: true });
    expect(data.submittedBy).toEqual({ disconnect: true });
  });
});

describe('forward transitions do not clear anything', () => {
  it('SUBMITTED -> APPROVED records the approver rather than clearing', async () => {
    db.budget.findUnique.mockResolvedValue(approvedBudget({ status: 'SUBMITTED', version: 3 }));

    await transitionBudget('budget-1', 'APPROVED', CFO);

    const data = updatePayload();
    expect(data.approvedBy).toEqual({ connect: { id: CFO.id } });
    expect(data.approvedAt).toBeInstanceOf(Date);
  });
});
