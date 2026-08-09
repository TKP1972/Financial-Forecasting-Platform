/**
 * Rolling forecast cadence and period closing.
 *
 * Two governed operations:
 *
 *  - **Closing a period** fixes actuals up to that point. It is deliberately an
 *    explicit act rather than a function of the calendar, because a forecast
 *    that silently re-anchored when someone imported a partial month would
 *    produce numbers that change under the reader between one refresh and the
 *    next.
 *  - **Rolling** generates a new forecast generation from the closed anchor, and
 *    scores the generation it replaces against what has since happened. That
 *    scoring is the point: without it, "continuous recalibration" is just
 *    re-running a model on a schedule.
 */
import {
  AppError,
  PERIODS_PER_YEAR,
  periodKey as makePeriodKey,
  type ForecastMethod,
  type PeriodType,
} from '@ffp/shared';
import {
  assessForecastAccuracy,
  buildRollingForecast,
  type BaselinePoint,
  type HistoricalPoint,
  type PointBasis,
} from '@ffp/engine';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { appendAuditEntry } from './audit.service.js';
import type { AuthenticatedUser } from './auth.service.js';

/** Total periods a cycle covers across its whole horizon. */
export function totalPeriods(periodType: PeriodType, horizonYears: number): number {
  return PERIODS_PER_YEAR[periodType] * horizonYears;
}

/** Absolute period index (1-based across the horizon) to its period key. */
export function periodKeyAt(
  startFiscalYear: number,
  periodType: PeriodType,
  absoluteIndex: number,
): string {
  const perYear = PERIODS_PER_YEAR[periodType];
  const yearOffset = Math.floor((absoluteIndex - 1) / perYear);
  const withinYear = ((absoluteIndex - 1) % perYear) + 1;
  return makePeriodKey(startFiscalYear + yearOffset, withinYear, periodType);
}

// --------------------------------------------------------------------------
// Period closing
// --------------------------------------------------------------------------

export interface ClosePeriodResult {
  cycleId: string;
  closedThroughPeriod: number;
  closedPeriodKey: string;
  actualsLocked: number;
}

/**
 * Advance the closed-period boundary.
 *
 * Refuses to close a period with no actuals at all: an empty close would anchor
 * a rolling forecast on a period that never happened, and every subsequent
 * outturn would be wrong in a way that is very hard to trace back.
 */
