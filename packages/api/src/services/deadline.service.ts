/**
 * Deadline and reminder scanner.
 *
 * Coordinating a budgeting cycle is mostly chasing people, and the chasing is
 * what a platform can actually take off a finance team's hands. This scans open
 * cycles for three things:
 *
 *   - units whose submission deadline is approaching and who have not submitted
 *   - units whose deadline has passed and who still have not submitted
 *   - budgets sitting in SUBMITTED with the approval deadline in sight
 *
 * Every message it queues carries a dedupe key that includes the day, so running
 * the scan hourly produces one notification per recipient per day rather than
 * twenty-four. A reminder that fires on every scan is a reminder people learn to
 * filter, which is worse than not sending it.
 *
 * The scan is pure read plus outbox writes. It never changes a budget's status:
 * missing a deadline is a fact for a human to act on, not something the system
 * should resolve on its own.
 */
import { calendarDaysBetween, renderNotification, type BudgetNotificationFacts } from '@ffp/shared';
import { prisma } from '../db.js';
import {
  enqueueNotifications,
  resolveApprovers,
  type QueuedNotification,
} from './notification.service.js';

/** Notify this many days before the submission deadline. */
export const DEFAULT_WARN_DAYS = [7, 3, 1, 0];

export interface ScanOptions {
  now?: Date;
  warnDays?: readonly number[];
  appUrl?: string;
}

export interface ScanResult {
  cyclesScanned: number;
  submissionWarnings: number;
  submissionOverdue: number;
  approvalReminders: number;
  queued: number;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Statuses that still count as "not submitted" for deadline purposes. */
const UNSUBMITTED = ['DRAFT', 'IN_REVIEW', 'REJECTED'] as const;

export async function scanDeadlines(options: ScanOptions = {}): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const warnDays = new Set(options.warnDays ?? DEFAULT_WARN_DAYS);
  const today = dayStamp(now);

  const result: ScanResult = {
    cyclesScanned: 0,
    submissionWarnings: 0,
    submissionOverdue: 0,
    approvalReminders: 0,
    queued: 0,
  };

  const cycles = await prisma.budgetCycle.findMany({
    // PLANNING has not opened for submissions yet and CLOSED is finished;
    // neither should chase anybody.
    where: { status: { in: ['OPEN', 'CONSOLIDATING'] } },
    select: {
      id: true,
      name: true,
      submissionDeadline: true,
      approvalDeadline: true,
      baseCurrency: true,
      budgets: {
        select: {
          id: true,
          name: true,
          status: true,
          totalAmount: true,
          currency: true,
          businessUnitId: true,
          preparedById: true,
          submittedById: true,
          businessUnit: { select: { code: true } },
        },
      },
    },
  });

  const messages: QueuedNotification[] = [];

  for (const cycle of cycles) {
    result.cyclesScanned += 1;
    const submissionDays = calendarDaysBetween(now, cycle.submissionDeadline);
    const approvalDays = calendarDaysBetween(now, cycle.approvalDeadline);

    for (const budget of cycle.budgets) {
      const facts: BudgetNotificationFacts = {
        budgetName: budget.name,
        businessUnit: budget.businessUnit.code,
        cycleName: cycle.name,
        amount: budget.totalAmount.toString(),
        currency: budget.currency,
        deadline: dayStamp(cycle.submissionDeadline),
        appUrl: options.appUrl,
      };

      const unsubmitted = (UNSUBMITTED as readonly string[]).includes(budget.status);

      if (unsubmitted && submissionDays >= 0 && warnDays.has(submissionDays)) {
        const content = renderNotification('SUBMISSION_DEADLINE_APPROACHING', {
          ...facts,
          daysRemaining: submissionDays,
        });
        for (const userId of owners(budget)) {
          messages.push({
            userId,
            type: 'SUBMISSION_DEADLINE_APPROACHING',
            subject: content.subject,
            body: content.body,
            entityType: 'Budget',
            entityId: budget.id,
            dedupeKey: `SUBMISSION_DEADLINE_APPROACHING:${budget.id}:${userId}:${today}`,
          });
        }
        result.submissionWarnings += 1;
      }

      if (unsubmitted && submissionDays < 0) {
        const content = renderNotification('SUBMISSION_DEADLINE_PASSED', {
          ...facts,
          daysRemaining: submissionDays,
        });
        for (const userId of owners(budget)) {
          messages.push({
            userId,
            type: 'SUBMISSION_DEADLINE_PASSED',
            subject: content.subject,
            body: content.body,
            entityType: 'Budget',
            entityId: budget.id,
            dedupeKey: `SUBMISSION_DEADLINE_PASSED:${budget.id}:${userId}:${today}`,
          });
        }
        result.submissionOverdue += 1;
      }

      // An approval reminder goes only to people who could actually approve it,
      // for the same reason the submission fan-out does: a reminder to someone
      // the system would then refuse is worse than no reminder.
      if (budget.status === 'SUBMITTED' && approvalDays <= Math.max(...warnDays)) {
        const content = renderNotification('APPROVAL_REMINDER', {
          ...facts,
          daysRemaining: approvalDays,
        });
        const approvers = await resolveApprovers(prisma, {
          amount: budget.totalAmount.toString(),
          businessUnitId: budget.businessUnitId,
          preparedById: budget.preparedById,
          submittedById: budget.submittedById,
        });
        for (const approver of approvers) {
          messages.push({
            userId: approver.id,
            type: 'APPROVAL_REMINDER',
            subject: content.subject,
            body: content.body,
            entityType: 'Budget',
            entityId: budget.id,
            dedupeKey: `APPROVAL_REMINDER:${budget.id}:${approver.id}:${today}`,
          });
        }
        if (approvers.length > 0) result.approvalReminders += 1;
      }
    }
  }

  result.queued = await enqueueNotifications(prisma, messages);
  return result;
}

/** Who is on the hook for submitting a budget. */
function owners(budget: { preparedById: string | null; submittedById: string | null }): string[] {
  return [
    ...new Set(
      [budget.preparedById, budget.submittedById].filter((id): id is string => Boolean(id)),
    ),
  ];
}
