/**
 * Forecast orchestration: run a named method, or let the engine pick one.
 *
 * Automatic selection is done by rolling-origin backtesting, not by in-sample
 * fit. Choosing on in-sample fit always favours the most flexible model, which
 * is exactly how a budget ends up anchored to an over-fitted trend.
 */
import {
  InsufficientDataError,
  PERIODS_PER_YEAR,
  parsePeriodKey,
  periodKey as buildPeriodKey,
  type ForecastMethod,
} from '@ffp/shared';
import { normalQuantile } from '../stats.js';
import { accuracyMetrics, combineMetrics, residualStdDev } from './metrics.js';
import {
  holtLinear,
  holtWintersAdditive,
  holtWintersMultiplicative,
  linearTrend,
  movingAverage,
  naive,
  runRate,
  seasonalNaive,
  simpleExponentialSmoothing,
  weightedMovingAverage,
  type MethodOutput,
} from './methods.js';
import type {
  AutoForecastResult,
  BacktestScore,
  ForecastOptions,
  ForecastResult,
  HistoricalPoint,
} from './types.js';

/** Methods that operate purely on the history series. DRIVER_BASED lives elsewhere. */
export const TIME_SERIES_METHODS: ForecastMethod[] = [
  'NAIVE',
  'SEASONAL_NAIVE',
  'MOVING_AVERAGE',
  'WEIGHTED_MOVING_AVERAGE',
  'SIMPLE_EXPONENTIAL_SMOOTHING',
  'HOLT_LINEAR',
  'HOLT_WINTERS_ADDITIVE',
  'HOLT_WINTERS_MULTIPLICATIVE',
  'LINEAR_REGRESSION',
  'RUN_RATE',
];

function runMethod(
  method: ForecastMethod,
  series: readonly number[],
  options: ForecastOptions,
): MethodOutput {
  const { horizon, seasonLength, alpha, beta, gamma, phi, window } = options;
  const m = seasonLength ?? 12;
  const w = window ?? Math.min(3, Math.max(2, Math.floor(series.length / 2)));

  switch (method) {
    case 'NAIVE':
      return naive(series, horizon);
    case 'SEASONAL_NAIVE':
      return seasonalNaive(series, horizon, m);
    case 'MOVING_AVERAGE':
      return movingAverage(series, horizon, w);
    case 'WEIGHTED_MOVING_AVERAGE':
      return weightedMovingAverage(series, horizon, w);
    case 'SIMPLE_EXPONENTIAL_SMOOTHING':
      return simpleExponentialSmoothing(series, horizon, alpha);
    case 'HOLT_LINEAR':
      return holtLinear(series, horizon, alpha, beta, phi ?? 1);
    case 'HOLT_WINTERS_ADDITIVE':
      return holtWintersAdditive(series, horizon, m, alpha, beta, gamma);
    case 'HOLT_WINTERS_MULTIPLICATIVE':
      return holtWintersMultiplicative(series, horizon, m, alpha, beta, gamma);
    case 'LINEAR_REGRESSION':
      return linearTrend(series, horizon);
    case 'RUN_RATE':
      return runRate(series, horizon);
    case 'DRIVER_BASED':
      throw InsufficientDataError(
        'DRIVER_BASED is not a time-series method. Use buildDriverForecast() with driver volumes and rates.',
      );
    default: {
      const exhaustive: never = method;
      throw InsufficientDataError(`Unsupported forecast method: ${String(exhaustive)}`);
    }
  }
}

/** Run one named method end to end, including interval and diagnostics. */
export function forecast(
  history: readonly HistoricalPoint[],
  method: Exclude<ForecastMethod, 'DRIVER_BASED'>,
  options: ForecastOptions,
): ForecastResult {
  const series = history.map((p) => p.value);
  validateSeries(series);

  const warnings: string[] = [];
  const seasonLength = options.seasonLength;
  if (seasonLength && series.length < seasonLength * 2) {
    warnings.push(
      `History covers ${series.length} periods, fewer than two full seasons of ${seasonLength}. Seasonal estimates will be unstable.`,
    );
  }
  if (series.length < 12) {
    warnings.push(
      `Only ${series.length} historical periods supplied. Treat the interval as indicative rather than statistical.`,
    );
  }

  const output = runMethod(method, series, options);
  return assembleResult(method, history, series, output, options, warnings);
}

