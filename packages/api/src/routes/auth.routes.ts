/**
 * Authentication endpoints.
 *
 * Login and refresh carry their own, much tighter rate limit than the global
 * one: these are the two endpoints worth brute-forcing.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  createUserSchema,
  loginSchema,
  passwordSchema,
  permissionsFor,
  refreshSchema,
  type Role,
} from '@ffp/shared';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';
import {
  authenticate,
  hashPassword,
  issueRefreshToken,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyPassword,
  type AuthenticatedUser,
} from '../services/auth.service.js';
import { completeReset, requestReset } from '../services/password-reset.service.js';

function clientContext(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  };
}

function publicUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    businessUnitId: user.businessUnitId,
    approvalLimit: user.approvalLimit,
    permissions: permissionsFor(user.role),
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const strictLimit = {
    config: {
      rateLimit: { max: 10, timeWindow: 60_000 },
    },
  };

  app.post('/login', strictLimit, async (request) => {
    const { email, password } = loginSchema.parse(request.body);
    const context = clientContext(request);

    try {
      const user = await authenticate(email, password);
      const session = await issueRefreshToken(user.id, context);

      const accessToken = app.jwt.sign({
        sub: user.id,
        email: user.email,
        role: user.role,
        businessUnitId: user.businessUnitId,
      });

      await appendAuditEntry({
        actorId: user.id,
        actorEmail: user.email,
        action: 'LOGIN',
        entityType: 'User',
        entityId: user.id,
        summary: `${user.email} signed in`,
        ...context,
      });

      return {
        accessToken,
        refreshToken: session.refreshToken,
        expiresIn: config.JWT_ACCESS_TTL,
        user: publicUser(user),
      };
    } catch (error) {
      // Record the failure without revealing whether the account exists.
      await appendAuditEntry({
        actorEmail: email,
        action: 'LOGIN_FAILED',
        entityType: 'User',
        summary: `Failed sign-in attempt for ${email}`,
        ...context,
      });
      throw error;
    }
  });

  app.post('/refresh', strictLimit, async (request) => {
    const { refreshToken } = refreshSchema.parse(request.body);
    const { user, session } = await rotateRefreshToken(refreshToken, clientContext(request));

    const accessToken = app.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
      businessUnitId: user.businessUnitId,
    });

    return {
      accessToken,
      refreshToken: session.refreshToken,
      expiresIn: config.JWT_ACCESS_TTL,
      user: publicUser(user),
    };
  });

  app.post('/logout', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const parsed = z.object({ refreshToken: z.string().optional() }).parse(request.body ?? {});

    if (parsed.refreshToken) {
      await revokeRefreshToken(parsed.refreshToken);
    } else {
      await revokeAllSessions(user.id);
    }

    await appendAuditEntry({
      actorId: user.id,
      actorEmail: user.email,
      action: 'LOGOUT',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email} signed out`,
      ...clientContext(request),
    });

    return { success: true };
  });

  /**
   * Begin a password reset.
   *
   * Always 202 with the same body. Whether the address exists, is deactivated or
   * has too many outstanding tokens is not the caller's business - this endpoint
   * is unauthenticated and must not confirm who has an account here.
   */
  app.post('/forgot-password', strictLimit, async (request, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body);

    const result = await requestReset(email, {
      ipAddress: request.ip,
      appUrl: config.APP_URL,
      exposeToken: config.PASSWORD_RESET_EXPOSE_TOKEN,
    });

    await appendAuditEntry({
      actorEmail: email,
      action: 'UPDATE',
      entityType: 'User',
      summary: `Password reset requested for ${email}`,
      ...clientContext(request),
    });

    return reply.status(202).send({
      message: 'If that address has an account, a reset link has been sent to it.',
      // Development only; config refuses to start with this set in production.
      ...(result.token ? { devToken: result.token } : {}),
    });
  });

  app.post('/reset-password', strictLimit, async (request) => {
    const { token, newPassword } = z
      .object({ token: z.string().min(1), newPassword: passwordSchema })
      .parse(request.body);

    const result = await completeReset(token, newPassword, clientContext(request));
    return { success: true, sessionsRevoked: result.sessionsRevoked };
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    return { user: publicUser(user) };
  });

  app.post('/change-password', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
      .parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(record.passwordHash, currentPassword))) {
      throw new AppError('UNAUTHENTICATED', 'Your current password is incorrect.');
    }
    if (currentPassword === newPassword) {
      throw new AppError('VALIDATION_ERROR', 'The new password must differ from the current one.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    // A password change invalidates every existing session - that is the point
    // of changing it after a suspected compromise.
    const revoked = await revokeAllSessions(user.id);

    await appendAuditEntry({
      actorId: user.id,
      actorEmail: user.email,
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email} changed their password; ${revoked} session(s) revoked`,
      ...clientContext(request),
    });

    return { success: true, sessionsRevoked: revoked };
  });

  app.post(
    '/users',
    { onRequest: [app.requirePermission('user:manage')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = createUserSchema.parse(request.body);

      const created = await prisma.user.create({
        data: {
          email: input.email.toLowerCase().trim(),
          passwordHash: await hashPassword(input.password),
          firstName: input.firstName,
          lastName: input.lastName,
          role: input.role as Role,
          businessUnitId: input.businessUnitId ?? null,
          approvalLimit: input.approvalLimit ?? null,
        },
        select: { id: true, email: true, firstName: true, lastName: true, role: true },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'User',
        entityId: created.id,
        summary: `Created user ${created.email} with role ${created.role}`,
        changes: { role: created.role, businessUnitId: input.businessUnitId ?? null },
        ...clientContext(request),
      });

      return reply.status(201).send({ user: created });
    },
  );
}
