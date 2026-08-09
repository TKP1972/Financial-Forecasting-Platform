/**
 * Rolling forecasts.
 *
 * The shift the framework asks for is from a static annual plan to a forecast
 * that is continuously recalibrated against what actually happened. Mechanically
 * that means three things, and the third is the one that is usually missing:
 *
 *  1. A forecast is always **actuals to date plus a forecast forward**, never one
 *     or the other. The full-year outturn is the sum of both.
 *  2. It re-anchors on a cadence, so the horizon stays a constant distance ahead
 *     rather than shrinking to nothing by month eleven.
 *  3. Each new generation **scores the one it replaces** against what actually
 *     happened. Without that, "continuous recalibration" is just re-running a
 *     model on a schedule and nobody ever learns whether it is any good.
 *
 * The anchor is the last *closed* period, not "today". Closing a period is an
 * explicit governed act: a forecast that silently re-anchored whenever someone
 * imported a partial month would produce numbers that change under the reader.
 */
import {
  CalculationError,
  Decimal,
  PERIODS_PER_YEAR,
  add,
  parsePeriodKey,
  periodKey as makePeriodKey,
  toMoneyString,
  type ForecastMethod,
  type PeriodType,
} from '@ffp/shared';
import { accuracyMetrics } from './metrics.js';
import { autoForecast, forecast, nextPeriodKeys } from './forecast.js';
import type { AccuracyMetrics, HistoricalPoint } from './types.js';

export type PointBasis = 'ACTUAL' | 'FORECAST';

export interface RollingPoint {
  periodKey: string;
  basis: PointBasis;
  value: string;
  /** Prediction interval, present only on forecast points. */
  lower: string | null;
  upper: string | null;
  /** Approved baseline for this period, when one was supplied. */
  baseline: string | null;
  /** baseline - value. Positive means running under plan. */
  variance: string | null;
}

export interface BaselinePoint {
  periodKey: string;
  amount: string | number;
}

export interface RollingForecastInput {
  /** Actuals in period order, oldest first. Must reach the anchor. */
  actuals: HistoricalPoint[];
  /** Last closed period. Everything after it is forecast. */
  anchorPeriodKey: string;
  /** Periods to forecast forward from the anchor. */
  horizonPeriods: number;
  method?: ForecastMethod | 'AUTO';
  seasonLength?: number;
  confidenceLevel?: number;
  /** Approved budget by period, for variance against plan. */
  baseline?: BaselinePoint[];
}

export interface RollingForecastResult {
  anchorPeriodKey: string;
  anchorPeriodIndex: number;
  fiscalYear: number;
  periodType: PeriodType;
  horizonPeriods: number;
  method: ForecastMethod;
  points: RollingPoint[];
  /** Actuals within the anchor's fiscal year, up to and including the anchor. */
  actualToDate: string;
  /** Forecast for the rest of the anchor's fiscal year. */
  forecastRemainder: string;
  /** actualToDate + forecastRemainder. The number that answers "where will we land?". */
  fullYearOutturn: string;
  /** Forecast beyond the anchor's fiscal year, if the horizon reaches that far. */
  beyondYearEnd: string;
  baselineTotal: string | null;
  varianceToBaseline: string | null;
  variancePercent: number | null;
  /** In-sample fit of the model used. Not a measure of forward accuracy. */
  accuracy: AccuracyMetrics;
  warnings: string[];
}

/**
 * Build a rolling forecast anchored on the last closed period.
 */
