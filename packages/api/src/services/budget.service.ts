/**
 * Budget lifecycle and the governance controls around it.
 *
 * The workflow transition is the one operation in the platform that must be
 * airtight, because everything downstream - variance reporting, consolidation,
 * the leadership pack - assumes an approved budget was approved properly. Five
 * checks run before any transition is written, and all of them plus the version
 * snapshot and the audit entry commit in a single transaction.
 */
import {
  effectiveApprovalLimit,
  AppError,
  BUDGET_TRANSITIONS,
  Decimal,
  InvalidTransitionError,
  TRANSITION_MIN_ROLE,
  TRANSITION_PERMISSION,
  add,
  assertSeparationOfDuties,
  assertWithinDelegatedAuthority,
  atLeast,
  can,
  buildPeriodAxis,
  periodKey as makePeriodKey,
  type PeriodType,
  toMoneyString,
  type BudgetStatus,
  type Role,
} from '@ffp/shared';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { appendAuditEntry } from './audit.service.js';
import type { AuthenticatedUser } from './auth.service.js';
import { enqueueNotifications, notificationsForTransition } from './notification.service.js';

export interface BudgetLineDraft {
  accountId: string;
  costCategory?: string | null;
  method?: string;
  description?: string | null;
  periodAmounts: string[];
  driverId?: string | null;
  strategicObjectiveId?: string | null;
  alignment?: string;
  justification?: string | null;
}

export interface CreateBudgetPayload {
  cycleId: string;
  businessUnitId: string;
  name: string;
  currency?: string;
  lines?: BudgetLineDraft[];
}

/**
 * The period axis a budget must be entered against.
 *
 * A single-year cycle is the twelve months of its fiscal year; a Medium Term
 * Plan spans `horizonYears` of them. Deriving this in one place means adding
 * multi-year support did not require touching the amount-handling code at all.
 */
function periodAxisFor(cycle: {
  fiscalYear: number;
  periodType: PeriodType;
  horizonYears: number;
}): Array<{ key: string }> {
  // One helper for both the single-year and multi-year case, and the same one
  // GET /cycles/:id uses to advertise the axis. They were separate before, and
  // they disagreed for multi-year cycles.
  return buildPeriodAxis(cycle.fiscalYear, Math.max(cycle.horizonYears, 1), cycle.periodType).map(
    (p) => ({ key: p.key }),
  );
}

/** Sum every period of every line. The budget total is derived, never entered. */
function totalOf(lines: readonly BudgetLineDraft[]): Decimal {
  if (lines.length === 0) return new Decimal(0);
  const amounts = lines.flatMap((line) => line.periodAmounts);
  return amounts.length === 0 ? new Decimal(0) : add(...amounts);
}

