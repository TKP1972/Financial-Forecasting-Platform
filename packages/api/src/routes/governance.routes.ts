/**
 * Governance: the audit trail, chain verification and user administration.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  DEFAULT_APPROVAL_LIMITS,
  ROLES,
  auditQuerySchema,
  permissionsFor,
  type Role,
} from '@ffp/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry, verifyAuditChain } from '../services/audit.service.js';
import { revokeAllSessions } from '../services/auth.service.js';

/** Audit `changes` is stored as text; hand clients the parsed object. */
function parseChanges(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Never let one malformed historical row break the whole audit view.
    return { unparsed: raw };
  }
}

export async function registerGovernanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', { onRequest: [app.requirePermission('audit:read')] }, async (request) => {
    const query = auditQuerySchema.parse(request.query);

    const where = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action as never } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { sequence: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      // BigInt is not JSON-serialisable, so the sequence goes over the wire as a string.
      data: rows.map((row) => ({
        id: row.id,
        sequence: row.sequence.toString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        // Stored as canonical JSON text so the hash chain verifies; parsed here
        // so clients still receive structured data.
        changes: parseChanges(row.changes),
        actor: row.actor,
        actorEmail: row.actorEmail,
        ipAddress: row.ipAddress,
        hash: row.hash,
        previousHash: row.previousHash,
        createdAt: row.createdAt,
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  /**
   * Re-derive every hash and confirm the chain is intact.
   *
   * The one control that proves the audit trail has not been tampered with, so it
   * is restricted to the CFO/ADMIN level and is itself audited.
   */
  app.post(
    '/audit/verify',
    { onRequest: [app.requirePermission('audit:verify')] },
    async (request) => {
      const actor = requireUser(request);
      const result = await verifyAuditChain();

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'UPDATE',
        entityType: 'AuditLog',
        summary: result.valid
          ? `Audit chain verified: ${result.entriesChecked} entries intact`
          : `AUDIT CHAIN VERIFICATION FAILED at sequence ${result.brokenAtSequence}: ${result.reason}`,
        changes: { valid: result.valid, entriesChecked: result.entriesChecked },
      });

      return { data: result };
    },
  );

  /** Every governed action taken against one record, oldest first. */
  app.get(
    '/audit/entity/:entityType/:entityId',
    { onRequest: [app.requirePermission('audit:read')] },
    async (request) => {
      const { entityType, entityId } = z
        .object({ entityType: z.string(), entityId: z.string() })
        .parse(request.params);

      const rows = await prisma.auditLog.findMany({
        where: { entityType, entityId },
        orderBy: { sequence: 'asc' },
        include: { actor: { select: { id: true, firstName: true, lastName: true } } },
      });

      return {
        data: rows.map((row) => ({
          sequence: row.sequence.toString(),
          action: row.action,
          summary: row.summary,
          changes: parseChanges(row.changes),
          actor: row.actor,
          createdAt: row.createdAt,
        })),
      };
    },
  );

  // ---- Users -------------------------------------------------------------

  app.get('/users', { onRequest: [app.requirePermission('user:read')] }, async () => {
    const users = await prisma.user.findMany({
      orderBy: [{ role: 'desc' }, { lastName: 'asc' }],
      include: { businessUnit: { select: { id: true, code: true, name: true } } },
    });

    return {
      data: users.map((user) => ({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActive: user.isActive,
        businessUnit: user.businessUnit,
        approvalLimit: user.approvalLimit?.toString() ?? DEFAULT_APPROVAL_LIMITS[user.role as Role],
        lastLoginAt: user.lastLoginAt,
        isLocked: user.lockedUntil !== null && user.lockedUntil > new Date(),
      })),
    };
  });

  app.patch(
    '/users/:id',
    { onRequest: [app.requirePermission('user:manage')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z
        .object({
          role: z.enum(ROLES).optional(),
          isActive: z.boolean().optional(),
          businessUnitId: z.string().nullable().optional(),
          approvalLimit: z.string().nullable().optional(),
          unlock: z.boolean().optional(),
        })
        .parse(request.body);

      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) throw new AppError('NOT_FOUND', `User '${id}' was not found.`);

      // An administrator removing their own access would lock everyone out of
      // user management if they were the last one.
      if (id === actor.id && (input.isActive === false || (input.role && input.role !== 'ADMIN'))) {
        throw new AppError(
          'CONFLICT',
          'You cannot deactivate or demote your own account. Ask another administrator.',
        );
      }

      const updated = await prisma.user.update({
        where: { id },
        data: {
          ...(input.role !== undefined ? { role: input.role as never } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.businessUnitId !== undefined ? { businessUnitId: input.businessUnitId } : {}),
          ...(input.approvalLimit !== undefined ? { approvalLimit: input.approvalLimit } : {}),
          ...(input.unlock ? { lockedUntil: null, failedLoginCount: 0 } : {}),
        },
      });

      // A revoked role must take effect at once, not at token expiry.
      if (input.role !== undefined || input.isActive === false) {
        await revokeAllSessions(id);
      }

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'UPDATE',
        entityType: 'User',
        entityId: id,
        summary: `Updated user ${updated.email}`,
        changes: {
          ...(input.role !== undefined ? { role: { from: existing.role, to: input.role } } : {}),
          ...(input.isActive !== undefined
            ? { isActive: { from: existing.isActive, to: input.isActive } }
            : {}),
          ...(input.approvalLimit !== undefined
            ? {
                approvalLimit: {
                  from: existing.approvalLimit?.toString() ?? null,
                  to: input.approvalLimit,
                },
              }
            : {}),
        },
      });

      return {
        data: {
          id: updated.id,
          email: updated.email,
          role: updated.role,
          isActive: updated.isActive,
        },
      };
    },
  );

  /** The permission matrix, so the UI can explain what each role can do. */
  app.get('/roles', { onRequest: [app.authenticate] }, async () => ({
    data: ROLES.map((role) => ({
      role,
      permissions: permissionsFor(role),
      defaultApprovalLimit: DEFAULT_APPROVAL_LIMITS[role],
    })),
  }));

  /** Snapshot of the controls in force - what an auditor asks for first. */
  app.get('/controls', { onRequest: [app.requirePermission('audit:read')] }, async () => {
    const [userCount, activeUsers, budgetsApproved, chainLength, lastVerification] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isActive: true } }),
        prisma.budget.count({ where: { status: { in: ['APPROVED', 'LOCKED'] } } }),
        prisma.auditLog.count(),
        prisma.auditLog.findFirst({
          where: { entityType: 'AuditLog' },
          orderBy: { sequence: 'desc' },
          select: { createdAt: true, summary: true },
        }),
      ]);

    return {
      data: {
        controls: [
          {
            id: 'SOD-01',
            name: 'Separation of duties',
            description:
              'A budget cannot be approved by the person who prepared or submitted it. Enforced server-side with no role-based exemption.',
            status: 'ENFORCED',
          },
          {
            id: 'DOA-01',
            name: 'Delegated authority limits',
            description:
              'Approvals above a role limit are refused and must be escalated. Limits are per-user overridable.',
            status: 'ENFORCED',
          },
          {
            id: 'AUD-01',
            name: 'Tamper-evident audit trail',
            description:
              'Every governed action is hash-chained to its predecessor. Any edit or deletion breaks the chain and is detectable.',
            status: 'ENFORCED',
          },
          {
            id: 'VER-01',
            name: 'Budget version snapshots',
            description:
              'Every status transition freezes the complete budget, so an approved budget can be reproduced exactly as approved.',
            status: 'ENFORCED',
          },
          {
            id: 'LCK-01',
            name: 'Locked baseline',
            description:
              'A locked budget is terminal and cannot be amended, preserving the baseline that variance reporting measures against.',
            status: 'ENFORCED',
          },
        ],
        metrics: {
          users: userCount,
          activeUsers,
          approvedBudgets: budgetsApproved,
          auditEntries: chainLength,
          lastChainVerification: lastVerification?.createdAt ?? null,
          lastChainVerificationResult: lastVerification?.summary ?? null,
        },
      },
    };
  });
}