function assembleResult(
  method: ForecastMethod,
  history: readonly HistoricalPoint[],
  series: readonly number[],
  output: MethodOutput,
  options: ForecastOptions,
  warnings: string[],
): ForecastResult {
  const residuals: number[] = [];
  output.fitted.forEach((f, i) => {
    if (f == null) return;
    const actual = series[i];
    if (actual == null) return;
    residuals.push(actual - f);
  });

  const sigma = residualStdDev(residuals, output.paramCount);
  const level = options.confidenceLevel ?? 0.95;
  const z = normalQuantile(1 - (1 - level) / 2);

  const interval =
    sigma > 0 && residuals.length >= 3
      ? {
          level,
          lower: output.point.map((v, i) => v - z * sigma * output.varianceMultiplier(i + 1)),
          upper: output.point.map((v, i) => v + z * sigma * output.varianceMultiplier(i + 1)),
        }
      : null;

  if (!interval) {
    warnings.push(
      'Not enough residual variation to form a prediction interval. Point forecast only.',
    );
  }

  const lastKey = history[history.length - 1]?.periodKey;
  const periodKeys =
    options.futurePeriodKeys ?? (lastKey ? nextPeriodKeys(lastKey, output.point.length) : []) ?? [];

  return {
    method,
    point: output.point,
    periodKeys,
    fitted: output.fitted,
    residuals,
    interval,
    parameters: output.parameters,
    accuracy: accuracyMetrics(series, output.fitted, {
      trainingSeries: series,
      seasonLength: options.seasonLength ?? 1,
    }),
    warnings,
  };
}

function validateSeries(series: readonly number[]): void {
  if (series.length < 2) {
    throw InsufficientDataError('Forecasting requires at least two historical observations.');
  }
  if (series.some((v) => !Number.isFinite(v))) {
    throw InsufficientDataError('History contains non-numeric or infinite values.');
  }
}

// --------------------------------------------------------------------------
// Period key projection
// --------------------------------------------------------------------------

/** Continue the period axis forward from `lastKey`. */
export function nextPeriodKeys(lastKey: string, count: number): string[] {
  const parsed = parsePeriodKey(lastKey);
  if (!parsed) return [];
  const perYear = PERIODS_PER_YEAR[parsed.periodType];
  const out: string[] = [];
  let { fiscalYear, periodIndex } = parsed;
  for (let i = 0; i < count; i += 1) {
    periodIndex += 1;
    if (periodIndex > perYear) {
      periodIndex = 1;
      fiscalYear += 1;
    }
    out.push(buildPeriodKey(fiscalYear, periodIndex, parsed.periodType));
  }
  return out;
}

// --------------------------------------------------------------------------
// Backtesting and automatic selection
// --------------------------------------------------------------------------

export interface BacktestOptions extends Omit<ForecastOptions, 'horizon'> {
  /** Periods forecast per fold. Match it to the horizon you actually care about. */
  foldHorizon?: number;
  /** Number of rolling origins. More folds, more reliable ranking, more compute. */
  folds?: number;
  /** Minimum training length before the first origin. */
  minTrainSize?: number;
}

/**
 * Rolling-origin cross-validation.
 *
 * Train on a prefix, forecast the next `foldHorizon` periods, score against what
 * actually happened, then roll the origin forward. This is the honest way to ask
 * "how well would this method have done?".
 */
