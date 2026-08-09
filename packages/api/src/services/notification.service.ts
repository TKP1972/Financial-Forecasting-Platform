/**
 * Notification outbox.
 *
 * Notifications are written to the database **inside the transaction that caused
 * them** and delivered later by a separate dispatcher. That ordering matters in
 * both directions:
 *
 *   - A notification can never announce something that did not commit. If the
 *     approval rolls back, so does the message saying it was approved.
 *   - A transport outage can never roll back an approval. SMTP being down is not
 *     a reason to refuse to approve a budget.
 *
 * This is the outbox pattern, and for a system of record it is the only honest
 * way to do it. The alternative - firing an email from inside the request - gives
 * you both failure modes at once.
 *
 * Delivery itself is deliberately dull: transports are small objects with a
 * `send` method, chosen by channel, and the dispatcher retries with backoff until
 * a per-row attempt cap. A permanently failing row lands in FAILED and stays
 * queryable rather than disappearing.
 */
import type { NotificationChannel, NotificationType, Prisma } from '@prisma/client';
import {
  NOTIFICATION_MUTABLE,
  renderNotification,
  resolveApprovalRecipients,
  shouldDeliver,
  type BudgetNotificationFacts,
  type RecipientCandidate,
  type Role,
} from '@ffp/shared';
import { prisma, type Tx } from '../db.js';

/** How many delivery attempts before a row is abandoned in FAILED. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Backoff before attempt n (1-indexed), in seconds: 0, 60, 300, 900, 3600. */
const BACKOFF_SECONDS = [0, 60, 300, 900, 3600];

export interface QueuedNotification {
  userId: string;
  type: NotificationType;
  channel?: NotificationChannel;
  subject: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey?: string | null;
}

// --------------------------------------------------------------------------
// Transports
// --------------------------------------------------------------------------

export interface Transport {
  readonly channel: NotificationChannel;
  send(message: { to: string; subject: string; body: string }): Promise<void>;
}

/**
 * IN_APP delivery is a no-op: persisting the row *is* the delivery. The row is
 * still marked SENT so that one status field means the same thing on every
 * channel and the dispatcher needs no special cases.
 */
export const inAppTransport: Transport = {
  channel: 'IN_APP',
  async send() {
    /* the row is the message */
  },
};

/**
 * Development email transport: writes to the log instead of sending.
 *
 * Deliberately the default. A platform that quietly acquires the ability to mail
 * real people the moment someone sets an SMTP host is a platform that will one
 * day mail production budget figures to a test distribution list. Sending
 * requires opting in explicitly.
 */
export function createLogTransport(
  log: (line: string) => void,
  channel: NotificationChannel = 'EMAIL',
): Transport {
  return {
    channel,
    async send(message) {
      log(`[notification] to=${message.to} subject=${message.subject}`);
    },
  };
}

const registry = new Map<NotificationChannel, Transport>();

export function registerTransport(transport: Transport): void {
  registry.set(transport.channel, transport);
}

export function getTransport(channel: NotificationChannel): Transport | undefined {
  return registry.get(channel);
}

/** Test seam. */
export function resetTransports(): void {
  registry.clear();
}

// --------------------------------------------------------------------------
// Enqueue
// --------------------------------------------------------------------------

/**
 * Persist notifications to the outbox.
 *
 * Pass the surrounding transaction so the rows commit or roll back with whatever
 * caused them. Rows whose `dedupeKey` already exists are skipped, which is what
 * makes the deadline scanner safe to run as often as you like.
 *
 * Returns the number of rows actually written.
 */
export async function enqueueNotifications(
  db: Tx,
  messages: readonly QueuedNotification[],
): Promise<number> {
  if (messages.length === 0) return 0;

  const keys = messages.map((m) => m.dedupeKey).filter((k): k is string => Boolean(k));
  const alreadyQueued = new Set<string>();

  if (keys.length > 0) {
    const existing = await db.notification.findMany({
      where: { dedupeKey: { in: keys } },
      select: { dedupeKey: true },
    });
    for (const row of existing) {
      if (row.dedupeKey) alreadyQueued.add(row.dedupeKey);
    }
  }

  const rows: Prisma.NotificationCreateManyInput[] = [];
  const seenInBatch = new Set<string>();

  for (const message of messages) {
    if (message.dedupeKey) {
      if (alreadyQueued.has(message.dedupeKey) || seenInBatch.has(message.dedupeKey)) continue;
      seenInBatch.add(message.dedupeKey);
    }
    rows.push({
      userId: message.userId,
      type: message.type,
      channel: message.channel ?? 'EMAIL',
      subject: message.subject,
      body: message.body,
      entityType: message.entityType ?? null,
      entityId: message.entityId ?? null,
      dedupeKey: message.dedupeKey ?? null,
    });
  }

  if (rows.length === 0) return 0;

  const result = await db.notification.createMany({ data: rows });
  return result.count;
}

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------