export function buildRollingForecast(input: RollingForecastInput): RollingForecastResult {
  const { actuals, anchorPeriodKey, horizonPeriods } = input;
  const warnings: string[] = [];

  const anchor = parsePeriodKey(anchorPeriodKey);
  if (!anchor) {
    throw CalculationError(`'${anchorPeriodKey}' is not a valid period key.`, { anchorPeriodKey });
  }
  if (!Number.isInteger(horizonPeriods) || horizonPeriods < 1) {
    throw CalculationError(
      `Rolling horizon must be a positive whole number of periods, got ${horizonPeriods}.`,
    );
  }
  if (actuals.length === 0) {
    throw CalculationError(
      'A rolling forecast needs actuals up to the anchor period. Close a period before rolling.',
    );
  }

  // Everything strictly after the anchor is not yet closed and must not be
  // treated as actual, even if a partial figure has been imported.
  const ordered = [...actuals].sort((a, b) => a.periodKey.localeCompare(b.periodKey));
  const anchorPosition = ordered.findIndex((p) => p.periodKey === anchorPeriodKey);
  if (anchorPosition === -1) {
    throw CalculationError(
      `No actual was supplied for the anchor period ${anchorPeriodKey}. The anchor must be a closed period.`,
      { anchorPeriodKey },
    );
  }

  const closed = ordered.slice(0, anchorPosition + 1);
  const discarded = ordered.length - closed.length;
  if (discarded > 0) {
    warnings.push(
      `${discarded} period(s) after the anchor were supplied as actuals and have been ignored. Periods beyond ${anchorPeriodKey} are not closed, so they are forecast rather than reported.`,
    );
  }

  const periodsInYear = PERIODS_PER_YEAR[anchor.periodType];
  const remainingInYear = periodsInYear - anchor.periodIndex;

  if (horizonPeriods < remainingInYear) {
    warnings.push(
      `The horizon of ${horizonPeriods} period(s) stops short of the fiscal year end, which is ${remainingInYear} period(s) away. The full-year outturn assumes nothing is spent in the uncovered periods and will understate it.`,
    );
  }

  // Forecast forward from the closed series.
  const options = {
    horizon: horizonPeriods,
    seasonLength: input.seasonLength,
    confidenceLevel: input.confidenceLevel ?? 0.95,
  };

  const method = input.method ?? 'AUTO';
  const result =
    method === 'AUTO'
      ? autoForecast(closed, options)
      : forecast(closed, method as Exclude<ForecastMethod, 'DRIVER_BASED'>, options);

  warnings.push(...result.warnings);

  const futureKeys =
    result.periodKeys.length === horizonPeriods
      ? result.periodKeys
      : nextPeriodKeys(anchorPeriodKey, horizonPeriods);

  const baselineByKey = new Map(
    (input.baseline ?? []).map((b) => [b.periodKey, new Decimal(String(b.amount))]),
  );

  const withBaseline = (
    periodKey: string,
    value: Decimal,
  ): Pick<RollingPoint, 'baseline' | 'variance'> => {
    const baseline = baselineByKey.get(periodKey);
    if (!baseline) return { baseline: null, variance: null };
    return { baseline: toMoneyString(baseline), variance: toMoneyString(baseline.minus(value)) };
  };

  const points: RollingPoint[] = [
    ...closed.map((point) => {
      const value = new Decimal(point.value);
      return {
        periodKey: point.periodKey,
        basis: 'ACTUAL' as const,
        value: toMoneyString(value),
        lower: null,
        upper: null,
        ...withBaseline(point.periodKey, value),
      };
    }),
    ...futureKeys.map((periodKey, i) => {
      const value = new Decimal(result.point[i] ?? 0);
      return {
        periodKey,
        basis: 'FORECAST' as const,
        value: toMoneyString(value),
        lower: result.interval ? toMoneyString(result.interval.lower[i] ?? 0) : null,
        upper: result.interval ? toMoneyString(result.interval.upper[i] ?? 0) : null,
        ...withBaseline(periodKey, value),
      };
    }),
  ];

  // Split the forecast at the fiscal year boundary: the outturn question is
  // about this year, but the horizon may legitimately reach past it.
  const inAnchorYear = (periodKey: string): boolean => {
    const parsed = parsePeriodKey(periodKey);
    return parsed !== null && parsed.fiscalYear === anchor.fiscalYear;
  };

  const actualToDate = sumOf(
    points.filter((p) => p.basis === 'ACTUAL' && inAnchorYear(p.periodKey)),
  );
  const forecastRemainder = sumOf(
    points.filter((p) => p.basis === 'FORECAST' && inAnchorYear(p.periodKey)),
  );
  const beyondYearEnd = sumOf(
    points.filter((p) => p.basis === 'FORECAST' && !inAnchorYear(p.periodKey)),
  );

  const fullYearOutturn = actualToDate.plus(forecastRemainder);

  // The baseline comparison is only meaningful over the anchor's fiscal year.
  const baselineTotal =
    baselineByKey.size === 0
      ? null
      : [...baselineByKey.entries()]
          .filter(([key]) => inAnchorYear(key))
          .reduce((acc, [, amount]) => acc.plus(amount), new Decimal(0));

  const varianceToBaseline = baselineTotal === null ? null : baselineTotal.minus(fullYearOutturn);

  return {
    anchorPeriodKey,
    anchorPeriodIndex: anchor.periodIndex,
    fiscalYear: anchor.fiscalYear,
    periodType: anchor.periodType,
    horizonPeriods,
    method: result.method,
    points,
    actualToDate: toMoneyString(actualToDate),
    forecastRemainder: toMoneyString(forecastRemainder),
    fullYearOutturn: toMoneyString(fullYearOutturn),
    beyondYearEnd: toMoneyString(beyondYearEnd),
    baselineTotal: baselineTotal === null ? null : toMoneyString(baselineTotal),
    varianceToBaseline: varianceToBaseline === null ? null : toMoneyString(varianceToBaseline),
    variancePercent:
      baselineTotal === null || baselineTotal.isZero() || varianceToBaseline === null
        ? null
        : varianceToBaseline.dividedBy(baselineTotal.abs()).toNumber(),
    accuracy: result.accuracy,
    warnings: [...new Set(warnings)],
  };
}

