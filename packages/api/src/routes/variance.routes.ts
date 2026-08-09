/**
 * Actuals, variance analysis and full-year outturn projection.
 *
 * This is the "reporting on expenditure against the budget" end of the process -
 * where the budget stops being a plan and starts being a control.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  PERIODS_PER_YEAR,
  importActualsSchema,
  parsePeriodKey,
  varianceQuerySchema,
} from '@ffp/shared';
import {
  buildVarianceReport,
  decomposePriceVolume,
  projectPortfolio,
  type ProjectionBasis,
  type VarianceInput,
} from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

export async function registerVarianceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Import actuals. UPSERT is the default because a finance system re-sends the
   * same period as it is adjusted, and appending would double-count.
   */
  app.post(
    '/actuals/import',
    { onRequest: [app.requirePermission('actuals:import')] },
    async (request) => {
      const actor = requireUser(request);
      const input = importActualsSchema.parse(request.body);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id: input.cycleId } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${input.cycleId}' was not found.`);

      // Reject unparsable, out-of-horizon or already-closed periods up front: a
      // silently misfiled actual is very hard to find later, and writing into a
      // closed period would move an anchor that forecasts are already built on.
      const lastFiscalYear = cycle.fiscalYear + cycle.horizonYears - 1;

      for (const entry of input.entries) {
        const parsed = parsePeriodKey(entry.periodKey);
        if (!parsed) {
          throw new AppError('VALIDATION_ERROR', `'${entry.periodKey}' is not a valid period key.`);
        }
        if (parsed.fiscalYear < cycle.fiscalYear || parsed.fiscalYear > lastFiscalYear) {
          throw new AppError(
            'VALIDATION_ERROR',
            cycle.horizonYears === 1
              ? `Period ${entry.periodKey} belongs to FY${parsed.fiscalYear}, but this cycle is FY${cycle.fiscalYear}.`
              : `Period ${entry.periodKey} falls outside this cycle's horizon of FY${cycle.fiscalYear}–FY${lastFiscalYear}.`,
          );
        }

        // Absolute index across the whole horizon, so a multi-year cycle closes
        // consistently rather than restarting the count each fiscal year.
        const perYear = PERIODS_PER_YEAR[cycle.periodType];
        const absoluteIndex = (parsed.fiscalYear - cycle.fiscalYear) * perYear + parsed.periodIndex;

        if (absoluteIndex <= cycle.actualsThroughPeriod) {
          throw new AppError(
            'PERIOD_LOCKED',
            `Period ${entry.periodKey} is closed and its actuals are locked. Post an adjustment to an open period instead of restating a closed one.`,
            { details: { periodKey: entry.periodKey, closedThrough: cycle.actualsThroughPeriod } },
          );
        }
      }

      let created = 0;
      let updated = 0;

      await prisma.$transaction(
        async (tx) => {
          for (const entry of input.entries) {
            const parsed = parsePeriodKey(entry.periodKey);
            const periodIndex = parsed?.periodIndex ?? 1;

            if (input.mode === 'UPSERT') {
              const existing = await tx.actual.findUnique({
                where: {
                  cycleId_businessUnitId_accountId_periodKey: {
                    cycleId: input.cycleId,
                    businessUnitId: entry.businessUnitId,
                    accountId: entry.accountId,
                    periodKey: entry.periodKey,
                  },
                },
                select: { id: true },
              });
              if (existing) updated += 1;
              else created += 1;

              await tx.actual.upsert({
                where: {
                  cycleId_businessUnitId_accountId_periodKey: {
                    cycleId: input.cycleId,
                    businessUnitId: entry.businessUnitId,
                    accountId: entry.accountId,
                    periodKey: entry.periodKey,
                  },
                },
                create: {
                  cycleId: input.cycleId,
                  businessUnitId: entry.businessUnitId,
                  accountId: entry.accountId,
                  periodKey: entry.periodKey,
                  periodIndex,
                  amount: entry.amount,
                  commitment: entry.commitment ?? '0',
                  source: entry.source,
                  reference: entry.reference ?? null,
                },
                update: {
                  amount: entry.amount,
                  commitment: entry.commitment ?? '0',
                  source: entry.source,
                  reference: entry.reference ?? null,
                },
              });
            } else {
              await tx.actual.create({
                data: {
                  cycleId: input.cycleId,
                  businessUnitId: entry.businessUnitId,
                  accountId: entry.accountId,
                  periodKey: entry.periodKey,
                  periodIndex,
                  amount: entry.amount,
                  commitment: entry.commitment ?? '0',
                  source: entry.source,
                  reference: entry.reference ?? null,
                },
              });
              created += 1;
            }
          }

          await appendAuditEntry(
            {
              actorId: actor.id,
              actorEmail: actor.email,
              action: 'CREATE',
              entityType: 'Actual',
              summary: `Imported ${input.entries.length} actual(s) into cycle '${cycle.name}' (${created} new, ${updated} updated)`,
              changes: { mode: input.mode, count: input.entries.length },
            },
            tx,
          );
        },
        // Bulk imports can be large; the default 5s transaction timeout is not enough.
        { timeout: 120_000, maxWait: 10_000 },
      );

      return { success: true, imported: input.entries.length, created, updated };
    },
  );

  /**
   * Budget vs actual vs commitment, grouped and RAG-banded.
   *
   * Budget and actuals are joined on the period key, which is why the fiscal
   * calendar is generated centrally rather than per module.
   */
  app.get('/report', { onRequest: [app.requirePermission('report:read')] }, async (request) => {
    const query = varianceQuerySchema.parse(request.query);

    const cycle = await prisma.budgetCycle.findUnique({ where: { id: query.cycleId } });
    if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${query.cycleId}' was not found.`);

    const [budgets, actuals] = await Promise.all([
      prisma.budget.findMany({
        where: {
          cycleId: query.cycleId,
          ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
          // Only approved budgets form a baseline worth reporting against.
          status: { in: ['APPROVED', 'LOCKED'] },
        },
        include: {
          businessUnit: { select: { id: true, code: true, name: true } },
          lines: {
            where: query.accountId ? { accountId: query.accountId } : {},
            include: {
              account: { select: { id: true, code: true, name: true, type: true } },
              periods: { orderBy: { periodIndex: 'asc' } },
            },
          },
        },
      }),
      prisma.actual.findMany({
        where: {
          cycleId: query.cycleId,
          ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
          ...(query.accountId ? { accountId: query.accountId } : {}),
        },
      }),
    ]);

    const through = query.throughPeriod ?? PERIODS_PER_YEAR[cycle.periodType];

    // Key on business unit + account so budget and actuals line up exactly.
    const actualByKey = new Map<string, { amount: number; commitment: number }>();
    for (const actual of actuals) {
      if (actual.periodIndex > through) continue;
      const key = `${actual.businessUnitId}|${actual.accountId}`;
      const existing = actualByKey.get(key) ?? { amount: 0, commitment: 0 };
      actualByKey.set(key, {
        amount: existing.amount + Number(actual.amount),
        commitment: existing.commitment + Number(actual.commitment),
      });
    }

    const inputs: VarianceInput[] = [];
    for (const budget of budgets) {
      for (const line of budget.lines) {
        const budgetToDate = line.periods
          .filter((p) => p.periodIndex <= through)
          .reduce((acc, p) => acc + Number(p.amount), 0);

        const key = `${budget.businessUnitId}|${line.accountId}`;
        const actual = actualByKey.get(key) ?? { amount: 0, commitment: 0 };

        inputs.push({
          key: `${budget.businessUnitId}:${line.accountId}`,
          label: `${line.account.code} ${line.account.name}`,
          accountType: line.account.type as never,
          costCategory: (line.costCategory ?? undefined) as never,
          businessUnitId: budget.businessUnitId,
          accountId: line.accountId,
          budget: budgetToDate.toFixed(4),
          actual: actual.amount.toFixed(4),
          commitment: actual.commitment.toFixed(4),
        });
      }
    }

    const report = buildVarianceReport(inputs, {
      groupBy: query.groupBy as never,
      includeCommitments: query.includeCommitments,
      thresholds: {
        amber: query.amberThreshold,
        red: query.redThreshold,
        materialityFloor: '1000',
      },
    });

    return {
      data: {
        ...report,
        meta: {
          cycleId: query.cycleId,
          fiscalYear: cycle.fiscalYear,
          throughPeriod: through,
          periodsInYear: PERIODS_PER_YEAR[cycle.periodType],
          budgetsIncluded: budgets.length,
          note:
            budgets.length === 0
              ? 'No approved budgets exist for this cycle yet, so there is no baseline to report against.'
              : null,
        },
      },
    };
  });

  /** Where the full year will land, on a stated basis. */
  app.get('/projection', { onRequest: [app.requirePermission('report:read')] }, async (request) => {
    const query = z
      .object({
        cycleId: z.string(),
        businessUnitId: z.string().optional(),
        periodsElapsed: z.coerce.number().int().min(1).max(12),
        basis: z.enum(['RUN_RATE', 'BUDGET_REMAINING', 'REFORECAST']).default('RUN_RATE'),
      })
      .parse(request.query);

    const cycle = await prisma.budgetCycle.findUnique({ where: { id: query.cycleId } });
    if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${query.cycleId}' was not found.`);

    const periodsInYear = PERIODS_PER_YEAR[cycle.periodType];
    if (query.periodsElapsed > periodsInYear) {
      throw new AppError(
        'VALIDATION_ERROR',
        `This cycle has ${periodsInYear} periods; ${query.periodsElapsed} have not elapsed.`,
      );
    }

    const budgets = await prisma.budget.findMany({
      where: {
        cycleId: query.cycleId,
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        status: { in: ['APPROVED', 'LOCKED'] },
      },
      include: {
        lines: {
          include: {
            account: { select: { id: true, code: true, name: true, type: true } },
            periods: { orderBy: { periodIndex: 'asc' } },
          },
        },
      },
    });

    const actuals = await prisma.actual.findMany({
      where: {
        cycleId: query.cycleId,
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        periodIndex: { lte: query.periodsElapsed },
      },
    });

    const actualByKey = new Map<string, { amount: number; commitment: number }>();
    for (const actual of actuals) {
      const key = `${actual.businessUnitId}|${actual.accountId}`;
      const existing = actualByKey.get(key) ?? { amount: 0, commitment: 0 };
      actualByKey.set(key, {
        amount: existing.amount + Number(actual.amount),
        commitment: existing.commitment + Number(actual.commitment),
      });
    }

    const inputs = budgets.flatMap((budget) =>
      budget.lines.map((line) => {
        const key = `${budget.businessUnitId}|${line.accountId}`;
        const actual = actualByKey.get(key) ?? { amount: 0, commitment: 0 };
        return {
          key: `${budget.businessUnitId}:${line.accountId}`,
          label: `${line.account.code} ${line.account.name}`,
          accountType: line.account.type as never,
          budget: line.totalAmount.toString(),
          actualToDate: actual.amount.toFixed(4),
          commitmentToDate: actual.commitment.toFixed(4),
          periodsElapsed: query.periodsElapsed,
          periodsInYear,
          // Respect the real phasing rather than assuming straight-line.
          budgetPhasing: line.periods.map((p) => p.amount.toString()),
        };
      }),
    );

    const projection = projectPortfolio(inputs, query.basis as ProjectionBasis);

    return {
      data: {
        ...projection,
        meta: {
          basis: query.basis,
          periodsElapsed: query.periodsElapsed,
          periodsInYear,
          basisExplanation: basisExplanation(query.basis as ProjectionBasis),
        },
      },
    };
  });

  /** Split a variance into its price, volume and joint components. */
  app.post('/decompose', { onRequest: [app.requirePermission('report:read')] }, async (request) => {
    const { lines } = z
      .object({
        lines: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              budgetVolume: z.string(),
              budgetPrice: z.string(),
              actualVolume: z.string(),
              actualPrice: z.string(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(request.body);

    return { data: { lines: lines.map(decomposePriceVolume) } };
  });
}

function basisExplanation(basis: ProjectionBasis): string {
  switch (basis) {
    case 'RUN_RATE':
      return 'Extends the average spend rate observed so far across the remaining periods. Sensitive to phasing and to one-off costs already incurred.';
    case 'BUDGET_REMAINING':
      return 'Assumes the remaining budget is spent exactly as phased. Shows the plan, not the trend.';
    case 'REFORECAST':
      return "Uses the budget holder's submitted reforecast for the remaining periods.";
    default:
      return '';
  }
}
