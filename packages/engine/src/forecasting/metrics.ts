/**
 * Forecast accuracy measurement.
 *
 * The house metric is MASE. MAPE is reported because finance teams ask for it,
 * but it is undefined at zero actuals and asymmetrically punishes over-forecasts,
 * so it must never be the thing a method is selected on.
 */
import { mean } from '../stats.js';
import type { AccuracyMetrics } from './types.js';

const EMPTY: AccuracyMetrics = {
  mae: 0,
  rmse: 0,
  mape: null,
  smape: 0,
  mase: null,
  bias: 0,
  biasPercent: null,
  rSquared: null,
  n: 0,
};

export interface MetricOptions {
  /**
   * Training series used to scale MASE. Supply the in-sample history; the
   * denominator is the MAE of a (seasonal) naive forecast on it.
   */
  trainingSeries?: readonly number[];
  /** Seasonal period for the MASE denominator. 1 = plain naive. */
  seasonLength?: number;
}

/**
 * Compare actuals against predictions. Pairs where either side is null or
 * non-finite are dropped, so in-sample fits with an unfitted head still work.
 */
export function accuracyMetrics(
  actuals: readonly (number | null)[],
  predictions: readonly (number | null)[],
  options: MetricOptions = {},
): AccuracyMetrics {
  const pairs: Array<[number, number]> = [];
  const length = Math.min(actuals.length, predictions.length);
  for (let i = 0; i < length; i += 1) {
    const a = actuals[i];
    const p = predictions[i];
    if (a == null || p == null) continue;
    if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
    pairs.push([a, p]);
  }
  if (pairs.length === 0) return { ...EMPTY };

  const n = pairs.length;
  let absErr = 0;
  let sqErr = 0;
  let signedErr = 0;
  let pctErrSum = 0;
  let pctErrCount = 0;
  let smapeSum = 0;
  let smapeCount = 0;

  for (const [actual, predicted] of pairs) {
    const err = actual - predicted;
    absErr += Math.abs(err);
    sqErr += err * err;
    signedErr += err;

    if (actual !== 0) {
      pctErrSum += Math.abs(err / actual);
      pctErrCount += 1;
    }

    const denom = (Math.abs(actual) + Math.abs(predicted)) / 2;
    if (denom !== 0) {
      smapeSum += Math.abs(err) / denom;
      smapeCount += 1;
    }
  }

  const actualValues = pairs.map(([a]) => a);
  const meanActual = mean(actualValues);

  let ssTot = 0;
  for (const a of actualValues) ssTot += (a - meanActual) ** 2;

  return {
    mae: absErr / n,
    rmse: Math.sqrt(sqErr / n),
    // MAPE is only meaningful when every actual contributed.
    mape: pctErrCount === n ? pctErrSum / n : null,
    smape: smapeCount === 0 ? 0 : smapeSum / smapeCount,
    mase: scaleForMase(options, absErr / n),
    bias: signedErr / n,
    biasPercent: meanActual === 0 ? null : signedErr / n / Math.abs(meanActual),
    rSquared: ssTot === 0 ? null : 1 - sqErr / ssTot,
    n,
  };
}

function scaleForMase(options: MetricOptions, mae: number): number | null {
  const { trainingSeries, seasonLength = 1 } = options;
  if (!trainingSeries || trainingSeries.length <= seasonLength) return null;
  const scale = naiveMae(trainingSeries, seasonLength);
  if (scale === null || scale === 0) return null;
  return mae / scale;
}

/**
 * MAE of an in-sample (seasonal) naive forecast - the MASE denominator.
 * Returns null when the series is too short to form a single naive comparison.
 */
export function naiveMae(series: readonly number[], seasonLength = 1): number | null {
  const m = Math.max(1, Math.trunc(seasonLength));
  if (series.length <= m) return null;
  let total = 0;
  let count = 0;
  for (let i = m; i < series.length; i += 1) {
    const current = series[i] as number;
    const lag = series[i - m] as number;
    if (!Number.isFinite(current) || !Number.isFinite(lag)) continue;
    total += Math.abs(current - lag);
    count += 1;
  }
  if (count === 0) return null;
  return total / count;
}

/** Sum of squared one-step-ahead errors - the objective for parameter fitting. */
export function sumSquaredError(
  actuals: readonly number[],
  fitted: readonly (number | null)[],
): number {
  let total = 0;
  const length = Math.min(actuals.length, fitted.length);
  for (let i = 0; i < length; i += 1) {
    const f = fitted[i];
    const a = actuals[i];
    if (f == null || a == null || !Number.isFinite(f)) continue;
    total += (a - f) ** 2;
  }
  return total;
}

/** Residual standard deviation, used to width prediction intervals. */
export function residualStdDev(residuals: readonly number[], parametersEstimated = 0): number {
  const usable = residuals.filter((r) => Number.isFinite(r));
  const df = usable.length - parametersEstimated;
  if (df <= 0) return 0;
  let ss = 0;
  for (const r of usable) ss += r * r;
  return Math.sqrt(ss / df);
}

/**
 * Merge fold-level metrics into one figure. MAE/bias average directly; RMSE is
 * pooled through its squares so the combined value stays a genuine RMSE.
 */
export function combineMetrics(folds: readonly AccuracyMetrics[]): AccuracyMetrics {
  const usable = folds.filter((f) => f.n > 0);
  if (usable.length === 0) return { ...EMPTY };

  const totalN = usable.reduce((acc, f) => acc + f.n, 0);
  const weighted = (pick: (f: AccuracyMetrics) => number) =>
    usable.reduce((acc, f) => acc + pick(f) * f.n, 0) / totalN;

  const definedMape = usable.filter((f) => f.mape !== null);
  const definedMase = usable.filter((f) => f.mase !== null);
  const definedR2 = usable.filter((f) => f.rSquared !== null);
  const definedBiasPct = usable.filter((f) => f.biasPercent !== null);

  return {
    mae: weighted((f) => f.mae),
    rmse: Math.sqrt(usable.reduce((acc, f) => acc + f.rmse ** 2 * f.n, 0) / totalN),
    mape:
      definedMape.length === usable.length
        ? definedMape.reduce((acc, f) => acc + (f.mape as number) * f.n, 0) / totalN
        : null,
    smape: weighted((f) => f.smape),
    mase:
      definedMase.length > 0
        ? definedMase.reduce((acc, f) => acc + (f.mase as number) * f.n, 0) /
          definedMase.reduce((acc, f) => acc + f.n, 0)
        : null,
    bias: weighted((f) => f.bias),
    biasPercent:
      definedBiasPct.length > 0
        ? definedBiasPct.reduce((acc, f) => acc + (f.biasPercent as number) * f.n, 0) /
          definedBiasPct.reduce((acc, f) => acc + f.n, 0)
        : null,
    rSquared:
      definedR2.length > 0
        ? definedR2.reduce((acc, f) => acc + (f.rSquared as number) * f.n, 0) /
          definedR2.reduce((acc, f) => acc + f.n, 0)
        : null,
    n: totalN,
  };
}
