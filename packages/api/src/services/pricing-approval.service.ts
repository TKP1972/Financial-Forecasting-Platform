/**
 * Commercial sign-off on a bid price.
 *
 * Budgets have had a full governance chain since the beginning: separation of
 * duties, delegated authority, version snapshots, an audit entry and a CFO-only
 * lock. A price had none of it. Anyone holding `pricing:write` - an Analyst,
 * whose delegated authority limit is zero - could persist a multi-year bid at
 * any value and any margin, with no second pair of eyes.
 *
 * That was the wrong way round. A budget is a plan the business can revise; a
 * price is what it commits to a client and cannot. So this applies the *same*
 * two controls the budget approval applies, deliberately by calling the same
 * functions rather than by reimplementing the rules:
 *
 *   - `assertSeparationOfDuties` - nobody approves a price they built.
 *   - `assertWithinDelegatedAuthority` - against the total price, so a
 *     $73m bid cannot be signed off by someone with a $250k limit.
 *
 * Approval is per **version**, not per pursuit. A new version is a new row and
 * starts unapproved, so re-pricing clears the sign-off by construction. The
 * budget equivalent needed an explicit rule and an explicit test, because a
 * budget is edited in place; here the data model does the work.
 */
import {
  AppError,
  assertSeparationOfDuties,
  assertWithinDelegatedAuthority,
  effectiveApprovalLimit,
} from '@ffp/shared';
import { prisma } from '../db.js';
import { appendAuditEntry } from './audit.service.js';
import type { AuthenticatedUser } from './auth.service.js';

export interface PricingApprovalResult {
  id: string;
  version: number;
  approvedAt: Date | null;
  approvedById: string | null;
}

/** Shape returned to callers, with the approver resolved for display. */
async function loadModel(id: string) {
  const model = await prisma.pricingModel.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      version: true,
      totalPrice: true,
      approvedAt: true,
      approvedById: true,
      createdById: true,
      pursuitId: true,
      currency: true,
    },
  });
  if (!model) throw new AppError('NOT_FOUND', `Pricing model '${id}' was not found.`);
  return model;
}

/**
 * Sign off a priced bid.
 *
 * Order matters and mirrors the budget transition: state first, then separation
 * of duties, then delegated authority. Asserting authority before separation
 * would tell an approver their limit is too low for a price they were never
 * eligible to approve, which is a misleading refusal.
 */
export async function approvePricingModel(
  id: string,
  actor: AuthenticatedUser,
  comment?: string,
): Promise<PricingApprovalResult> {
  const model = await loadModel(id);

  if (model.approvedAt) {
    throw new AppError(
      'CONFLICT',
      `Version ${model.version} is already approved. Withdraw the approval first if it needs to change.`,
    );
  }

  // No role bypass, ADMIN included. The control is worthless with one.
  assertSeparationOfDuties({
    actorId: actor.id,
    preparedById: model.createdById,
  });

  // Against total price, not margin: the exposure being authorised is the
  // amount committed to the client.
  // Resolved through the same function the API reports with - see the note in
  // budget.service on why this is not read off the actor.
  const limit = effectiveApprovalLimit(actor);
  assertWithinDelegatedAuthority(model.totalPrice.toString(), limit);

  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    // Guarded on approvedAt still being null, so two approvers racing the same
    // version cannot both succeed. Same pattern as the budget transition.
    const written = await tx.pricingModel.updateMany({
      where: { id, approvedAt: null },
      data: { approvedAt: now, approvedById: actor.id },
    });
    if (written.count === 0) {
      throw new AppError(
        'CONFLICT',
        'This version was approved by someone else while you were working. Reload before trying again.',
      );
    }

    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'APPROVE',
        entityType: 'PricingModel',
        entityId: id,
        summary: `Approved pricing '${model.name}' v${model.version} at ${model.totalPrice.toString()} ${model.currency}`,
        changes: {
          approvedAt: now.toISOString(),
          approvedById: actor.id,
          totalPrice: model.totalPrice.toString(),
          version: model.version,
          ...(comment ? { comment } : {}),
        },
      },
      tx,
    );

    return { id, version: model.version, approvedAt: now, approvedById: actor.id };
  });

  return updated;
}

/**
 * Withdraw a sign-off.
 *
 * Deliberately not restricted to the approver who gave it: a price whose
 * assumptions have moved needs to stop being approved regardless of who is
 * available, and the audit entry records who withdrew it. Separation of duties
 * does not apply - withdrawing is the removal of an authorisation, not the
 * granting of one, and requiring a second person to un-approve would leave a
 * stale approval standing precisely when someone has noticed it is wrong.
 */
export async function withdrawPricingApproval(
  id: string,
  actor: AuthenticatedUser,
  reason?: string,
): Promise<PricingApprovalResult> {
  const model = await loadModel(id);

  const previousApprovedAt = model.approvedAt;
  if (!previousApprovedAt) {
    throw new AppError('CONFLICT', `Version ${model.version} is not currently approved.`);
  }

  return prisma.$transaction(async (tx) => {
    const written = await tx.pricingModel.updateMany({
      where: { id, approvedAt: { not: null } },
      data: { approvedAt: null, approvedById: null },
    });
    if (written.count === 0) {
      throw new AppError(
        'CONFLICT',
        'This approval was withdrawn by someone else while you were working.',
      );
    }

    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        // REJECT rather than UPDATE: the trail should read as a governance
        // event, so "when did this price stop being approved" is answerable
        // without inspecting a diff.
        action: 'REJECT',
        entityType: 'PricingModel',
        entityId: id,
        summary: `Withdrew approval of pricing '${model.name}' v${model.version}`,
        changes: {
          previousApprovedAt: previousApprovedAt.toISOString(),
          previousApprovedById: model.approvedById,
          version: model.version,
          ...(reason ? { reason } : {}),
        },
      },
      tx,
    );

    return { id, version: model.version, approvedAt: null, approvedById: null };
  });
}