export interface DispatchResult {
  sent: number;
  failed: number;
  suppressed: number;
  skipped: number;
}

/**
 * Deliver pending notifications.
 *
 * Backoff is derived from the row's own attempt count rather than held in a
 * scheduler, so the dispatcher is stateless and safe to restart. A row whose
 * recipient has since been deactivated or has muted a mutable type is marked
 * SUPPRESSED rather than sent - preferences are checked at delivery, not only at
 * enqueue, because a queued reminder should not arrive after someone has turned
 * that reminder off.
 */
export async function dispatchPending(
  options: { batchSize?: number; now?: Date } = {},
): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? 50;
  const now = options.now ?? new Date();
  const result: DispatchResult = { sent: 0, failed: 0, suppressed: 0, skipped: 0 };

  const pending = await prisma.notification.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    include: {
      user: {
        select: {
          email: true,
          isActive: true,
          notificationPrefs: { where: { muted: true }, select: { type: true } },
        },
      },
    },
  });

  for (const row of pending) {
    if (!isDue(row.attempts, row.createdAt, now)) {
      result.skipped += 1;
      continue;
    }

    const muted = row.user.notificationPrefs.map((p) => p.type as NotificationType);
    if (
      !shouldDeliver(row.type as NotificationType, {
        isActive: row.user.isActive,
        mutedTypes: muted,
      })
    ) {
      await prisma.notification.update({
        where: { id: row.id },
        data: { status: 'SUPPRESSED', lastError: null },
      });
      result.suppressed += 1;
      continue;
    }

    const transport = registry.get(row.channel);
    if (!transport) {
      await recordFailure(
        row.id,
        row.attempts,
        `No transport registered for channel ${row.channel}.`,
      );
      result.failed += 1;
      continue;
    }

    try {
      await transport.send({ to: row.user.email, subject: row.subject, body: row.body });
      await prisma.notification.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: row.attempts + 1, lastError: null },
      });
      result.sent += 1;
    } catch (error) {
      await recordFailure(
        row.id,
        row.attempts,
        error instanceof Error ? error.message : String(error),
      );
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Whether a row is due for its next attempt.
 *
 * Backoff runs from `createdAt` rather than from the last attempt because there
 * is no last-attempt column, and the difference only matters if a dispatcher run
 * is delayed - in which case attempting sooner is the harmless direction.
 */
function isDue(attempts: number, createdAt: Date, now: Date): boolean {
  if (attempts === 0) return true;
  const wait = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)] ?? 3600;
  return now.getTime() - createdAt.getTime() >= wait * 1000;
}

async function recordFailure(id: string, attempts: number, message: string): Promise<void> {
  const next = attempts + 1;
  await prisma.notification.update({
    where: { id },
    data: {
      attempts: next,
      lastError: message.slice(0, 500),
      // Only give up once; until then the row stays PENDING and is retried.
      status: next >= MAX_DELIVERY_ATTEMPTS ? 'FAILED' : 'PENDING',
    },
  });
}

// --------------------------------------------------------------------------
// Budget workflow notifications
// --------------------------------------------------------------------------

export interface BudgetEventContext {
  budgetId: string;
  budgetName: string;
  businessUnitId: string | null;
  businessUnit: string;
  cycleName: string;
  amount: string;
  currency: string;
  actorId: string;
  actorName: string;
  preparedById: string | null;
  submittedById: string | null;
  comment?: string | null;
  appUrl?: string;
}

/**
 * Build the outbox rows for a budget workflow transition.
 *
 * SUBMITTED fans out to everyone who could actually approve it - resolved by the
 * shared rule, so the set is identical to the one the approval endpoint would
 * accept. The other transitions go back to the people who worked on it.
 *
 * The actor is never notified of their own action.
 */