export async function createBudget(
  payload: CreateBudgetPayload,
  actor: AuthenticatedUser,
  context: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ id: string }> {
  const cycle = await prisma.budgetCycle.findUnique({ where: { id: payload.cycleId } });
  if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${payload.cycleId}' was not found.`);
  if (cycle.status === 'CLOSED') {
    throw new AppError(
      'CONFLICT',
      'This budget cycle is closed and no longer accepts submissions.',
    );
  }

  const periods = periodAxisFor(cycle);
  const lines = payload.lines ?? [];

  for (const [index, line] of lines.entries()) {
    if (line.periodAmounts.length !== periods.length) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Line ${index + 1} supplies ${line.periodAmounts.length} period amounts, but this cycle has ${periods.length} ${cycle.periodType.toLowerCase()} periods.`,
        {
          details: {
            lineIndex: index,
            expected: periods.length,
            received: line.periodAmounts.length,
          },
        },
      );
    }
  }

  const total = totalOf(lines);

  return prisma.$transaction(async (tx) => {
    const budget = await tx.budget.create({
      data: {
        cycleId: payload.cycleId,
        businessUnitId: payload.businessUnitId,
        name: payload.name,
        currency: payload.currency ?? cycle.baseCurrency,
        status: 'DRAFT',
        preparedById: actor.id,
        totalAmount: total.toFixed(4),
        lines: {
          create: lines.map((line, index) => ({
            accountId: line.accountId,
            costCategory: (line.costCategory ?? null) as never,
            method: (line.method ?? 'INCREMENTAL') as never,
            description: line.description ?? null,
            driverId: line.driverId ?? null,
            strategicObjectiveId: line.strategicObjectiveId ?? null,
            alignment: (line.alignment ?? 'SUPPORTING') as never,
            justification: line.justification ?? null,
            sortOrder: index,
            totalAmount: (line.periodAmounts.length === 0
              ? new Decimal(0)
              : add(...line.periodAmounts)
            ).toFixed(4),
            periods: {
              create: line.periodAmounts.map((amount, periodIndex) => ({
                periodKey:
                  periods[periodIndex]?.key ??
                  makePeriodKey(cycle.fiscalYear, periodIndex + 1, cycle.periodType),
                periodIndex: periodIndex + 1,
                amount,
              })),
            },
          })),
        },
      },
    });

    await snapshotVersion(tx, budget.id, 1, 'DRAFT', total, actor.id, 'Budget created');

    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'Budget',
        entityId: budget.id,
        summary: `Created budget '${payload.name}' totalling ${toMoneyString(total)} ${budget.currency}`,
        changes: { lineCount: lines.length, total: total.toFixed(4) },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      tx,
    );

    return { id: budget.id };
  });
}

export interface TransitionResult {
  id: string;
  status: BudgetStatus;
  version: number;
}

/**
 * Statuses in which a budget's numbers may still change.
 *
 * Used in two places that must agree: `replaceBudgetLines` refuses edits
 * outside these, and `transitionBudget` clears sign-offs when entering one.
 * They were separate lists once, and the second was missing IN_REVIEW.
 */
const EDITABLE_STATUSES: readonly BudgetStatus[] = ['DRAFT', 'IN_REVIEW'];

/**
 * Move a budget through the workflow.
 *
 * Checks, in order:
 *   1. the transition is legal for the current status
 *   2. the actor's role is senior enough for the target status
 *   3. an approval is not being granted by whoever prepared or submitted it
 *   4. the amount is within the actor's delegated authority
 *   5. the budget is not already locked
 *
 * Only then are the status change, the version snapshot, the approval record and
 * the audit entry written - together, in one transaction.
 */
export async function transitionBudget(
  budgetId: string,
  to: BudgetStatus,
  actor: AuthenticatedUser,
  options: { comment?: string; ipAddress?: string; userAgent?: string; appUrl?: string } = {},
): Promise<TransitionResult> {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
    select: {
      id: true,
      name: true,
      status: true,
      version: true,
      totalAmount: true,
      currency: true,
      preparedById: true,
      submittedById: true,
      businessUnitId: true,
      businessUnit: { select: { code: true } },
      cycle: { select: { status: true, name: true } },
    },
  });

  if (!budget) throw new AppError('NOT_FOUND', `Budget '${budgetId}' was not found.`);

  const from = budget.status as BudgetStatus;

  // (5) LOCKED is terminal. An approved-and-locked budget is the baseline that
  // variance reporting is measured against; reopening it would invalidate every
  // report already issued.
  if (from === 'LOCKED') {
    throw new AppError(
      'CONFLICT',
      'This budget is locked. Raise a reforecast or a budget transfer rather than amending the approved baseline.',
    );
  }

  // (1) Legal transition.
  const allowed = BUDGET_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw InvalidTransitionError(from, to, allowed);
  }

  // (2) Role seniority.
  const minimumRole = TRANSITION_MIN_ROLE[to];
  if (!atLeast(actor.role, minimumRole)) {
    throw new AppError(
      'FORBIDDEN',
      `Moving a budget to ${to} requires the ${minimumRole} role or higher.`,
      { details: { required: minimumRole, actual: actor.role } },
    );
  }

  /*
    Seniority is not sufficient on its own. The administrator outranks every
    finance role, so a rank test alone hands it every transition in the table -
    which is exactly the authority it is not supposed to hold. The permission is
    the second gate, and the one that actually expresses the policy.
  */
  const permission = TRANSITION_PERMISSION[to];
  if (!can(actor.role, permission)) {
    throw new AppError('FORBIDDEN', `Moving a budget to ${to} requires ${permission}.`, {
      details: { required: permission, actual: actor.role },
    });
  }

  const isApproval = to === 'APPROVED' || to === 'LOCKED';

  if (isApproval) {
    // (3) Separation of duties. Deliberately has no role-based bypass.
    assertSeparationOfDuties({
      actorId: actor.id,
      preparedById: budget.preparedById,
      submittedById: budget.submittedById,
    });

    // (4) Delegated authority.
    // Resolved here rather than read off the actor, for the same reason the
    // period axis is computed by calling buildPeriodAxis: a derived value
    // carried on a DTO has to be populated at every construction site, and a
    // missed one fails closed on every approval. Both sides call the same
    // function, which is the guarantee that matters.
    const limit = effectiveApprovalLimit(actor);
    assertWithinDelegatedAuthority(budget.totalAmount.toString(), limit);
  }

  const nextVersion = budget.version + 1;
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Scalar foreign keys rather than relation syntax, because the guarded
    // write below uses updateMany, which only accepts scalars.
    const data: Prisma.BudgetUpdateManyMutationInput & {
      submittedById?: string | null;
      approvedById?: string | null;
    } = { status: to as never, version: nextVersion };

    if (to === 'SUBMITTED') {
      data.submittedById = actor.id;
      data.submittedAt = now;
    }
    if (to === 'APPROVED') {
      data.approvedById = actor.id;
      data.approvedAt = now;
    }
    if (to === 'LOCKED') {
      data.lockedAt = now;
    }
    // Returning to an editable status clears the prior sign-offs; leaving them
    // in place would let a stale approval carry over onto edited numbers.
    //
    // This is keyed on *editability*, not on DRAFT alone. IN_REVIEW is equally
    // editable (see replaceBudgetLines) and APPROVED -> IN_REVIEW is a legal
    // transition, so covering only DRAFT left an approved budget able to be
    // pulled back, edited, and still display the approver and date of the
    // numbers that person actually signed off.
    //
    // preparedBy is deliberately untouched: it records who originated the
    // budget rather than a sign-off, and separation of duties bars the preparer
    // from approving however many revisions have happened since.
    if (EDITABLE_STATUSES.includes(to)) {
      data.submittedById = null;
      data.approvedById = null;
      data.submittedAt = null;
      data.approvedAt = null;
    }

    /**
     * Guarded write: the row must still be in the state the checks were made
     * against.
     *
     * Every control above was evaluated from a read taken before this
     * transaction opened, so two concurrent approvals could both pass and both
     * write. The unique constraint on (budgetId, version) already caused the
     * loser to roll back, but only incidentally, and it surfaced as a confusing
     * "a record with this budgetId, version already exists". Matching on the
     * observed version and status makes the intent explicit and the failure
     * legible.
     */
    const written = await tx.budget.updateMany({
      where: { id: budgetId, version: budget.version, status: from as never },
      data,
    });

    if (written.count === 0) {
      throw new AppError(
        'CONFLICT',
        `This budget changed while the transition to ${to} was being processed. Reload it and try again.`,
        { details: { expectedStatus: from, expectedVersion: budget.version } },
      );
    }

    await snapshotVersion(
      tx,
      budgetId,
      nextVersion,
      to,
      new Decimal(budget.totalAmount.toString()),
      actor.id,
      options.comment,
    );

    if (isApproval || to === 'REJECTED') {
      await tx.approval.create({
        data: {
          budgetId,
          approverId: actor.id,
          fromStatus: from as never,
          toStatus: to as never,
          comment: options.comment ?? null,
          amount: budget.totalAmount,
        },
      });
    }

    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: auditActionFor(to),
        entityType: 'Budget',
        entityId: budgetId,
        summary: `Budget '${budget.name}' moved from ${from} to ${to} (${toMoneyString(budget.totalAmount.toString())} ${budget.currency})`,
        changes: {
          status: { from, to },
          version: { from: budget.version, to: nextVersion },
          ...(options.comment ? { comment: options.comment } : {}),
        },
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
      tx,
    );

    // Outbox, in the same transaction. If anything above rolls back nobody is
    // told about a transition that did not happen; and a broken mail server
    // cannot roll back an approval, because sending happens later.
    if (to === 'SUBMITTED' || to === 'APPROVED' || to === 'REJECTED' || to === 'LOCKED') {
      const messages = await notificationsForTransition(tx, to, {
        budgetId,
        budgetName: budget.name,
        businessUnitId: budget.businessUnitId,
        businessUnit: budget.businessUnit.code,
        cycleName: budget.cycle.name,
        amount: toMoneyString(budget.totalAmount.toString()),
        currency: budget.currency,
        actorId: actor.id,
        actorName: `${actor.firstName} ${actor.lastName}`.trim(),
        preparedById: budget.preparedById,
        submittedById: budget.submittedById,
        comment: options.comment ?? null,
        appUrl: options.appUrl,
      });
      await enqueueNotifications(tx, messages);
    }

    return { id: budgetId, status: to, version: nextVersion };
  });
}

function auditActionFor(status: BudgetStatus) {
  switch (status) {
    case 'SUBMITTED':
      return 'SUBMIT' as const;
    case 'APPROVED':
      return 'APPROVE' as const;
    case 'REJECTED':
      return 'REJECT' as const;
    case 'LOCKED':
      return 'LOCK' as const;
    default:
      return 'UPDATE' as const;
  }
}

/**
 * Freeze the budget's full contents into a version row.
 *
 * Stored as JSON rather than as relational history: the point is to reproduce
 * exactly what was approved, and a normalised history would be reconstructed
 * through today's schema rather than the one in force at the time.
 */
async function snapshotVersion(
  tx: Tx,
  budgetId: string,
  version: number,
  status: BudgetStatus,
  total: Decimal,
  actorId: string,
  comment?: string,
): Promise<void> {
  const lines = await tx.budgetLine.findMany({
    where: { budgetId },
    include: { periods: { orderBy: { periodIndex: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  });

  const snapshot = {
    capturedAt: new Date().toISOString(),
    status,
    total: total.toFixed(4),
    lines: lines.map((line) => ({
      accountId: line.accountId,
      costCategory: line.costCategory,
      method: line.method,
      description: line.description,
      strategicObjectiveId: line.strategicObjectiveId,
      alignment: line.alignment,
      justification: line.justification,
      totalAmount: line.totalAmount.toString(),
      periods: line.periods.map((p) => ({
        periodKey: p.periodKey,
        periodIndex: p.periodIndex,
        amount: p.amount.toString(),
      })),
    })),
  };

  await tx.budgetVersion.create({
    data: {
      budgetId,
      version,
      status: status as never,
      totalAmount: total.toFixed(4),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      createdById: actorId,
      comment: comment ?? null,
    },
  });
}

/**
 * Replace a budget's lines.
 *
 * Rejected once the budget has left DRAFT or IN_REVIEW: editing a submitted
 * budget behind the reviewer's back is precisely what the workflow exists to
 * prevent.
 */
export async function replaceBudgetLines(
  budgetId: string,
  lines: BudgetLineDraft[],
  actor: AuthenticatedUser,
  context: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ id: string; totalAmount: string }> {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
    select: {
      id: true,
      name: true,
      status: true,
      totalAmount: true,
      cycle: { select: { fiscalYear: true, periodType: true, horizonYears: true } },
    },
  });
  if (!budget) throw new AppError('NOT_FOUND', `Budget '${budgetId}' was not found.`);

  if (!EDITABLE_STATUSES.includes(budget.status as BudgetStatus)) {
    throw new AppError(
      'CONFLICT',
      `A budget in ${budget.status} cannot be edited. Return it to draft first.`,
    );
  }

  const periods = periodAxisFor(budget.cycle);
  for (const [index, line] of lines.entries()) {
    if (line.periodAmounts.length !== periods.length) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Line ${index + 1} supplies ${line.periodAmounts.length} period amounts, but this cycle has ${periods.length} periods.`,
      );
    }
  }

  const previousTotal = budget.totalAmount.toString();
  const total = totalOf(lines);

  await prisma.$transaction(async (tx) => {
    await tx.budgetLine.deleteMany({ where: { budgetId } });

    for (const [index, line] of lines.entries()) {
      await tx.budgetLine.create({
        data: {
          budgetId,
          accountId: line.accountId,
          costCategory: (line.costCategory ?? null) as never,
          method: (line.method ?? 'INCREMENTAL') as never,
          description: line.description ?? null,
          driverId: line.driverId ?? null,
          strategicObjectiveId: line.strategicObjectiveId ?? null,
          alignment: (line.alignment ?? 'SUPPORTING') as never,
          justification: line.justification ?? null,
          sortOrder: index,
          totalAmount: (line.periodAmounts.length === 0
            ? new Decimal(0)
            : add(...line.periodAmounts)
          ).toFixed(4),
          periods: {
            create: line.periodAmounts.map((amount, periodIndex) => ({
              periodKey: periods[periodIndex]?.key ?? `P${periodIndex + 1}`,
              periodIndex: periodIndex + 1,
              amount,
            })),
          },
        },
      });
    }

    await tx.budget.update({
      where: { id: budgetId },
      data: { totalAmount: total.toFixed(4) },
    });

    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'UPDATE',
        entityType: 'Budget',
        entityId: budgetId,
        summary: `Updated budget '${budget.name}': ${lines.length} lines, total ${toMoneyString(total)}`,
        changes: { total: { from: previousTotal, to: total.toFixed(4) }, lineCount: lines.length },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      tx,
    );
  });

  return { id: budgetId, totalAmount: toMoneyString(total) };
}

/** Transitions the actor could legally perform right now - drives the UI. */
export function availableTransitions(status: BudgetStatus, role: Role): BudgetStatus[] {
  // Both gates, so the buttons a screen offers match what the API will accept.
  // Offering one it then refuses is the defect this function exists to prevent.
  return BUDGET_TRANSITIONS[status].filter(
    (target) =>
      atLeast(role, TRANSITION_MIN_ROLE[target]) && can(role, TRANSITION_PERMISSION[target]),
  );
}
