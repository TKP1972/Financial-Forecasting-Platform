/**
 * Budget cycle management and the annual guideline pack.
 *
 * The cycle is what turns budgeting from a spreadsheet exercise into a governed
 * process: it fixes the fiscal calendar, the planning assumptions every unit must
 * use, the top-down targets, and the deadlines.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  buildFiscalYear,
  createBudgetCycleSchema,
  publishGuidanceSchema,
  budgetAssumptionSchema,
} from '@ffp/shared';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';
import { buildGuidancePack, renderGuidancePackMarkdown } from '../services/guidance.service.js';

export async function registerCycleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { onRequest: [app.requirePermission('cycle:read')] }, async () => {
    const cycles = await prisma.budgetCycle.findMany({
      orderBy: [{ fiscalYear: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { budgets: true, assumptions: true, targets: true } },
        guidance: { select: { id: true, publishedAt: true, version: true } },
      },
    });

    return {
      data: cycles.map((cycle) => ({
        id: cycle.id,
        name: cycle.name,
        fiscalYear: cycle.fiscalYear,
        periodType: cycle.periodType,
        status: cycle.status,
        opensAt: cycle.opensAt,
        submissionDeadline: cycle.submissionDeadline,
        approvalDeadline: cycle.approvalDeadline,
        baseCurrency: cycle.baseCurrency,
        budgetCount: cycle._count.budgets,
        assumptionCount: cycle._count.assumptions,
        targetCount: cycle._count.targets,
        guidancePublishedAt: cycle.guidance?.publishedAt ?? null,
        // Surfaced so the UI can show "8 days to submission deadline".
        daysToSubmission: daysBetween(new Date(), cycle.submissionDeadline),
      })),
    };
  });

  app.get('/:id', { onRequest: [app.requirePermission('cycle:read')] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const cycle = await prisma.budgetCycle.findUnique({
      where: { id },
      include: {
        assumptions: { orderBy: { key: 'asc' } },
        guidance: true,
        targets: { include: { businessUnit: { select: { id: true, code: true, name: true } } } },
        budgets: {
          select: {
            id: true,
            name: true,
            status: true,
            totalAmount: true,
            businessUnit: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${id}' was not found.`);

    const periods = buildFiscalYear(cycle.fiscalYear, cycle.periodType);

    return {
      data: {
        ...cycle,
        periods: periods.map((p) => ({
          key: p.key,
          label: p.label,
          periodIndex: p.periodIndex,
          quarter: p.quarter,
          startDate: p.startDate,
          endDateExclusive: p.endDateExclusive,
        })),
        assumptions: cycle.assumptions.map((a) => ({ ...a, value: a.value.toString() })),
        targets: cycle.targets.map((t) => ({
          ...t,
          revenueTarget: t.revenueTarget?.toString() ?? null,
          costCeiling: t.costCeiling?.toString() ?? null,
        })),
        budgets: cycle.budgets.map((b) => ({ ...b, totalAmount: b.totalAmount.toString() })),
      },
    };
  });

  app.post('/', { onRequest: [app.requirePermission('cycle:manage')] }, async (request, reply) => {
    const actor = requireUser(request);
    const input = createBudgetCycleSchema.parse(request.body);

    const cycle = await prisma.budgetCycle.create({
      data: {
        name: input.name,
        fiscalYear: input.fiscalYear,
        periodType: input.periodType as never,
        status: input.status as never,
        opensAt: new Date(input.opensAt),
        submissionDeadline: new Date(input.submissionDeadline),
        approvalDeadline: new Date(input.approvalDeadline),
        baseCurrency: input.baseCurrency ?? config.BASE_CURRENCY,
        guidanceNotes: input.guidanceNotes ?? null,
      },
    });

    await appendAuditEntry({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'CREATE',
      entityType: 'BudgetCycle',
      entityId: cycle.id,
      summary: `Opened budget cycle '${cycle.name}' for FY${cycle.fiscalYear}`,
      changes: {
        fiscalYear: cycle.fiscalYear,
        submissionDeadline: cycle.submissionDeadline.toISOString(),
      },
    });

    return reply.status(201).send({ data: cycle });
  });

  app.patch(
    '/:id/status',
    { onRequest: [app.requirePermission('cycle:manage')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { status } = z
        .object({ status: z.enum(['PLANNING', 'OPEN', 'CONSOLIDATING', 'CLOSED']) })
        .parse(request.body);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${id}' was not found.`);

      // Closing a cycle with budgets still in flight would strand them: they
      // could never be approved, and the consolidated total would be wrong.
      if (status === 'CLOSED') {
        const open = await prisma.budget.count({
          where: { cycleId: id, status: { in: ['DRAFT', 'IN_REVIEW', 'SUBMITTED'] } },
        });
        if (open > 0) {
          throw new AppError(
            'CONFLICT',
            `${open} budget(s) are still in progress. Approve or reject them before closing the cycle.`,
            { details: { outstandingBudgets: open } },
          );
        }
      }

      const updated = await prisma.budgetCycle.update({
        where: { id },
        data: { status: status as never },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'UPDATE',
        entityType: 'BudgetCycle',
        entityId: id,
        summary: `Budget cycle '${cycle.name}' moved from ${cycle.status} to ${status}`,
        changes: { status: { from: cycle.status, to: status } },
      });

      return { data: updated };
    },
  );

  // ---- Planning assumptions ---------------------------------------------

  app.put(
    '/:id/assumptions',
    { onRequest: [app.requirePermission('guidance:publish')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { assumptions } = z
        .object({ assumptions: z.array(budgetAssumptionSchema).max(100) })
        .parse(request.body);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${id}' was not found.`);

      await prisma.$transaction(async (tx) => {
        await tx.budgetAssumption.deleteMany({ where: { cycleId: id } });
        if (assumptions.length > 0) {
          await tx.budgetAssumption.createMany({
            data: assumptions.map((a) => ({
              cycleId: id,
              key: a.key,
              label: a.label,
              value: a.value,
              unit: a.unit,
              notes: a.notes ?? null,
            })),
          });
        }

        await appendAuditEntry(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            action: 'UPDATE',
            entityType: 'BudgetCycle',
            entityId: id,
            summary: `Set ${assumptions.length} planning assumption(s) on cycle '${cycle.name}'`,
            changes: { assumptions: assumptions.map((a) => ({ key: a.key, value: a.value })) },
          },
          tx,
        );
      });

      return { success: true, count: assumptions.length };
    },
  );

  // ---- Guideline pack ----------------------------------------------------

  /**
   * Publish the annual budget plan and guideline pack.
   *
   * Versioned: republishing increments the version rather than overwriting, so a
   * unit can always establish which guidance it budgeted against.
   */
  app.post(
    '/guidance',
    { onRequest: [app.requirePermission('guidance:publish')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = publishGuidanceSchema.parse(request.body);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id: input.cycleId } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${input.cycleId}' was not found.`);

      const existing = await prisma.budgetGuidance.findUnique({
        where: { cycleId: input.cycleId },
      });
      const version = (existing?.version ?? 0) + 1;

      const guidance = await prisma.$transaction(async (tx) => {
        const record = await tx.budgetGuidance.upsert({
          where: { cycleId: input.cycleId },
          create: {
            cycleId: input.cycleId,
            title: input.title,
            strategicPriorities: input.strategicPriorities,
            submissionInstructions: input.submissionInstructions ?? null,
            publishedAt: new Date(),
            publishedById: actor.id,
            version,
          },
          update: {
            title: input.title,
            strategicPriorities: input.strategicPriorities,
            submissionInstructions: input.submissionInstructions ?? null,
            publishedAt: new Date(),
            publishedById: actor.id,
            version,
          },
        });

        if (input.assumptions.length > 0) {
          await tx.budgetAssumption.deleteMany({ where: { cycleId: input.cycleId } });
          await tx.budgetAssumption.createMany({
            data: input.assumptions.map((a) => ({
              cycleId: input.cycleId,
              key: a.key,
              label: a.label,
              value: a.value,
              unit: a.unit,
              notes: a.notes ?? null,
            })),
          });
        }

        for (const target of input.targets) {
          await tx.budgetTarget.upsert({
            where: {
              cycleId_businessUnitId: {
                cycleId: input.cycleId,
                businessUnitId: target.businessUnitId,
              },
            },
            create: {
              cycleId: input.cycleId,
              businessUnitId: target.businessUnitId,
              revenueTarget: target.revenueTarget ?? null,
              costCeiling: target.costCeiling ?? null,
              headcountCeiling: target.headcountCeiling ?? null,
            },
            update: {
              revenueTarget: target.revenueTarget ?? null,
              costCeiling: target.costCeiling ?? null,
              headcountCeiling: target.headcountCeiling ?? null,
            },
          });
        }

        await appendAuditEntry(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            action: 'CREATE',
            entityType: 'BudgetGuidance',
            entityId: record.id,
            summary: `Published guideline pack v${version} for cycle '${cycle.name}'`,
            changes: {
              version,
              priorities: input.strategicPriorities.length,
              assumptions: input.assumptions.length,
              targets: input.targets.length,
            },
          },
          tx,
        );

        return record;
      });

      return reply.status(201).send({ data: guidance });
    },
  );

  /** The assembled guideline pack, as structured data for the UI. */
  app.get(
    '/:id/guidance-pack',
    { onRequest: [app.requirePermission('cycle:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      return { data: await buildGuidancePack(id) };
    },
  );

  /** The same pack rendered as a distributable Markdown document. */
  app.get(
    '/:id/guidance-pack.md',
    { onRequest: [app.requirePermission('cycle:read')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const pack = await buildGuidancePack(id);
      const markdown = renderGuidancePackMarkdown(pack);

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'EXPORT',
        entityType: 'BudgetCycle',
        entityId: id,
        summary: `Exported the guideline pack for '${pack.cycle.name}' as Markdown`,
      });

      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="budget-guidance-FY${pack.cycle.fiscalYear}-v${pack.version}.md"`,
        )
        .send(markdown);
    },
  );
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}