export async function notificationsForTransition(
  db: Tx,
  to: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'LOCKED',
  context: BudgetEventContext,
): Promise<QueuedNotification[]> {
  const facts: BudgetNotificationFacts = {
    budgetName: context.budgetName,
    businessUnit: context.businessUnit,
    cycleName: context.cycleName,
    amount: context.amount,
    currency: context.currency,
    actorName: context.actorName,
    comment: context.comment ?? null,
    appUrl: context.appUrl,
  };

  const userIds =
    to === 'SUBMITTED'
      ? (await resolveApprovers(db, context)).map((r) => r.id)
      : uniq([context.preparedById, context.submittedById]);

  const content = renderNotification(
    to === 'SUBMITTED' ? 'BUDGET_SUBMITTED' : `BUDGET_${to}`,
    facts,
  );
  const type: NotificationType =
    to === 'SUBMITTED' ? 'BUDGET_SUBMITTED' : (`BUDGET_${to}` as NotificationType);

  return userIds
    .filter((id) => id !== context.actorId)
    .map((userId) => ({
      userId,
      type,
      subject: content.subject,
      body: content.body,
      entityType: 'Budget',
      entityId: context.budgetId,
      // One notification per user, per event, per budget version-changing
      // transition. Two approvals of the same budget cannot happen, so the
      // budget id and type are enough.
      dedupeKey: `${type}:${context.budgetId}:${userId}`,
    }));
}

/** Everyone the approval endpoint would actually accept for this budget. */
export async function resolveApprovers(
  db: Tx,
  context: Pick<BudgetEventContext, 'amount' | 'businessUnitId' | 'preparedById' | 'submittedById'>,
): Promise<RecipientCandidate[]> {
  const users = await db.user.findMany({
    where: { isActive: true },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      businessUnitId: true,
      approvalLimit: true,
      notificationPrefs: { where: { muted: true }, select: { type: true } },
    },
  });

  const candidates: RecipientCandidate[] = users.map((user) => ({
    id: user.id,
    email: user.email,
    name: `${user.firstName} ${user.lastName}`.trim(),
    role: user.role as Role,
    isActive: user.isActive,
    businessUnitId: user.businessUnitId,
    approvalLimit: user.approvalLimit?.toString() ?? null,
    mutedTypes: user.notificationPrefs.map((p) => p.type as NotificationType),
  }));

  return resolveApprovalRecipients(candidates, {
    amount: context.amount,
    preparedById: context.preparedById,
    submittedById: context.submittedById,
    businessUnitId: context.businessUnitId,
    businessUnitPath: await businessUnitAncestry(db, context.businessUnitId),
  }).recipients;
}

/**
 * A unit and every ancestor above it, nearest first.
 *
 * Walked iteratively rather than with a recursive CTE because the hierarchy is
 * a handful of levels deep and this keeps the query inside Prisma's typed API.
 * The depth cap is a guard, not a limit: the import validator rejects cycles,
 * but a cycle introduced directly in the database must not hang the dispatcher.
 */
async function businessUnitAncestry(db: Tx, unitId: string | null): Promise<string[]> {
  if (!unitId) return [];
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = unitId;

  for (let depth = 0; cursor && depth < 20; depth += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    path.push(cursor);

    const unit: { parentId: string | null } | null = await db.businessUnit.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = unit?.parentId ?? null;
  }

  return path;
}

function uniq(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

// --------------------------------------------------------------------------
// Preferences
// --------------------------------------------------------------------------

/**
 * Set a user's mute preference for a type.
 *
 * Muting a non-mutable type is rejected rather than silently ignored: a user who
 * thinks they have turned off rejection notices and still receives them has been
 * misled by their own settings page.
 */
export async function setPreference(
  userId: string,
  type: NotificationType,
  muted: boolean,
): Promise<void> {
  if (muted && !NOTIFICATION_MUTABLE[type as keyof typeof NOTIFICATION_MUTABLE]) {
    throw new Error(`Notifications of type ${type} cannot be muted.`);
  }
  await prisma.notificationPreference.upsert({
    where: { userId_type: { userId, type } },
    create: { userId, type, muted },
    update: { muted },
  });
}
