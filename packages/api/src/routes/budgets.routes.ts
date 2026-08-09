/**
 * Budget preparation, workflow and consolidation.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  budgetTransitionSchema,
  createBudgetSchema,
  paginationSchema,
  queryBoolean,
  toMoneyString,
  type BudgetStatus,
} from '@ffp/shared';
import { assessAlignment } from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import {
  availableTransitions,
  createBudget,
  replaceBudgetLines,
  transitionBudget,
} from '../services/budget.service.js';

export async function registerBudgetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { onRequest: [app.requirePermission('budget:read')] }, async (request) => {
    const query = paginationSchema
      .extend({
        cycleId: z.string().optional(),
        businessUnitId: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(request.query);

    const where = {
      ...(query.cycleId ? { cycleId: query.cycleId } : {}),
      ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
      ...(query.status ? { status: query.status as never } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.budget.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { updatedAt: 'desc' },
        include: {
          businessUnit: { select: { id: true, code: true, name: true } },
          cycle: { select: { id: true, name: true, fiscalYear: true } },
          preparedBy: { select: { id: true, firstName: true, lastName: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { lines: true } },
        },
      }),
      prisma.budget.count({ where }),
    ]);

    const actor = requireUser(request);

    return {
      data: rows.map((budget) => ({
        id: budget.id,
        name: budget.name,
        status: budget.status,
        version: budget.version,
        currency: budget.currency,
        totalAmount: budget.totalAmount.toString(),
        lineCount: budget._count.lines,
        businessUnit: budget.businessUnit,
        cycle: budget.cycle,
        preparedBy: budget.preparedBy,
        approvedBy: budget.approvedBy,
        submittedAt: budget.submittedAt,
        approvedAt: budget.approvedAt,
        updatedAt: budget.updatedAt,
        // Lets the UI render only the buttons this user can actually use.
        availableTransitions: availableTransitions(budget.status as BudgetStatus, actor.role),
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  app.get('/:id', { onRequest: [app.requirePermission('budget:read')] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const actor = requireUser(request);

    const budget = await prisma.budget.findUnique({
      where: { id },
      include: {
        businessUnit: true,
        cycle: true,
        preparedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        lines: {
          orderBy: { sortOrder: 'asc' },
          include: {
            account: { select: { id: true, code: true, name: true, type: true } },
            strategicObjective: { select: { id: true, code: true, title: true } },
            periods: { orderBy: { periodIndex: 'asc' } },
          },
        },
        approvals: {
          orderBy: { createdAt: 'desc' },
          include: { approver: { select: { id: true, firstName: true, lastName: true } } },
        },
        versions: {
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            status: true,
            totalAmount: true,
            comment: true,
            createdAt: true,
          },
        },
      },
    });

    if (!budget) throw new AppError('NOT_FOUND', `Budget '${id}' was not found.`);

    return {
      data: {
        ...budget,
        totalAmount: budget.totalAmount.toString(),
        lines: budget.lines.map((line) => ({
          ...line,
          totalAmount: line.totalAmount.toString(),
          periods: line.periods.map((p) => ({ ...p, amount: p.amount.toString() })),
        })),
        approvals: budget.approvals.map((a) => ({ ...a, amount: a.amount.toString() })),
        versions: budget.versions.map((v) => ({ ...v, totalAmount: v.totalAmount.toString() })),
        availableTransitions: availableTransitions(budget.status as BudgetStatus, actor.role),
      },
    };
  });

  app.post('/', { onRequest: [app.requirePermission('budget:write')] }, async (request, reply) => {
    const actor = requireUser(request);
    const input = createBudgetSchema.parse(request.body);

    const result = await createBudget(
      {
        cycleId: input.cycleId,
        businessUnitId: input.businessUnitId,
        name: input.name,
        currency: input.currency,
        lines: input.lines.map((line) => ({
          accountId: line.accountId,
          costCategory: line.costCategory ?? null,
          method: line.method,
          description: line.description ?? null,
          periodAmounts: line.periodAmounts,
          driverId: line.driverId ?? null,
          strategicObjectiveId: line.strategicObjectiveId ?? null,
          alignment: line.alignment,
          justification: line.justification ?? null,
        })),
      },
      actor,
      { ipAddress: request.ip, userAgent: request.headers['user-agent'] },
    );

    return reply.status(201).send({ data: result });
  });

  app.put('/:id/lines', { onRequest: [app.requirePermission('budget:write')] }, async (request) => {
    const actor = requireUser(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { lines } = z.object({ lines: createBudgetSchema.shape.lines }).parse(request.body);

    const result = await replaceBudgetLines(
      id,
      lines.map((line) => ({
        accountId: line.accountId,
        costCategory: line.costCategory ?? null,
        method: line.method,
        description: line.description ?? null,
        periodAmounts: line.periodAmounts,
        driverId: line.driverId ?? null,
        strategicObjectiveId: line.strategicObjectiveId ?? null,
        alignment: line.alignment,
        justification: line.justification ?? null,
      })),
      actor,
      { ipAddress: request.ip, userAgent: request.headers['user-agent'] },
    );

    return { data: result };
  });

  /**
   * Drive the workflow. Every governance control lives in the service, so this
   * handler stays a thin shell - there is exactly one path to a status change.
   */
  app.post('/:id/transition', { onRequest: [app.authenticate] }, async (request) => {
    const actor = requireUser(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { to, comment } = budgetTransitionSchema.parse(request.body);

    const result = await transitionBudget(id, to, actor, {
      comment,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { data: result };
  });

  /** Consolidated view across every budget in a cycle. */
  app.get(
    '/consolidated/:cycleId',
    { onRequest: [app.requirePermission('budget:read')] },
    async (request) => {
      const { cycleId } = z.object({ cycleId: z.string() }).parse(request.params);
      const query = z.object({ approvedOnly: queryBoolean.default(false) }).parse(request.query);

      const budgets = await prisma.budget.findMany({
        where: {
          cycleId,
          ...(query.approvedOnly ? { status: { in: ['APPROVED', 'LOCKED'] } } : {}),
        },
        include: {
          businessUnit: { select: { id: true, code: true, name: true } },
          lines: {
            include: {
              account: { select: { code: true, name: true, type: true } },
              periods: { orderBy: { periodIndex: 'asc' } },
            },
          },
        },
      });

      const byUnit = budgets.map((budget) => ({
        businessUnit: budget.businessUnit,
        status: budget.status,
        totalAmount: budget.totalAmount.toString(),
      }));

      const byAccountType = new Map<string, number>();
      const byPeriod = new Map<string, number>();

      for (const budget of budgets) {
        for (const line of budget.lines) {
          const type = line.account.type;
          byAccountType.set(type, (byAccountType.get(type) ?? 0) + Number(line.totalAmount));
          for (const period of line.periods) {
            byPeriod.set(
              period.periodKey,
              (byPeriod.get(period.periodKey) ?? 0) + Number(period.amount),
            );
          }
        }
      }

      const grandTotal = budgets.reduce((acc, b) => acc + Number(b.totalAmount), 0);

      return {
        data: {
          cycleId,
          budgetCount: budgets.length,
          grandTotal: toMoneyString(grandTotal),
          byBusinessUnit: byUnit,
          byAccountType: [...byAccountType.entries()]
            .map(([type, amount]) => ({ type, amount: toMoneyString(amount) }))
            .sort((a, b) => Number(b.amount) - Number(a.amount)),
          byPeriod: [...byPeriod.entries()]
            .map(([periodKey, amount]) => ({ periodKey, amount: toMoneyString(amount) }))
            .sort((a, b) => a.periodKey.localeCompare(b.periodKey)),
        },
      };
    },
  );

  /**
   * How well this budget maps onto the organisation's strategic objectives.
   * The "educate stakeholders on strategic alignment" part of the mandate, made
   * concrete enough to argue with.
   */
  app.get(
    '/:id/alignment',
    { onRequest: [app.requirePermission('budget:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const budget = await prisma.budget.findUnique({
        where: { id },
        include: {
          lines: {
            include: {
              account: { select: { code: true, name: true } },
              strategicObjective: true,
            },
          },
        },
      });
      if (!budget) throw new AppError('NOT_FOUND', `Budget '${id}' was not found.`);

      const objectives = await prisma.strategicObjective.findMany({ where: { isActive: true } });

      const report = assessAlignment(
        budget.lines.map((line) => ({
          id: line.id,
          label: line.description ?? line.account.name,
          amount: line.totalAmount.toString(),
          objectiveId: line.strategicObjectiveId,
          alignment: line.alignment as never,
        })),
        objectives.map((o) => ({
          id: o.id,
          code: o.code,
          title: o.title,
          horizon: o.horizon as never,
          targetShare: o.targetShare === null ? undefined : Number(o.targetShare),
        })),
      );

      return { data: report };
    },
  );

  /** Retrieve a historical snapshot exactly as it was at that version. */
  app.get(
    '/:id/versions/:version',
    { onRequest: [app.requirePermission('budget:read')] },
    async (request) => {
      const { id, version } = z
        .object({ id: z.string(), version: z.coerce.number().int().min(1) })
        .parse(request.params);

      const record = await prisma.budgetVersion.findUnique({
        where: { budgetId_version: { budgetId: id, version } },
        include: { createdBy: { select: { id: true, firstName: true, lastName: true } } },
      });

      if (!record) {
        throw new AppError('NOT_FOUND', `Version ${version} of budget '${id}' was not found.`);
      }

      return { data: { ...record, totalAmount: record.totalAmount.toString() } };
    },
  );
}