export async function closePeriod(
  cycleId: string,
  throughPeriod: number,
  actor: AuthenticatedUser,
): Promise<ClosePeriodResult> {
  const cycle = await prisma.budgetCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${cycleId}' was not found.`);

  const max = totalPeriods(cycle.periodType as PeriodType, cycle.horizonYears);

  if (!Number.isInteger(throughPeriod) || throughPeriod < 1 || throughPeriod > max) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Period must be between 1 and ${max} for this cycle, got ${throughPeriod}.`,
      { details: { max, requested: throughPeriod } },
    );
  }

  // Reopening a closed period would invalidate every forecast anchored after it
  // and every variance report already issued against it.
  if (throughPeriod <= cycle.actualsThroughPeriod) {
    throw new AppError(
      'CONFLICT',
      `Period ${cycle.actualsThroughPeriod} is already closed. Periods cannot be reopened; post an adjustment to a later period instead.`,
      { details: { closedThrough: cycle.actualsThroughPeriod, requested: throughPeriod } },
    );
  }

  const closedPeriodKey = periodKeyAt(
    cycle.fiscalYear,
    cycle.periodType as PeriodType,
    throughPeriod,
  );

  const actualsInRange = await prisma.actual.count({
    where: { cycleId, periodIndex: { lte: throughPeriod } },
  });
  if (actualsInRange === 0) {
    throw new AppError(
      'CONFLICT',
      `No actuals have been imported for periods up to ${closedPeriodKey}. Import them before closing, or the rolling forecast will anchor on a period that never happened.`,
      { details: { closedPeriodKey } },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.budgetCycle.update({
      where: { id: cycleId },
      data: { actualsThroughPeriod: throughPeriod },
    });

    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'LOCK',
        entityType: 'BudgetCycle',
        entityId: cycleId,
        summary: `Closed periods through ${closedPeriodKey} on cycle '${cycle.name}'; ${actualsInRange} actual(s) locked`,
        changes: {
          actualsThroughPeriod: { from: cycle.actualsThroughPeriod, to: throughPeriod },
          closedPeriodKey,
        },
      },
      tx,
    );
  });

  return {
    cycleId,
    closedThroughPeriod: throughPeriod,
    closedPeriodKey,
    actualsLocked: actualsInRange,
  };
}

/** True when an actual falls in a closed period and must not be edited. */
export async function isPeriodLocked(cycleId: string, periodIndex: number): Promise<boolean> {
  const cycle = await prisma.budgetCycle.findUnique({
    where: { id: cycleId },
    select: { actualsThroughPeriod: true },
  });
  return (cycle?.actualsThroughPeriod ?? 0) >= periodIndex;
}

// --------------------------------------------------------------------------
// Rolling
// --------------------------------------------------------------------------

export interface RollResult {
  cycleId: string;
  anchorPeriodKey: string;
  generation: number;
  seriesRolled: number;
  skipped: Array<{ businessUnitId: string; accountId: string; reason: string }>;
  scored: number;
  rolledAt: string;
}

/**
 * Generate a new rolling-forecast generation for every business unit and account
 * with enough closed history, superseding the previous generation and scoring it.
 */
export async function rollForecast(
  cycleId: string,
  actor: AuthenticatedUser,
  options: {
    method?: ForecastMethod | 'AUTO';
    seasonLength?: number;
    horizonPeriods?: number;
  } = {},
): Promise<RollResult> {
  const cycle = await prisma.budgetCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${cycleId}' was not found.`);

  if (cycle.actualsThroughPeriod < 1) {
    throw new AppError(
      'CONFLICT',
      'No period has been closed on this cycle yet. Close a period before rolling the forecast.',
    );
  }

  const horizonPeriods = options.horizonPeriods ?? cycle.rollingHorizonPeriods;
  if (horizonPeriods < 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      'This cycle has no rolling horizon configured. Set rollingHorizonPeriods on the cycle, or pass a horizon explicitly.',
    );
  }

  const periodType = cycle.periodType as PeriodType;
  const anchorPeriodKey = periodKeyAt(cycle.fiscalYear, periodType, cycle.actualsThroughPeriod);

  // Every unit/account pair that has any actuals in this cycle.
  const series = await prisma.actual.groupBy({
    by: ['businessUnitId', 'accountId'],
    where: { cycleId },
  });

  const [allActuals, approvedBudgets] = await Promise.all([
    prisma.actual.findMany({
      where: { cycleId, periodIndex: { lte: cycle.actualsThroughPeriod } },
      select: { businessUnitId: true, accountId: true, periodKey: true, amount: true },
      orderBy: { periodKey: 'asc' },
    }),
    prisma.budget.findMany({
      where: { cycleId, status: { in: ['APPROVED', 'LOCKED'] } },
      select: {
        businessUnitId: true,
        lines: {
          select: {
            accountId: true,
            periods: { select: { periodKey: true, amount: true } },
          },
        },
      },
    }),
  ]);

  const actualsByKey = new Map<string, HistoricalPoint[]>();
  for (const row of allActuals) {
    const key = `${row.businessUnitId}|${row.accountId}`;
    const list = actualsByKey.get(key) ?? [];
    list.push({ periodKey: row.periodKey, value: Number(row.amount) });
    actualsByKey.set(key, list);
  }

  const baselineByKey = new Map<string, BaselinePoint[]>();
  for (const budget of approvedBudgets) {
    for (const line of budget.lines) {
      const key = `${budget.businessUnitId}|${line.accountId}`;
      const list = baselineByKey.get(key) ?? [];
      for (const period of line.periods) {
        list.push({ periodKey: period.periodKey, amount: period.amount.toString() });
      }
      baselineByKey.set(key, list);
    }
  }

  const skipped: RollResult['skipped'] = [];
  let rolled = 0;
  let scored = 0;
  let generation = 1;
  const rolledAt = new Date();

  for (const entry of series) {
    const key = `${entry.businessUnitId}|${entry.accountId}`;
    const history = actualsByKey.get(key) ?? [];

    // Two closed periods is the floor for any method to produce a forecast.
    if (history.length < 2) {
      skipped.push({
        businessUnitId: entry.businessUnitId,
        accountId: entry.accountId,
        reason: `Only ${history.length} closed period(s) of history; at least 2 are needed to forecast.`,
      });
      continue;
    }
    if (!history.some((h) => h.periodKey === anchorPeriodKey)) {
      skipped.push({
        businessUnitId: entry.businessUnitId,
        accountId: entry.accountId,
        reason: `No actual recorded for the anchor period ${anchorPeriodKey}.`,
      });
      continue;
    }

    let result;
    try {
      result = buildRollingForecast({
        actuals: history,
        anchorPeriodKey,
        horizonPeriods,
        method: options.method ?? 'AUTO',
        seasonLength: options.seasonLength,
        baseline: baselineByKey.get(key),
      });
    } catch (error) {
      skipped.push({
        businessUnitId: entry.businessUnitId,
        accountId: entry.accountId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const previous = await prisma.rollingForecast.findFirst({
      where: {
        cycleId,
        businessUnitId: entry.businessUnitId,
        accountId: entry.accountId,
        supersededAt: null,
      },
      orderBy: { generation: 'desc' },
    });

    // Score the generation being replaced against everything that has closed
    // since it was produced.
    const priorAccuracy = previous
      ? assessForecastAccuracy(
          previous.points as unknown as Array<{
            periodKey: string;
            basis: PointBasis;
            value: string;
          }>,
          history,
        )
      : null;
    if (priorAccuracy && priorAccuracy.periodsCompared > 0) scored += 1;

    const nextGeneration = (previous?.generation ?? 0) + 1;
    generation = Math.max(generation, nextGeneration);

    await prisma.$transaction(async (tx) => {
      const created = await tx.rollingForecast.create({
        data: {
          cycleId,
          businessUnitId: entry.businessUnitId,
          accountId: entry.accountId,
          anchorPeriodKey,
          anchorPeriodIndex: result.anchorPeriodIndex,
          horizonPeriods,
          generation: nextGeneration,
          method: result.method as never,
          points: result.points as unknown as Prisma.InputJsonValue,
          actualToDate: result.actualToDate,
          forecastRemainder: result.forecastRemainder,
          fullYearOutturn: result.fullYearOutturn,
          baselineTotal: result.baselineTotal,
          varianceToBaseline: result.varianceToBaseline,
          priorAccuracy: priorAccuracy
            ? (JSON.parse(JSON.stringify(priorAccuracy)) as Prisma.InputJsonValue)
            : undefined,
          createdById: actor.id,
        },
        select: { id: true },
      });

      if (previous) {
        await tx.rollingForecast.update({
          where: { id: previous.id },
          data: { supersededById: created.id, supersededAt: rolledAt },
        });
      }
    });

    rolled += 1;
  }

  await prisma.$transaction(async (tx) => {
    await tx.budgetCycle.update({ where: { id: cycleId }, data: { lastRolledAt: rolledAt } });
    await appendAuditEntry(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'RECALCULATE',
        entityType: 'BudgetCycle',
        entityId: cycleId,
        summary: `Rolled the forecast on '${cycle.name}' at ${anchorPeriodKey}: ${rolled} series (generation ${generation}), ${scored} prior generation(s) scored, ${skipped.length} skipped`,
        changes: {
          anchorPeriodKey,
          horizonPeriods,
          seriesRolled: rolled,
          skipped: skipped.length,
          generation,
        },
      },
      tx,
    );
  });

  return {
    cycleId,
    anchorPeriodKey,
    generation,
    seriesRolled: rolled,
    skipped,
    scored,
    rolledAt: rolledAt.toISOString(),
  };
}
