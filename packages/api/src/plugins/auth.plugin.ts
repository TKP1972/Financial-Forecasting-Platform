/**
 * Authentication and authorisation plugin.
 *
 * Decorates the request with the authenticated user and exposes guards that
 * routes declare in their `onRequest` hook. Authorisation is therefore explicit
 * at every route - there is no ambient "logged in means allowed".
 */
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  ROLE_RANK,
  can,
  effectiveApprovalLimit,
  type Permission,
  type Role,
} from '@ffp/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import type { AccessTokenPayload, AuthenticatedUser } from '../services/auth.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Requires a valid access token. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Requires a valid token AND the given permission. */
    requirePermission: (
      ...permissions: Permission[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Requires a valid token AND at least the given role. */
    requireRole: (minimum: Role) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    currentUser?: AuthenticatedUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

export const authPlugin = fp(
  async (app) => {
    await app.register(fastifyJwt, {
      secret: config.JWT_SECRET,
      sign: { expiresIn: config.JWT_ACCESS_TTL },
    });

    /**
     * Verify the token, then re-read the user from the database.
     *
     * Re-reading costs a query per request but means a deactivated account or a
     * role change takes effect immediately rather than at token expiry. For a
     * system where roles gate financial approvals, that is the right trade.
     */
    app.decorate('authenticate', async (request: FastifyRequest) => {
      try {
        await request.jwtVerify();
      } catch {
        throw new AppError('UNAUTHENTICATED', 'A valid access token is required.');
      }

      const payload = request.user;
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });

      if (!user || !user.isActive) {
        throw new AppError('UNAUTHENTICATED', 'This account is no longer active.');
      }

      request.currentUser = {
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
    });

    app.decorate(
      'requirePermission',
      (...permissions: Permission[]) =>
        async (request: FastifyRequest, reply: FastifyReply) => {
          await app.authenticate(request, reply);
          const user = request.currentUser;
          if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication is required.');

          const missing = permissions.filter((permission) => !can(user.role, permission));
          if (missing.length > 0) {
            throw new AppError(
              'FORBIDDEN',
              `Your role (${user.role}) does not permit this action.`,
              { details: { required: permissions, missing } },
            );
          }
        },
    );

    app.decorate(
      'requireRole',
      (minimum: Role) => async (request: FastifyRequest, reply: FastifyReply) => {
        await app.authenticate(request, reply);
        const user = request.currentUser;
        if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication is required.');

        if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
          throw new AppError('FORBIDDEN', `This action requires the ${minimum} role or higher.`, {
            details: { required: minimum, actual: user.role },
          });
        }
      },
    );
  },
  { name: 'auth-plugin' },
);

/** Narrow the optional `currentUser` for handlers that ran behind a guard. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.currentUser;
  if (!user) {
    // Only reachable if a route forgot its guard - fail loudly rather than
    // treating the request as anonymous and leaking data.
    throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
  }
  return user;
}
