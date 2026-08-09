/**
 * Organisation reference data: business units, chart of accounts and the
 * strategic objectives budget lines are aligned to.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  createAccountSchema,
  createBusinessUnitSchema,
  queryBoolean,
  strategicObjectiveSchema,
} from '@ffp/shared';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

export async function registerOrgRoutes(app: FastifyInstance): Promise<void> {
  // ---- Business units ----------------------------------------------------

  app.get('/business-units', { onRequest: [app.requirePermission('budget:read')] }, async () => {
    const units = await prisma.businessUnit.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        _count: { select: { budgets: true, children: true } },
      },
    });

    return {
      data: units.map((unit) => ({
        id: unit.id,
        code: unit.code,
        name: unit.name,
        parentId: unit.parentId,
        costCentre: unit.costCentre,
        currency: unit.currency,
        owner: unit.owner,
        budgetCount: unit._count.budgets,
        childCount: unit._count.children,
      })),
    };
  });

  /**
   * The unit hierarchy as a tree. Built in memory from a single query rather
   * than a recursive CTE - the hierarchy is small and this keeps it portable.
   */
  app.get(
    '/business-units/tree',
    { onRequest: [app.requirePermission('budget:read')] },
    async () => {
      const units = await prisma.businessUnit.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
      });

      type Node = { id: string; code: string; name: string; children: Node[] };
      const nodes = new Map<string, Node>(
        units.map((u) => [u.id, { id: u.id, code: u.code, name: u.name, children: [] }]),
      );
      const roots: Node[] = [];

      for (const unit of units) {
        const node = nodes.get(unit.id);
        if (!node) continue;
        const parent = unit.parentId ? nodes.get(unit.parentId) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
      }

      return { data: roots };
    },
  );

  app.post(
    '/business-units',
    { onRequest: [app.requirePermission('settings:manage')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = createBusinessUnitSchema.parse(request.body);

      const unit = await prisma.businessUnit.create({
        data: {
          code: input.code,
          name: input.name,
          parentId: input.parentId ?? null,
          costCentre: input.costCentre ?? null,
          currency: input.currency ?? config.BASE_CURRENCY,
          ownerId: input.ownerId ?? null,
        },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'BusinessUnit',
        entityId: unit.id,
        summary: `Created business unit ${unit.code} - ${unit.name}`,
      });

      return reply.status(201).send({ data: unit });
    },
  );

  // ---- Chart of accounts -------------------------------------------------

  app.get('/accounts', { onRequest: [app.requirePermission('budget:read')] }, async (request) => {
    const query = z
      .object({
        type: z.string().optional(),
        activeOnly: queryBoolean.default(true),
      })
      .parse(request.query);

    const accounts = await prisma.account.findMany({
      where: {
        ...(query.activeOnly ? { isActive: true } : {}),
        ...(query.type ? { type: query.type as never } : {}),
      },
      orderBy: { code: 'asc' },
    });

    return { data: accounts };
  });

  app.post(
    '/accounts',
    { onRequest: [app.requirePermission('settings:manage')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = createAccountSchema.parse(request.body);

      const account = await prisma.account.create({
        data: {
          code: input.code,
          name: input.name,
          type: input.type as never,
          category: (input.category ?? null) as never,
          parentId: input.parentId ?? null,
          isActive: input.isActive,
        },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'Account',
        entityId: account.id,
        summary: `Created account ${account.code} - ${account.name} (${account.type})`,
      });

      return reply.status(201).send({ data: account });
    },
  );

  // ---- Strategic objectives ---------------------------------------------

  app.get('/objectives', { onRequest: [app.requirePermission('budget:read')] }, async () => {
    const objectives = await prisma.strategicObjective.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
      include: { _count: { select: { budgetLines: true } } },
    });

    return {
      data: objectives.map((o) => ({
        id: o.id,
        code: o.code,
        title: o.title,
        description: o.description,
        horizon: o.horizon,
        targetShare: o.targetShare?.toString() ?? null,
        linkedLineCount: o._count.budgetLines,
      })),
    };
  });

  app.post(
    '/objectives',
    { onRequest: [app.requirePermission('settings:manage')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = strategicObjectiveSchema.parse(request.body);

      const objective = await prisma.strategicObjective.create({
        data: {
          code: input.code,
          title: input.title,
          description: input.description ?? null,
          horizon: input.horizon as never,
          ownerId: input.ownerId ?? null,
          targetShare: input.targetShare ?? null,
        },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'StrategicObjective',
        entityId: objective.id,
        summary: `Created strategic objective ${objective.code} - ${objective.title}`,
      });

      return reply.status(201).send({ data: objective });
    },
  );

  /**
   * Guard rail: target shares across objectives should sum to 1. Surfaced as a
   * warning rather than a hard constraint, because during planning they legitimately
   * will not while objectives are still being added.
   */
  app.get(
    '/objectives/target-check',
    { onRequest: [app.requirePermission('budget:read')] },
    async () => {
      const objectives = await prisma.strategicObjective.findMany({
        where: { isActive: true, targetShare: { not: null } },
        select: { code: true, title: true, targetShare: true },
      });

      const total = objectives.reduce((acc, o) => acc + Number(o.targetShare ?? 0), 0);

      return {
        objectivesWithTargets: objectives.length,
        totalTargetShare: total,
        balanced: Math.abs(total - 1) < 1e-6,
        message:
          Math.abs(total - 1) < 1e-6
            ? 'Target shares sum to 100%.'
            : `Target shares sum to ${(total * 100).toFixed(1)}%. Leadership should reconcile these before the cycle opens.`,
      };
    },
  );

  app.get(
    '/objectives/:id',
    { onRequest: [app.requirePermission('budget:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const objective = await prisma.strategicObjective.findUnique({ where: { id } });
      if (!objective) throw new AppError('NOT_FOUND', `Strategic objective '${id}' was not found.`);
      return { data: objective };
    },
  );
}
