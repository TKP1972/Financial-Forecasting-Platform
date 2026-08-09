/**
 * Notification vocabulary and recipient resolution.
 *
 * The governing principle: **never tell someone to do something the system will
 * refuse to let them do.** A notification asking a Budget Owner to approve a
 * £6m submission they have no authority for, or asking the person who prepared
 * it to approve their own work, is worse than silence - it wastes their time and
 * teaches them the notifications are noise.
 *
 * So recipient resolution applies the same three controls the approval itself
 * applies: permission, separation of duties, and delegated authority. The rule
 * is pure and lives here beside the RBAC matrix it depends on.
 */
import type { Role } from './domain.js';
import { DEFAULT_APPROVAL_LIMITS, can, isWithinDelegatedAuthority } from './rbac.js';

export const NOTIFICATION_TYPES = [
  /** A budget has been submitted and needs approval. */
  'BUDGET_SUBMITTED',
  'BUDGET_APPROVED',
  'BUDGET_REJECTED',
  'BUDGET_LOCKED',
  /** Still sitting in SUBMITTED after the reminder threshold. */
  'APPROVAL_REMINDER',
  /** The cycle's submission deadline is near and this unit has not submitted. */
  'SUBMISSION_DEADLINE_APPROACHING',
  'SUBMISSION_DEADLINE_PASSED',
  /** The guideline pack has been published; units can start work. */
  'GUIDANCE_PUBLISHED',
  /** A period has been closed; actuals for it are now locked. */
  'PERIOD_CLOSED',
  /** Password reset requested. */
  'PASSWORD_RESET',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  BUDGET_SUBMITTED: 'Budget submitted for approval',
  BUDGET_APPROVED: 'Budget approved',
  BUDGET_REJECTED: 'Budget returned',
  BUDGET_LOCKED: 'Budget baseline locked',
  APPROVAL_REMINDER: 'Approval still outstanding',
  SUBMISSION_DEADLINE_APPROACHING: 'Submission deadline approaching',
  SUBMISSION_DEADLINE_PASSED: 'Submission deadline passed',
  GUIDANCE_PUBLISHED: 'Budget guidance published',
  PERIOD_CLOSED: 'Period closed',
  PASSWORD_RESET: 'Password reset requested',
};

/**
 * Whether a type may be muted.
 *
 * Some notifications are not preferences. Being told a budget you prepared was
 * rejected, or that your password was reset, is information you need regardless
 * of how you have configured your inbox.
 */
export const NOTIFICATION_MUTABLE: Record<NotificationType, boolean> = {
  BUDGET_SUBMITTED: true,
  BUDGET_APPROVED: true,
  BUDGET_REJECTED: false,
  BUDGET_LOCKED: true,
  APPROVAL_REMINDER: true,
  SUBMISSION_DEADLINE_APPROACHING: true,
  SUBMISSION_DEADLINE_PASSED: false,
  GUIDANCE_PUBLISHED: true,
  PERIOD_CLOSED: true,
  PASSWORD_RESET: false,
};

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// --------------------------------------------------------------------------
// Recipient resolution
// --------------------------------------------------------------------------

/** A user considered as a possible recipient. */
export interface RecipientCandidate {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  businessUnitId?: string | null;
  /** Per-user override; falls back to the role default when null. */
  approvalLimit?: string | null;
  /** Types this user has muted. */
  mutedTypes?: readonly NotificationType[];
}

export interface ApprovalContext {
  /** Amount requiring approval, as a decimal string. */
  amount: string;
  /** Who prepared it - excluded by separation of duties. */
  preparedById?: string | null;
  /** Who submitted it - also excluded. */
  submittedById?: string | null;
  /** The unit the budget belongs to. */
  businessUnitId?: string | null;
  /**
   * The unit and every ancestor above it, so approvers sitting higher in the
   * hierarchy are in scope.
   *
   * Comparing the unit id alone was wrong: a Finance Manager at Group would be
   * excluded from approving a budget for a division beneath Group, which is
   * precisely the person whose job it is. Defaults to `[businessUnitId]` when
   * the caller cannot supply the chain.
   */
  businessUnitPath?: readonly string[];
}

export interface RecipientDecision {
  recipients: RecipientCandidate[];
  /** Everyone considered and rejected, with the reason. Surfaced for support. */
  excluded: Array<{ id: string; name: string; reason: string }>;
}