export function backtest(
  history: readonly HistoricalPoint[],
  method: Exclude<ForecastMethod, 'DRIVER_BASED'>,
  options: BacktestOptions = {},
): BacktestScore {
  const series = history.map((p) => p.value);
  const foldHorizon = options.foldHorizon ?? 1;
  const seasonLength = options.seasonLength;

  const minTrain =
    options.minTrainSize ??
    Math.max(seasonLength ? seasonLength * 2 : 4, Math.ceil(series.length * 0.5));
  const maxFolds = Math.floor((series.length - minTrain) / foldHorizon);
  const folds = Math.max(0, Math.min(options.folds ?? maxFolds, maxFolds));

  if (folds < 1) {
    return {
      method,
      parameters: {},
      accuracy: accuracyMetrics([], []),
      score: Infinity,
      foldCount: 0,
      error: 'Insufficient history for a rolling-origin backtest.',
    };
  }

  const foldMetrics = [];
  let lastParameters: Record<string, number> = {};

  for (let f = 0; f < folds; f += 1) {
    const trainEnd = minTrain + f * foldHorizon;
    const train = series.slice(0, trainEnd);
    const actual = series.slice(trainEnd, trainEnd + foldHorizon);
    if (actual.length === 0) break;

    try {
      const output = runMethod(method, train, { ...options, horizon: actual.length });
      lastParameters = output.parameters;
      foldMetrics.push(
        accuracyMetrics(actual, output.point, {
          trainingSeries: train,
          seasonLength: seasonLength ?? 1,
        }),
      );
    } catch (error) {
      // A method that cannot run on a shorter prefix simply forfeits that fold.
      if (f === folds - 1 && foldMetrics.length === 0) {
        return {
          method,
          parameters: {},
          accuracy: accuracyMetrics([], []),
          score: Infinity,
          foldCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  if (foldMetrics.length === 0) {
    return {
      method,
      parameters: lastParameters,
      accuracy: accuracyMetrics([], []),
      score: Infinity,
      foldCount: 0,
      error: 'No fold produced a usable forecast.',
    };
  }

  const accuracy = combineMetrics(foldMetrics);
  return {
    method,
    parameters: lastParameters,
    accuracy,
    score: accuracy.mase ?? accuracy.rmse,
    foldCount: foldMetrics.length,
  };
}

/**
 * Evaluate every applicable method and forecast with the winner.
 *
 * The full candidate table is returned alongside the result. A reviewer asking
 * "why this method?" gets an answer with numbers attached, which is the whole
 * point of putting model selection inside a governed platform.
 */
export function autoForecast(
  history: readonly HistoricalPoint[],
  options: ForecastOptions,
): AutoForecastResult {
  const series = history.map((p) => p.value);
  validateSeries(series);

  const seasonLength = options.seasonLength;
  const applicable = TIME_SERIES_METHODS.filter((method) => {
    if (!seasonLength && (method === 'SEASONAL_NAIVE' || method.startsWith('HOLT_WINTERS'))) {
      return false;
    }
    if (method === 'HOLT_WINTERS_MULTIPLICATIVE' && series.some((v) => v <= 0)) return false;
    if (seasonLength && method.startsWith('HOLT_WINTERS') && series.length < seasonLength * 2 + 2) {
      return false;
    }
    return true;
  });

  const foldHorizon = Math.min(options.horizon, Math.max(1, Math.floor(series.length / 4)));
  const candidates = applicable
    .map((method) =>
      backtest(history, method as Exclude<ForecastMethod, 'DRIVER_BASED'>, {
        ...options,
        foldHorizon,
      }),
    )
    .sort((a, b) => a.score - b.score);

  const viable = candidates.filter((c) => Number.isFinite(c.score) && c.foldCount > 0);
  const winner = viable[0];

  if (!winner) {
    // Every candidate failed the backtest - fall back to the benchmark rather
    // than returning nothing, and say so loudly in the warnings.
    const fallback = forecast(history, 'NAIVE', options);
    return {
      ...fallback,
      warnings: [
        ...fallback.warnings,
        'No method could be backtested against this history; fell back to the naive benchmark.',
      ],
      candidates,
      selectionCriterion: 'RMSE',
    };
  }

  const result = forecast(
    history,
    winner.method as Exclude<ForecastMethod, 'DRIVER_BASED'>,
    options,
  );
  const criterion = winner.accuracy.mase !== null ? 'MASE' : 'RMSE';

  return {
    ...result,
    warnings: [
      ...result.warnings,
      `Selected ${winner.method} by rolling-origin backtest (${criterion} ${winner.score.toFixed(3)} over ${winner.foldCount} folds).`,
    ],
    candidates,
    selectionCriterion: criterion,
  };
}