function sumOf(points: readonly RollingPoint[]): Decimal {
  return points.length === 0 ? new Decimal(0) : add(...points.map((p) => p.value));
}

// --------------------------------------------------------------------------
// Scoring the generation being replaced
// --------------------------------------------------------------------------

export interface ForecastAccuracyReview {
  /** Periods where the superseded forecast can now be compared to an actual. */
  periodsCompared: number;
  metrics: AccuracyMetrics;
  /** Per-period detail, so a single bad month is visible rather than averaged away. */
  comparisons: Array<{
    periodKey: string;
    forecast: string;
    actual: string;
    error: string;
    errorPercent: number | null;
  }>;
  verdict: 'ACCURATE' | 'ACCEPTABLE' | 'POOR' | 'INSUFFICIENT_DATA';
  explanation: string;
}

/**
 * Score a superseded forecast against what actually happened.
 *
 * This closes the loop. A rolling forecast that is never scored will drift for
 * a year before anyone notices, and the drift is exactly the information needed
 * to decide whether to trust the next one.
 *
 * Only forecast points are scored: comparing a recorded actual against itself
 * would flatter the result to meaninglessness.
 */
export function assessForecastAccuracy(
  priorPoints: ReadonlyArray<{ periodKey: string; basis: PointBasis; value: string | number }>,
  actuals: readonly HistoricalPoint[],
  options: { accurateWithin?: number; acceptableWithin?: number } = {},
): ForecastAccuracyReview {
  const accurateWithin = options.accurateWithin ?? 0.05;
  const acceptableWithin = options.acceptableWithin ?? 0.15;

  const actualByKey = new Map(actuals.map((a) => [a.periodKey, a.value]));

  const comparisons: ForecastAccuracyReview['comparisons'] = [];
  const forecastValues: number[] = [];
  const actualValues: number[] = [];

  for (const point of priorPoints) {
    if (point.basis !== 'FORECAST') continue;
    const actual = actualByKey.get(point.periodKey);
    if (actual === undefined) continue;

    const forecastValue = Number(point.value);
    const error = actual - forecastValue;

    forecastValues.push(forecastValue);
    actualValues.push(actual);
    comparisons.push({
      periodKey: point.periodKey,
      forecast: toMoneyString(forecastValue),
      actual: toMoneyString(actual),
      error: toMoneyString(error),
      errorPercent: actual === 0 ? null : error / Math.abs(actual),
    });
  }

  const metrics = accuracyMetrics(actualValues, forecastValues);

  if (comparisons.length === 0) {
    return {
      periodsCompared: 0,
      metrics,
      comparisons,
      verdict: 'INSUFFICIENT_DATA',
      explanation:
        'No period of the superseded forecast has closed yet, so it cannot be scored. This is expected on the first roll.',
    };
  }

  // sMAPE rather than MAPE: it stays defined when a period lands on zero, which
  // happens often enough on individual account lines to matter.
  const error = metrics.smape;
  const verdict =
    error <= accurateWithin ? 'ACCURATE' : error <= acceptableWithin ? 'ACCEPTABLE' : 'POOR';

  const biasNote =
    metrics.biasPercent === null
      ? ''
      : metrics.biasPercent > 0.02
        ? ' It ran consistently below outturn, so it was optimistic.'
        : metrics.biasPercent < -0.02
          ? ' It ran consistently above outturn, so it was conservative.'
          : ' It showed no consistent directional bias.';

  return {
    periodsCompared: comparisons.length,
    metrics,
    comparisons,
    verdict,
    explanation:
      `The superseded forecast was out by ${(error * 100).toFixed(1)}% on average across ${comparisons.length} closed period(s).` +
      biasNote,
  };
}