/**
 * Who should be told that something needs approving.
 *
 * Applies, in order: active account, holds `budget:approve`, not the preparer or
 * submitter, and within delegated authority for this amount. The last two are
 * what stop the system from generating requests it will then refuse.
 *
 * Business-unit scoping is deliberately permissive: a user with no unit is
 * treated as central finance and always considered, because that is who the
 * escalation path runs to.
 */
export function resolveApprovalRecipients(
  candidates: readonly RecipientCandidate[],
  context: ApprovalContext,
): RecipientDecision {
  const recipients: RecipientCandidate[] = [];
  const excluded: RecipientDecision['excluded'] = [];

  const inScope = new Set(
    (context.businessUnitPath ?? (context.businessUnitId ? [context.businessUnitId] : [])).filter(
      Boolean,
    ),
  );

  for (const candidate of candidates) {
    if (!candidate.isActive) {
      excluded.push({ id: candidate.id, name: candidate.name, reason: 'Account is inactive.' });
      continue;
    }
    if (!can(candidate.role, 'budget:approve')) {
      excluded.push({
        id: candidate.id,
        name: candidate.name,
        reason: `Role ${candidate.role} cannot approve budgets.`,
      });
      continue;
    }
    if (candidate.id === context.preparedById || candidate.id === context.submittedById) {
      excluded.push({
        id: candidate.id,
        name: candidate.name,
        reason:
          'Prepared or submitted this budget; separation of duties bars them from approving it.',
      });
      continue;
    }

    const limit = candidate.approvalLimit ?? DEFAULT_APPROVAL_LIMITS[candidate.role];
    if (!isWithinDelegatedAuthority(context.amount, limit)) {
      excluded.push({
        id: candidate.id,
        name: candidate.name,
        reason: `Amount exceeds their delegated authority limit of ${limit ?? 'unlimited'}.`,
      });
      continue;
    }

    // In scope if they sit on the budget's unit or anywhere above it. A user
    // with no unit at all is central finance and is always considered.
    if (inScope.size > 0 && candidate.businessUnitId && !inScope.has(candidate.businessUnitId)) {
      excluded.push({
        id: candidate.id,
        name: candidate.name,
        reason: 'Scoped to a different business unit.',
      });
      continue;
    }

    if ((candidate.mutedTypes ?? []).includes('BUDGET_SUBMITTED')) {
      excluded.push({
        id: candidate.id,
        name: candidate.name,
        reason: 'Has muted approval notifications.',
      });
      continue;
    }

    recipients.push(candidate);
  }

  return { recipients, excluded };
}

/**
 * Whether a notification may be suppressed for a user.
 * Non-mutable types ignore preferences entirely.
 */
export function shouldDeliver(
  type: NotificationType,
  candidate: Pick<RecipientCandidate, 'isActive' | 'mutedTypes'>,
): boolean {
  if (!candidate.isActive) return false;
  if (!NOTIFICATION_MUTABLE[type]) return true;
  return !(candidate.mutedTypes ?? []).includes(type);
}

// --------------------------------------------------------------------------
// Message rendering
// --------------------------------------------------------------------------

export interface NotificationContent {
  subject: string;
  /** Plain text. Deliberately not HTML - see the note below. */
  body: string;
}

export interface BudgetNotificationFacts {
  budgetName: string;
  businessUnit: string;
  cycleName: string;
  amount: string;
  currency: string;
  actorName?: string;
  comment?: string | null;
  /** Days remaining; negative means overdue. */
  daysRemaining?: number;
  deadline?: string;
  appUrl?: string;
}

/**
 * Render a notification.
 *
 * Plain text, not HTML. Every one of these is an operational message that needs
 * to be read and acted on, they are frequently forwarded into ticketing systems
 * and chat, and a templating layer would be a maintenance burden for no gain.
 * The body always states what happened, what the money was, and what the reader
 * is expected to do - in that order.
 */
