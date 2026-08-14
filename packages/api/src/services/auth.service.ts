/**
 * Authentication.
 *
 * Argon2id for password storage, short-lived access tokens paired with rotating
 * refresh tokens, and account lockout after repeated failures.
 *
 * Refresh tokens are stored only as SHA-256 digests and are single-use: each
 * refresh revokes the presented token and issues a new one. If a stolen token is
 * replayed after the legitimate client has already rotated it, the reuse is
 * detectable and every session for that user is dropped.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { AppError, effectiveApprovalLimit, type Role } from '@ffp/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';

/**
 * Argon2id parameters. 19 MiB / 2 passes / 1 lane is the OWASP baseline; it costs
 * roughly 50ms per hash here, which is the point - it makes offline cracking of a
 * leaked hash expensive without making login feel slow.
 */
const ARGON_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that distinguishes this account from any other.
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

/** Constant-time string comparison, for anything an attacker can probe. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  businessUnitId: string | null;
  /**
   * This user's own override, exactly as stored. `null` means "no override" -
   * it does **not** mean unlimited. Never decide anything from this field; it
   * exists so a client editing a user can write back what it read, without
   * turning an inherited default into an explicit override.
   */
  approvalLimit: string | null;
  /**
   * The limit that actually applies: the override above, else the role's
   * default. `null` here *does* mean unlimited, which is the CFO. This is the
   * field to answer "can this person authorise X?" - and it is the same value
   * the approval services enforce, because they read it from here.
   */
  effectiveApprovalLimit: string | null;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  businessUnitId: string | null;
}

export class AuthenticationError extends AppError {
  constructor(message = 'Invalid email or password.') {
    super('UNAUTHENTICATED', message);
  }
}

/**
 * Verify credentials and return the user.
 *
 * The failure message is identical whether the account does not exist or the
 * password is wrong, so the endpoint cannot be used to enumerate valid emails.
 * A dummy verification runs on the unknown-email path to keep response timing
 * indistinguishable.
 */
export async function authenticate(email: string, password: string): Promise<AuthenticatedUser> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (!user) {
    await argonVerify(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$8kQ0hZ4kFCEZmM7oRuKKPNMLXFCVvXvLZAdvsVWTf7c',
      password,
    ).catch(() => false);
    throw new AuthenticationError();
  }

  if (!user.isActive) {
    throw new AppError('FORBIDDEN', 'This account has been deactivated. Contact an administrator.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw new AppError(
      'FORBIDDEN',
      `Account temporarily locked after repeated failed sign-in attempts. Try again in ${seconds} seconds.`,
    );
  }

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    const attempts = user.failedLoginCount + 1;
    const shouldLock = attempts >= config.MAX_LOGIN_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + config.LOGIN_LOCKOUT_SECONDS * 1000) : null,
      },
    });
    throw new AuthenticationError();
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role as Role,
    businessUnitId: user.businessUnitId,
    approvalLimit: user.approvalLimit?.toString() ?? null,
    effectiveApprovalLimit: effectiveApprovalLimit({
      role: user.role,
      approvalLimit: user.approvalLimit?.toString(),
    }),
  };
}

export interface IssuedSession {
  refreshToken: string;
  expiresAt: Date;
}

export async function issueRefreshToken(
  userId: string,
  context: { userAgent?: string; ipAddress?: string } = {},
): Promise<IssuedSession> {
  const token = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.JWT_REFRESH_TTL * 1000);

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    },
  });

  return { refreshToken: token, expiresAt };
}

/**
 * Exchange a refresh token for a new one.
 *
 * Rotation is unconditional. Presenting a token that has already been revoked
 * means either a replay or a stolen token, so every session for that user is
 * revoked rather than just refusing the request.
 */
export async function rotateRefreshToken(
  token: string,
  context: { userAgent?: string; ipAddress?: string } = {},
): Promise<{ user: AuthenticatedUser; session: IssuedSession }> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!stored) throw new AppError('UNAUTHENTICATED', 'Invalid refresh token.');

  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AppError(
      'UNAUTHENTICATED',
      'This session has already been used and has been revoked. Please sign in again.',
    );
  }

  if (stored.expiresAt < new Date()) {
    throw new AppError('UNAUTHENTICATED', 'Session expired. Please sign in again.');
  }

  if (!stored.user.isActive) {
    throw new AppError('FORBIDDEN', 'This account has been deactivated.');
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  const session = await issueRefreshToken(stored.userId, context);

  return {
    user: {
      id: stored.user.id,
      email: stored.user.email,
      firstName: stored.user.firstName,
      lastName: stored.user.lastName,
      role: stored.user.role as Role,
      businessUnitId: stored.user.businessUnitId,
      approvalLimit: stored.user.approvalLimit?.toString() ?? null,
      effectiveApprovalLimit: effectiveApprovalLimit({
        role: stored.user.role,
        approvalLimit: stored.user.approvalLimit?.toString(),
      }),
    },
    session,
  };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Housekeeping: drop tokens that expired more than a day ago. */
export async function purgeExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 86400_000) } },
  });
  return result.count;
}
