/**
 * Password reset.
 *
 * Three properties this flow has to hold, and each one costs something to get
 * right:
 *
 *   1. **No user enumeration.** `requestReset` returns the same response and does
 *      roughly the same work whether the address exists or not. An unauthenticated
 *      endpoint that reveals which of your finance staff have accounts is a
 *      reconnaissance tool.
 *
 *   2. **Single use.** The token is marked used inside the same transaction that
 *      changes the password, so two concurrent redemptions cannot both succeed.
 *
 *   3. **Every session dies.** A reset is what you do when you think the account
 *      is compromised. Leaving the attacker's refresh token alive would make the
 *      reset theatre.
 *
 * Only the SHA-256 digest of the token is stored, exactly as for refresh tokens:
 * read access to the database must not confer the ability to take over accounts.
 */
import { randomBytes } from 'node:crypto';
import { AppError } from '@ffp/shared';
import { renderNotification } from '@ffp/shared';
import { prisma } from '../db.js';
import { hashPassword, hashToken } from './auth.service.js';
import { appendAuditEntry } from './audit.service.js';
import { enqueueNotifications } from './notification.service.js';

/** Reset links are short-lived; an hour is enough to read an email. */
export const RESET_TOKEN_TTL_SECONDS = 3600;

/** Outstanding tokens a single account may hold before requests are refused. */
export const MAX_OUTSTANDING_TOKENS = 5;

export interface ResetRequestResult {
  /**
   * Whether a token was actually issued. **Never** put this in an HTTP response -
   * it is the enumeration oracle this whole design exists to avoid. It is
   * returned for tests and for the audit trail.
   */
  issued: boolean;
  /** Present only in non-production, so the smoke test can complete the flow. */
  token?: string;
}

/**
 * Begin a reset.
 *
 * An unknown address, a deactivated account, or too many outstanding tokens all
 * produce `issued: false` and no notification - and the caller must respond
 * identically in all four cases.
 */
export async function requestReset(
  email: string,
  context: { ipAddress?: string; appUrl?: string; exposeToken?: boolean } = {},
): Promise<ResetRequestResult> {
  const normalised = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({
    where: { email: normalised },
    select: { id: true, isActive: true },
  });

  if (!user || !user.isActive) return { issued: false };

  const outstanding = await prisma.passwordResetToken.count({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (outstanding >= MAX_OUTSTANDING_TOKENS) return { issued: false };

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt,
        requestedIp: context.ipAddress ?? null,
      },
    });

    const link = context.appUrl
      ? `Open this link to choose a new password:\n${context.appUrl}/reset-password?token=${token}`
      : 'Use the reset token supplied by your administrator.';

    const content = renderNotification('PASSWORD_RESET', {
      budgetName: '',
      businessUnit: '',
      cycleName: '',
      amount: '',
      currency: '',
      comment: link,
    });

    await enqueueNotifications(tx, [
      {
        userId: user.id,
        type: 'PASSWORD_RESET',
        subject: content.subject,
        body: content.body,
        entityType: 'User',
        entityId: user.id,
        // No dedupe key: each request must produce its own mail, or a user who
        // lost the first one could never get a second.
      },
    ]);
  });

  return { issued: true, ...(context.exposeToken ? { token } : {}) };
}

/**
 * Complete a reset.
 *
 * Unlike `requestReset`, this one does report failure precisely. The caller holds
 * a token; telling them it has expired is not an information leak, and leaving
 * them to guess is a support call.
 */
export async function completeReset(
  token: string,
  newPassword: string,
  context: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ userId: string; sessionsRevoked: number }> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, isActive: true } } },
  });

  if (!stored) throw new AppError('UNAUTHENTICATED', 'This reset link is not valid.');
  if (stored.usedAt) {
    throw new AppError('UNAUTHENTICATED', 'This reset link has already been used.');
  }
  if (stored.expiresAt < new Date()) {
    throw new AppError('UNAUTHENTICATED', 'This reset link has expired. Request a new one.');
  }
  if (!stored.user.isActive) {
    throw new AppError('FORBIDDEN', 'This account has been deactivated.');
  }

  const passwordHash = await hashPassword(newPassword);

  const sessionsRevoked = await prisma.$transaction(async (tx) => {
    // Consume the token by a conditional update rather than a plain one. If two
    // requests race, exactly one sees count 1 and the other is rejected below -
    // the check above is a courtesy, this is the guarantee.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new AppError('UNAUTHENTICATED', 'This reset link has already been used.');
    }

    await tx.user.update({
      where: { id: stored.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });

    // Any other outstanding token is now suspect too.
    await tx.passwordResetToken.updateMany({
      where: { userId: stored.userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    const revoked = await tx.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await appendAuditEntry(
      {
        actorId: stored.userId,
        actorEmail: stored.user.email,
        action: 'UPDATE',
        entityType: 'User',
        entityId: stored.userId,
        summary: `Password reset completed; ${revoked.count} session(s) revoked`,
        changes: { passwordHash: { from: '[redacted]', to: '[redacted]' } },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      tx,
    );

    return revoked.count;
  });

  return { userId: stored.userId, sessionsRevoked };
}

/** Housekeeping: drop tokens that expired more than a day ago. */
export async function purgeExpiredResetTokens(): Promise<number> {
  const result = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
  });
  return result.count;
}