export function renderNotification(
  type: NotificationType,
  facts: BudgetNotificationFacts,
): NotificationContent {
  const money = `${facts.amount} ${facts.currency}`;
  const where = `${facts.businessUnit} · ${facts.cycleName}`;
  const link = facts.appUrl ? `\n\nOpen the platform: ${facts.appUrl}` : '';

  switch (type) {
    case 'BUDGET_SUBMITTED':
      return {
        subject: `Approval needed: ${facts.budgetName} (${money})`,
        body:
          `${facts.actorName ?? 'A budget owner'} has submitted '${facts.budgetName}' for approval.\n\n` +
          `Business unit: ${where}\nTotal: ${money}\n\n` +
          `You are receiving this because the amount is within your delegated authority and you did not prepare or submit it.` +
          link,
      };

    case 'BUDGET_APPROVED':
      return {
        subject: `Approved: ${facts.budgetName} (${money})`,
        body:
          `'${facts.budgetName}' has been approved by ${facts.actorName ?? 'an approver'}.\n\n` +
          `Business unit: ${where}\nTotal: ${money}\n\n` +
          `No action is needed. The budget becomes the reporting baseline once it is locked.` +
          link,
      };

    case 'BUDGET_REJECTED':
      return {
        subject: `Returned for revision: ${facts.budgetName}`,
        body:
          `'${facts.budgetName}' has been returned by ${facts.actorName ?? 'an approver'}.\n\n` +
          `Business unit: ${where}\nTotal: ${money}\n` +
          (facts.comment ? `\nReason given:\n${facts.comment}\n` : '\nNo reason was recorded.\n') +
          `\nRevise it and resubmit before the cycle deadline.` +
          link,
      };

    case 'BUDGET_LOCKED':
      return {
        subject: `Baseline locked: ${facts.budgetName} (${money})`,
        body:
          `'${facts.budgetName}' has been locked and is now the baseline that variance reporting measures against.\n\n` +
          `Business unit: ${where}\nTotal: ${money}\n\n` +
          `It can no longer be amended. Raise a reforecast or a budget transfer instead.` +
          link,
      };

    case 'APPROVAL_REMINDER':
      return {
        subject: `Still awaiting your approval: ${facts.budgetName} (${money})`,
        body:
          `'${facts.budgetName}' has been waiting for approval` +
          (facts.daysRemaining !== undefined
            ? ` and the approval deadline is ${describeDays(facts.daysRemaining)}`
            : '') +
          `.\n\nBusiness unit: ${where}\nTotal: ${money}` +
          link,
      };

    case 'SUBMISSION_DEADLINE_APPROACHING':
      return {
        subject: `Budget submission due ${describeDays(facts.daysRemaining ?? 0)}: ${facts.businessUnit}`,
        body:
          `The submission deadline for ${facts.cycleName} is ${describeDays(facts.daysRemaining ?? 0)}` +
          (facts.deadline ? ` (${facts.deadline})` : '') +
          `.\n\n'${facts.budgetName}' for ${facts.businessUnit} has not been submitted yet.\n\n` +
          `Submit it before the deadline. Late submissions are consolidated at the top-down target rather than your bottom-up build.` +
          link,
      };

    case 'SUBMISSION_DEADLINE_PASSED':
      return {
        subject: `Submission deadline passed: ${facts.businessUnit}`,
        body:
          `The submission deadline for ${facts.cycleName} has passed and '${facts.budgetName}' is still not submitted.\n\n` +
          `Business unit: ${facts.businessUnit}\n\n` +
          `Contact Finance immediately. Until this is submitted the consolidated plan uses the top-down target for this unit.` +
          link,
      };

    case 'GUIDANCE_PUBLISHED':
      return {
        subject: `Budget guidance published: ${facts.cycleName}`,
        body:
          `The budget plan and guideline pack for ${facts.cycleName} has been published.\n\n` +
          `It contains the mandatory planning assumptions, your unit's targets, the period calendar and the submission deadline` +
          (facts.deadline ? ` of ${facts.deadline}` : '') +
          `.\n\nSubmissions built on different assumptions will be returned.` +
          link,
      };

    case 'PERIOD_CLOSED':
      return {
        subject: `Period closed: ${facts.cycleName}`,
        body:
          `Actuals up to and including ${facts.budgetName} have been closed and locked for ${facts.cycleName}.\n\n` +
          `Restatements to closed periods are no longer accepted. Post adjustments to an open period instead.` +
          link,
      };

    case 'PASSWORD_RESET':
      return {
        subject: 'Reset your password',
        body:
          `A password reset was requested for your account.\n\n` +
          `${facts.comment ?? ''}\n\n` +
          `The link is single-use and expires in one hour. If you did not request this, no action is needed - your password has not changed.`,
      };

    default: {
      const exhaustive: never = type;
      throw new Error(`Unrendered notification type: ${String(exhaustive)}`);
    }
  }
}

function describeDays(days: number): string {
  if (days < 0) return `${Math.abs(days)} day(s) overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