// --------------------------------------------------------------------------
// Multi-year horizons
// --------------------------------------------------------------------------

export interface MultiYearSummary {
  fiscalYear: number;
  periodCount: number;
  actual: string;
  forecast: string;
  total: string;
  baseline: string | null;
  variance: string | null;
  /** Growth on the previous year of the horizon. Null for the first year. */
  growthOnPriorYear: number | null;
}

/**
 * Collapse a period-level series into fiscal years.
 *
 * A medium-term plan is read a year at a time; nobody reviews 60 monthly numbers.
 * Year-on-year growth is included because it is the first thing anyone checks and
 * the first thing anyone gets wrong computing by hand.
 */
export function summariseByFiscalYear(
  points: readonly RollingPoint[],
  baseline: readonly BaselinePoint[] = [],
): MultiYearSummary[] {
  const baselineByKey = new Map(baseline.map((b) => [b.periodKey, new Decimal(String(b.amount))]));

  const byYear = new Map<
    number,
    {
      periodCount: number;
      actual: Decimal;
      forecast: Decimal;
      baseline: Decimal;
      hasBaseline: boolean;
    }
  >();

  for (const point of points) {
    const parsed = parsePeriodKey(point.periodKey);
    if (!parsed) continue;

    const entry = byYear.get(parsed.fiscalYear) ?? {
      periodCount: 0,
      actual: new Decimal(0),
      forecast: new Decimal(0),
      baseline: new Decimal(0),
      hasBaseline: false,
    };

    const value = new Decimal(point.value);
    entry.periodCount += 1;
    if (point.basis === 'ACTUAL') entry.actual = entry.actual.plus(value);
    else entry.forecast = entry.forecast.plus(value);

    const baselineValue = baselineByKey.get(point.periodKey);
    if (baselineValue) {
      entry.baseline = entry.baseline.plus(baselineValue);
      entry.hasBaseline = true;
    }

    byYear.set(parsed.fiscalYear, entry);
  }

  const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]);

  return years.map(([fiscalYear, entry], index) => {
    const total = entry.actual.plus(entry.forecast);
    const priorTotal = index === 0 ? null : (years[index - 1] as [number, typeof entry])[1];
    const prior = priorTotal === null ? null : priorTotal.actual.plus(priorTotal.forecast);

    return {
      fiscalYear,
      periodCount: entry.periodCount,
      actual: toMoneyString(entry.actual),
      forecast: toMoneyString(entry.forecast),
      total: toMoneyString(total),
      baseline: entry.hasBaseline ? toMoneyString(entry.baseline) : null,
      variance: entry.hasBaseline ? toMoneyString(entry.baseline.minus(total)) : null,
      growthOnPriorYear:
        prior === null || prior.isZero()
          ? null
          : total.minus(prior).dividedBy(prior.abs()).toNumber(),
    };
  });
}

/** Every period key a multi-year cycle covers, in order. */
export function multiYearPeriodKeys(
  startFiscalYear: number,
  yearCount: number,
  periodType: PeriodType = 'MONTH',
): string[] {
  if (!Number.isInteger(yearCount) || yearCount < 1) {
    throw CalculationError(`Year count must be a positive whole number, got ${yearCount}.`);
  }
  const perYear = PERIODS_PER_YEAR[periodType];
  const keys: string[] = [];
  for (let year = 0; year < yearCount; year += 1) {
    for (let index = 1; index <= perYear; index += 1) {
      keys.push(makePeriodKey(startFiscalYear + year, index, periodType));
    }
  }
  return keys;
}
