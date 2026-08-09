/**
 * Rolling forecast cadence and multi-year (Medium Term Plan) views.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  FORECAST_METHODS,
  PERIODS_PER_YEAR,
  queryBoolean,
  toMoneyString,
  type PeriodType,
} from '@ffp/shared';
import { summariseByFiscalYear, type RollingPoint } from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';
import {
  closePeriod,
  periodKeyAt,
  rollForecast,
  totalPeriods,
} from '../services/rolling.service.js';

export async function registerRollingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Close periods up to an index, locking their actuals and moving the anchor
   * the rolling forecast is built from.
   */
  app.post(
    '/cycles/:id/close-period',
    { onRequest: [app.requirePermission('cycle:manage')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { throughPeriod } = z
        .object({ throughPeriod: z.number().int().min(1).max(120) })
        .parse(request.body);

      return { data: await closePeriod(id, throughPeriod, actor) };
    },
  );

  /** Generate the next rolling-forecast generation across the cycle. */
  app.post(
    '/cycles/:id/roll',
    { onRequest: [app.requirePermission('forecast:run')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const options = z
        .object({
          method: z.enum(FORECAST_METHODS).or(z.literal('AUTO')).optional(),
          seasonLength: z.number().int().min(2).max(24).optional(),
          horizonPeriods: z.number().int().min(1).max(60).optional(),
        })
        .parse(request.body ?? {});

      return { data: await rollForecast(id, actor, options) };
    },
  );

  /**
   * The current rolling forecast. Superseded generations are excluded by
   * default: they are retained for scoring and audit, not for reading.
   */
  app.get(
    '/cycles/:id/rolling-forecast',
    { onRequest: [app.requirePermission('forecast:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          businessUnitId: z.string().optional(),
          accountId: z.string().optional(),
          includeSuperseded: queryBoolean.default(false),
        })
        .parse(request.query);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${id}' was not found.`);

      const forecasts = await prisma.rollingForecast.findMany({
        where: {
          cycleId: id,
          ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
          ...(query.accountId ? { accountId: query.accountId } : {}),
          ...(query.includeSuperseded ? {} : { supersededAt: null }),
        },
        orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }],
        include: {
          businessUnit: { select: { id: true, code: true, name: true } },
          account: { select: { id: true, code: true, name: true, type: true } },
        },
      });

      const series = forecasts.map((f) => ({
        id: f.id,
        generation: f.generation,
        anchorPeriodKey: f.anchorPeriodKey,
        horizonPeriods: f.horizonPeriods,
        method: f.method,
        businessUnit: f.businessUnit,
        account: f.account,
        actualToDate: f.actualToDate.toString(),
        forecastRemainder: f.forecastRemainder.toString(),
        fullYearOutturn: f.fullYearOutturn.toString(),
        baselineTotal: f.baselineTotal?.toString() ?? null,
        varianceToBaseline: f.varianceToBaseline?.toString() ?? null,
        priorAccuracy: f.priorAccuracy,
        supersededAt: f.supersededAt,
        points: f.points,
        createdAt: f.createdAt,
      }));

      // Consolidated position across every series in the current generation.
      const consolidated = series
        .filter((s) => s.supersededAt === null)
        .reduce(
          (acc, s) => ({
            actualToDate: acc.actualToDate + Number(s.actualToDate),
            forecastRemainder: acc.forecastRemainder + Number(s.forecastRemainder),
            fullYearOutturn: acc.fullYearOutturn + Number(s.fullYearOutturn),
            baselineTotal: acc.baselineTotal + Number(s.baselineTotal ?? 0),
          }),
          { actualToDate: 0, forecastRemainder: 0, fullYearOutturn: 0, baselineTotal: 0 },
        );

      const variance = consolidated.baselineTotal - consolidated.fullYearOutturn;

      return {
        data: {
          cycle: {
            id: cycle.id,
            name: cycle.name,
            fiscalYear: cycle.fiscalYear,
            horizonYears: cycle.horizonYears,
            actualsThroughPeriod: cycle.actualsThroughPeriod,
            rollingHorizonPeriods: cycle.rollingHorizonPeriods,
            lastRolledAt: cycle.lastRolledAt,
            anchorPeriodKey:
              cycle.actualsThroughPeriod > 0
                ? periodKeyAt(
                    cycle.fiscalYear,
                    cycle.periodType as PeriodType,
                    cycle.actualsThroughPeriod,
                  )
                : null,
          },
          consolidated: {
            actualToDate: toMoneyString(consolidated.actualToDate),
            forecastRemainder: toMoneyString(consolidated.forecastRemainder),
            fullYearOutturn: toMoneyString(consolidated.fullYearOutturn),
            baselineTotal:
              consolidated.baselineTotal === 0 ? null : toMoneyString(consolidated.baselineTotal),
            varianceToBaseline: consolidated.baselineTotal === 0 ? null : toMoneyString(variance),
            variancePercent:
              consolidated.baselineTotal === 0 ? null : variance / consolidated.baselineTotal,
          },
          series,
          meta: {
            seriesCount: series.length,
            note:
              series.length === 0
                ? 'No rolling forecast has been generated. Close a period, then POST to /cycles/:id/roll.'
                : null,
          },
        },
      };
    },
  );

  /**
   * How previous generations actually performed.
   *
   * The feedback loop: a rolling forecast nobody scores will drift for a year
   * before anyone notices, and the drift is exactly what tells you whether to
   * trust the next one.
   */
  app.get(
    '/cycles/:id/forecast-accuracy',
    { onRequest: [app.requirePermission('forecast:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);

      // Filtered in memory rather than with a JSON `not null` predicate: Prisma
      // distinguishes SQL NULL from JSON null, and getting that subtly wrong
      // silently returns the wrong rows.
      const scored = await prisma.rollingForecast.findMany({
        where: { cycleId: id },
        orderBy: [{ generation: 'asc' }],
        include: {
          businessUnit: { select: { code: true, name: true } },
          account: { select: { code: true, name: true } },
        },
      });

      type Review = {
        verdict: string;
        periodsCompared: number;
        metrics: { smape: number; biasPercent: number | null };
      };

      const reviews = scored
        .map((f) => ({
          generation: f.generation,
          anchorPeriodKey: f.anchorPeriodKey,
          businessUnit: f.businessUnit,
          account: f.account,
          review: f.priorAccuracy as unknown as Review | null,
        }))
        .filter((r) => r.review !== null && r.review.periodsCompared > 0);

      const verdictCounts = reviews.reduce<Record<string, number>>((acc, r) => {
        const verdict = r.review?.verdict ?? 'UNKNOWN';
        acc[verdict] = (acc[verdict] ?? 0) + 1;
        return acc;
      }, {});

      const errors = reviews.map((r) => r.review?.metrics.smape ?? 0);
      const meanError =
        errors.length === 0 ? null : errors.reduce((a, b) => a + b, 0) / errors.length;

      return {
        data: {
          reviews,
          summary: {
            generationsScored: reviews.length,
            verdictCounts,
            meanErrorPercent: meanError,
            interpretation:
              meanError === null
                ? 'No generation has been scored yet. Scoring becomes possible once a forecast has been rolled at least twice with a period closing in between.'
                : meanError <= 0.05
                  ? 'Forecasts are landing within 5% of outturn on average. This cadence is working.'
                  : meanError <= 0.15
                    ? 'Forecasts are landing within 15% of outturn. Usable for planning, but not precise enough to commit against.'
                    : 'Forecasts are missing outturn by more than 15% on average. Review the drivers and the method before relying on these numbers.',
          },
        },
      };
    },
  );

  // ---- Multi-year (MTP) --------------------------------------------------

  /**
   * The Medium Term Plan view: a multi-year cycle collapsed to fiscal years.
   *
   * Nobody reviews sixty monthly numbers; a medium-term plan is read a year at
   * a time, with the year-on-year movement as the headline.
   */
  app.get(
    '/cycles/:id/mtp',
    { onRequest: [app.requirePermission('budget:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z.object({ businessUnitId: z.string().optional() }).parse(request.query);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${id}' was not found.`);

      const periodType = cycle.periodType as PeriodType;
      const perYear = PERIODS_PER_YEAR[periodType];
      const expectedPeriods = totalPeriods(periodType, cycle.horizonYears);

      const [budgets, actuals] = await Promise.all([
        prisma.budget.findMany({
          where: {
            cycleId: id,
            ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
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
        }),
        prisma.actual.findMany({
          where: {
            cycleId: id,
            ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
            periodIndex: { lte: cycle.actualsThroughPeriod },
          },
          select: { periodKey: true, amount: true },
        }),
      ]);

      // Budget lines become the plan series; closed actuals overwrite the
      // periods they cover, so the MTP shows outturn where it is known.
      const actualByPeriod = new Map<string, number>();
      for (const actual of actuals) {
        actualByPeriod.set(
          actual.periodKey,
          (actualByPeriod.get(actual.periodKey) ?? 0) + Number(actual.amount),
        );
      }

      const plannedByPeriod = new Map<string, number>();
      for (const budget of budgets) {
        for (const line of budget.lines) {
          for (const period of line.periods) {
            plannedByPeriod.set(
              period.periodKey,
              (plannedByPeriod.get(period.periodKey) ?? 0) + Number(period.amount),
            );
          }
        }
      }

      const allKeys = [...new Set([...plannedByPeriod.keys(), ...actualByPeriod.keys()])].sort();

      const points: RollingPoint[] = allKeys.map((periodKey) => {
        const actual = actualByPeriod.get(periodKey);
        const isActual = actual !== undefined;
        return {
          periodKey,
          basis: isActual ? 'ACTUAL' : 'FORECAST',
          value: toMoneyString(isActual ? actual : (plannedByPeriod.get(periodKey) ?? 0)),
          lower: null,
          upper: null,
          baseline: null,
          variance: null,
        };
      });

      const baseline = [...plannedByPeriod.entries()].map(([periodKey, amount]) => ({
        periodKey,
        amount: toMoneyString(amount),
      }));

      const byYear = summariseByFiscalYear(points, baseline);

      return {
        data: {
          cycle: {
            id: cycle.id,
            name: cycle.name,
            startFiscalYear: cycle.fiscalYear,
            horizonYears: cycle.horizonYears,
            periodType,
            periodsPerYear: perYear,
            expectedPeriods,
            actualsThroughPeriod: cycle.actualsThroughPeriod,
            isMediumTermPlan: cycle.horizonYears > 1,
          },
          byFiscalYear: byYear,
          totals: {
            plan: toMoneyString([...plannedByPeriod.values()].reduce((a, b) => a + b, 0)),
            actual: toMoneyString([...actualByPeriod.values()].reduce((a, b) => a + b, 0)),
          },
          businessUnits: budgets.map((b) => ({
            ...b.businessUnit,
            total: b.totalAmount.toString(),
            status: b.status,
          })),
          meta: {
            note:
              cycle.horizonYears === 1
                ? 'This is a single-year Annual Operating Plan. Set horizonYears above 1 to make it a Medium Term Plan.'
                : null,
          },
        },
      };
    },
  );

  /** Extend a cycle's horizon, turning an annual plan into a medium-term one. */
  app.patch(
    '/cycles/:id/horizon',
    { onRequest: [app.requirePermission('cycle:manage')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z
        .object({
          horizonYears: z.number().int().min(1).max(10).optional(),
          rollingHorizonPeriods: z.number().int().min(0).max(60).optional(),
        })
        .parse(request.body);

      const cycle = await prisma.budgetCycle.findUnique({ where: { id } });
      if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${id}' was not found.`);

      // Shortening the horizon would strand budget-line periods beyond the new
      // end with no way to display or approve them.
      if (input.horizonYears !== undefined && input.horizonYears < cycle.horizonYears) {
        const budgetCount = await prisma.budget.count({ where: { cycleId: id } });
        if (budgetCount > 0) {
          throw new AppError(
            'CONFLICT',
            `The horizon cannot be shortened from ${cycle.horizonYears} to ${input.horizonYears} years while ${budgetCount} budget(s) exist against it; their later periods would be stranded.`,
            { details: { budgetCount, current: cycle.horizonYears } },
          );
        }
      }

      const updated = await prisma.budgetCycle.update({
        where: { id },
        data: {
          ...(input.horizonYears !== undefined ? { horizonYears: input.horizonYears } : {}),
          ...(input.rollingHorizonPeriods !== undefined
            ? { rollingHorizonPeriods: input.rollingHorizonPeriods }
            : {}),
        },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'UPDATE',
        entityType: 'BudgetCycle',
        entityId: id,
        summary: `Updated planning horizon on '${cycle.name}': ${updated.horizonYears} year(s), rolling ${updated.rollingHorizonPeriods} period(s)`,
        changes: {
          horizonYears: { from: cycle.horizonYears, to: updated.horizonYears },
          rollingHorizonPeriods: {
            from: cycle.rollingHorizonPeriods,
            to: updated.rollingHorizonPeriods,
          },
        },
      });

      return {
        data: {
          id: updated.id,
          horizonYears: updated.horizonYears,
          rollingHorizonPeriods: updated.rollingHorizonPeriods,
          expectedPeriods: totalPeriods(updated.periodType as PeriodType, updated.horizonYears),
        },
      };
    },
  );
}
