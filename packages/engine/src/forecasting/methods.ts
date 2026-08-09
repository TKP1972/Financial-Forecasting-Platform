/**
 * Time-series forecasting methods.
 *
 * Every method produces the same shape: in-sample one-step-ahead `fitted` values
 * (so accuracy is measurable), `point` forecasts over the horizon, the parameters
 * actually used, and a variance multiplier describing how uncertainty grows with
 * horizon. Uniformity is what lets `autoForecast` compare them fairly.
 *
 * Smoothing parameters left undefined are fitted by grid search against in-sample
 * SSE - coarse pass then local refinement, which is both fast and reproducible.
 */
import { InsufficientDataError } from '@ffp/shared';
import { linearRegression, mean } from '../stats.js';
import { sumSquaredError } from './metrics.js';

export interface MethodOutput {
  fitted: (number | null)[];
  point: number[];
  parameters: Record<string, number>;
  /** Free parameters estimated, used for residual degrees of freedom. */
  paramCount: number;
  /**
   * Multiplier on the residual standard deviation at horizon step `h` (1-based).
   * Encodes how fast the method's uncertainty fans out.
   */
  varianceMultiplier: (h: number) => number;
}

function requireHistory(series: readonly number[], minimum: number, method: string): void {
  if (series.length < minimum) {
    throw InsufficientDataError(
      `${method} needs at least ${minimum} historical periods, received ${series.length}.`,
      { required: minimum, received: series.length, method },
    );
  }
}

const FLAT = () => 1;

// --------------------------------------------------------------------------
// Benchmark methods
// --------------------------------------------------------------------------

/** Last observed value carried forward. The benchmark every method must beat. */
export function naive(series: readonly number[], horizon: number): MethodOutput {
  requireHistory(series, 2, 'Naive');
  const last = series[series.length - 1] as number;
  const fitted: (number | null)[] = [null, ...series.slice(0, -1)];
  return {
    fitted,
    point: new Array(horizon).fill(last),
    parameters: {},
    paramCount: 0,
    // A random walk's forecast variance grows linearly, so the sd grows as sqrt(h).
    varianceMultiplier: (h) => Math.sqrt(h),
  };
}

/** Same period last season. The right benchmark for anything with seasonality. */
export function seasonalNaive(
  series: readonly number[],
  horizon: number,
  seasonLength: number,
): MethodOutput {
  const m = Math.trunc(seasonLength);
  if (m < 2) throw InsufficientDataError('Seasonal naive requires a season length of at least 2.');
  requireHistory(series, m + 1, 'Seasonal naive');

  const fitted: (number | null)[] = series.map((_, t) =>
    t < m ? null : (series[t - m] as number),
  );
  const n = series.length;
  const point = Array.from({ length: horizon }, (_, i) => series[n - m + (i % m)] as number);

  return {
    fitted,
    point,
    parameters: { seasonLength: m },
    paramCount: 0,
    varianceMultiplier: (h) => Math.sqrt(Math.floor((h - 1) / m) + 1),
  };
}

/**
 * Projects the average pace observed so far.
 * This is the "full-year projection from year-to-date actuals" calculation that
 * budget holders reach for mid-cycle.
 */
export function runRate(series: readonly number[], horizon: number): MethodOutput {
  requireHistory(series, 1, 'Run rate');
  const average = mean(series);
  const fitted: (number | null)[] = series.map((_, t) =>
    t === 0 ? null : mean(series.slice(0, t)),
  );
  return {
    fitted,
    point: new Array(horizon).fill(average),
    parameters: { periodsObserved: series.length },
    paramCount: 1,
    varianceMultiplier: FLAT,
  };
}

// --------------------------------------------------------------------------
// Averaging methods
// --------------------------------------------------------------------------

export function movingAverage(
  series: readonly number[],
  horizon: number,
  window: number,
): MethodOutput {
  const w = Math.trunc(window);
  if (w < 2) throw InsufficientDataError('Moving average requires a window of at least 2.');
  requireHistory(series, w + 1, 'Moving average');

  const fitted: (number | null)[] = series.map((_, t) =>
    t < w ? null : mean(series.slice(t - w, t)),
  );
  const level = mean(series.slice(-w));

  return {
    fitted,
    point: new Array(horizon).fill(level),
    parameters: { window: w },
    paramCount: 1,
    varianceMultiplier: FLAT,
  };
}

/** Linearly increasing weights, so recent periods dominate. */
export function weightedMovingAverage(
  series: readonly number[],
  horizon: number,
  window: number,
): MethodOutput {
  const w = Math.trunc(window);
  if (w < 2)
    throw InsufficientDataError('Weighted moving average requires a window of at least 2.');
  requireHistory(series, w + 1, 'Weighted moving average');

  const weights = Array.from({ length: w }, (_, i) => i + 1);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const weightedMean = (slice: readonly number[]) =>
    slice.reduce((acc, v, i) => acc + v * (weights[i] as number), 0) / weightTotal;

  const fitted: (number | null)[] = series.map((_, t) =>
    t < w ? null : weightedMean(series.slice(t - w, t)),
  );
  const level = weightedMean(series.slice(-w));

  return {
    fitted,
    point: new Array(horizon).fill(level),
    parameters: { window: w },
    paramCount: 1,
    varianceMultiplier: FLAT,
  };
}

// --------------------------------------------------------------------------
// Exponential smoothing family
// --------------------------------------------------------------------------

export function simpleExponentialSmoothing(
  series: readonly number[],
  horizon: number,
  alpha?: number,
): MethodOutput {
  requireHistory(series, 3, 'Simple exponential smoothing');
  const a = alpha ?? fitSingleParameter((candidate) => sesFitted(series, candidate), series);

  const fitted = sesFitted(series, a);
  const level = sesLevel(series, a);

  return {
    fitted,
    point: new Array(horizon).fill(level),
    parameters: { alpha: round4(a) },
    paramCount: 1,
    // Standard ETS(A,N,N) variance expansion.
    varianceMultiplier: (h) => Math.sqrt(1 + (h - 1) * a * a),
  };
}

function sesFitted(series: readonly number[], alpha: number): (number | null)[] {
  const out: (number | null)[] = [null];
  let level = series[0] as number;
  for (let t = 1; t < series.length; t += 1) {
    out.push(level);
    level = alpha * (series[t] as number) + (1 - alpha) * level;
  }
  return out;
}

function sesLevel(series: readonly number[], alpha: number): number {
  let level = series[0] as number;
  for (let t = 1; t < series.length; t += 1) {
    level = alpha * (series[t] as number) + (1 - alpha) * level;
  }
  return level;
}

/**
 * Holt's linear trend, optionally damped.
 *
 * Damping (`phi` < 1) flattens the trend as the horizon lengthens. For budget
 * work that matters: an undamped trend extrapolated 36 months out produces
 * numbers nobody will sign off on.
 */
export function holtLinear(
  series: readonly number[],
  horizon: number,
  alpha?: number,
  beta?: number,
  phi = 1,
): MethodOutput {
  requireHistory(series, 4, "Holt's linear trend");

  let a = alpha;
  let b = beta;
  if (a === undefined || b === undefined) {
    const fittedParams = fitTwoParameters(
      (ca, cb) => holtState(series, ca, cb, phi).fitted,
      series,
    );
    a = a ?? fittedParams.alpha;
    b = b ?? fittedParams.beta;
  }

  const state = holtState(series, a, b, phi);
  const dampSum = (h: number) => {
    if (phi >= 1) return h;
    // Geometric series phi + phi^2 + ... + phi^h
    return (phi * (1 - Math.pow(phi, h))) / (1 - phi);
  };
  const point = Array.from(
    { length: horizon },
    (_, i) => state.level + dampSum(i + 1) * state.trend,
  );

  const alphaFinal = a;
  const betaFinal = b;

  return {
    fitted: state.fitted,
    point,
    parameters: { alpha: round4(alphaFinal), beta: round4(betaFinal), phi: round4(phi) },
    paramCount: 2,
    varianceMultiplier: (h) => {
      // ETS(A,A,N) forecast variance: 1 + sum_{j=1}^{h-1} (alpha (1 + j beta))^2
      let total = 1;
      for (let j = 1; j < h; j += 1) total += (alphaFinal * (1 + j * betaFinal)) ** 2;
      return Math.sqrt(total);
    },
  };
}

function holtState(
  series: readonly number[],
  alpha: number,
  beta: number,
  phi: number,
): { fitted: (number | null)[]; level: number; trend: number } {
  let level = series[0] as number;
  let trend = (series[1] as number) - (series[0] as number);
  const fitted: (number | null)[] = [null, null];

  for (let t = 2; t < series.length; t += 1) {
    const forecast = level + phi * trend;
    fitted.push(forecast);
    const prevLevel = level;
    level = alpha * (series[t] as number) + (1 - alpha) * forecast;
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }

  return { fitted, level, trend };
}

/**
 * Holt-Winters with additive seasonality: seasonal swings of roughly constant
 * magnitude regardless of level. The right choice for most cost lines.
 */
export function holtWintersAdditive(
  series: readonly number[],
  horizon: number,
  seasonLength: number,
  alpha?: number,
  beta?: number,
  gamma?: number,
): MethodOutput {
  return holtWinters(series, horizon, seasonLength, 'ADDITIVE', alpha, beta, gamma);
}

/**
 * Holt-Winters with multiplicative seasonality: swings that scale with the level,
 * which is how revenue usually behaves. Requires strictly positive history.
 */
export function holtWintersMultiplicative(
  series: readonly number[],
  horizon: number,
  seasonLength: number,
  alpha?: number,
  beta?: number,
  gamma?: number,
): MethodOutput {
  if (series.some((v) => v <= 0)) {
    throw InsufficientDataError(
      'Multiplicative seasonality requires strictly positive history. Use the additive variant for series containing zero or negative values.',
    );
  }
  return holtWinters(series, horizon, seasonLength, 'MULTIPLICATIVE', alpha, beta, gamma);
}

type Seasonality = 'ADDITIVE' | 'MULTIPLICATIVE';

function holtWinters(
  series: readonly number[],
  horizon: number,
  seasonLength: number,
  seasonality: Seasonality,
  alpha?: number,
  beta?: number,
  gamma?: number,
): MethodOutput {
  const m = Math.trunc(seasonLength);
  if (m < 2) throw InsufficientDataError('Holt-Winters requires a season length of at least 2.');
  requireHistory(series, m * 2, 'Holt-Winters');

  let a = alpha;
  let b = beta;
  let g = gamma;
  if (a === undefined || b === undefined || g === undefined) {
    const fittedParams = fitThreeParameters(
      (ca, cb, cg) => hwState(series, m, seasonality, ca, cb, cg).fitted,
      series,
    );
    a = a ?? fittedParams.alpha;
    b = b ?? fittedParams.beta;
    g = g ?? fittedParams.gamma;
  }

  const state = hwState(series, m, seasonality, a, b, g);
  const n = series.length;
  const point = Array.from({ length: horizon }, (_, i) => {
    const h = i + 1;
    const seasonal = state.seasonal[n - m + ((h - 1) % m)] as number;
    const trended = state.level + h * state.trend;
    return seasonality === 'ADDITIVE' ? trended + seasonal : trended * seasonal;
  });

  const alphaFinal = a;
  const betaFinal = b;

  return {
    fitted: state.fitted,
    point,
    parameters: {
      alpha: round4(alphaFinal),
      beta: round4(betaFinal),
      gamma: round4(g),
      seasonLength: m,
    },
    paramCount: 3,
    varianceMultiplier: (h) => {
      let total = 1;
      for (let j = 1; j < h; j += 1) total += (alphaFinal * (1 + j * betaFinal)) ** 2;
      return Math.sqrt(total);
    },
  };
}

function hwState(
  series: readonly number[],
  m: number,
  seasonality: Seasonality,
  alpha: number,
  beta: number,
  gamma: number,
): { fitted: (number | null)[]; level: number; trend: number; seasonal: number[] } {
  const firstSeason = series.slice(0, m);
  const secondSeason = series.slice(m, m * 2);
  let level = mean(firstSeason);
  let trend = (mean(secondSeason) - level) / m;

  // Seed one full season of indices from the first season's deviation from level.
  const seasonal: number[] = firstSeason.map((v) =>
    seasonality === 'ADDITIVE' ? v - level : level === 0 ? 1 : v / level,
  );

  const fitted: (number | null)[] = new Array(m).fill(null);

  for (let t = m; t < series.length; t += 1) {
    const s = seasonal[t - m] as number;
    const trended = level + trend;
    const forecast = seasonality === 'ADDITIVE' ? trended + s : trended * s;
    fitted.push(forecast);

    const y = series[t] as number;
    const prevLevel = level;
    const deseasonalised = seasonality === 'ADDITIVE' ? y - s : s === 0 ? y : y / s;
    level = alpha * deseasonalised + (1 - alpha) * trended;
    trend = beta * (level - prevLevel) + (1 - beta) * trend;

    const newSeasonal =
      seasonality === 'ADDITIVE'
        ? gamma * (y - level) + (1 - gamma) * s
        : gamma * (level === 0 ? s : y / level) + (1 - gamma) * s;
    seasonal.push(newSeasonal);
  }

  return { fitted, level, trend, seasonal };
}

// --------------------------------------------------------------------------
// Regression
// --------------------------------------------------------------------------

/** OLS trend on the period index. Gives a genuine statistical prediction interval. */
export function linearTrend(series: readonly number[], horizon: number): MethodOutput {
  requireHistory(series, 3, 'Linear regression');
  const xs = series.map((_, i) => i);
  const fit = linearRegression(xs, series);

  const fitted: (number | null)[] = xs.map((x) => fit.intercept + fit.slope * x);
  const n = series.length;
  const point = Array.from(
    { length: horizon },
    (_, i) => fit.intercept + fit.slope * (n - 1 + i + 1),
  );

  return {
    fitted,
    point,
    parameters: {
      slope: round4(fit.slope),
      intercept: round4(fit.intercept),
      rSquared: round4(fit.rSquared),
    },
    paramCount: 2,
    varianceMultiplier: (h) => {
      // Textbook OLS prediction interval: extrapolation widens the band.
      if (fit.sumSquaredDeviationsX === 0) return 1;
      const x0 = n - 1 + h;
      return Math.sqrt(1 + 1 / n + (x0 - fit.meanX) ** 2 / fit.sumSquaredDeviationsX);
    },
  };
}

// --------------------------------------------------------------------------
// Parameter fitting
// --------------------------------------------------------------------------

const COARSE = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

function refineGrid(centre: number): number[] {
  const out: number[] = [];
  for (let d = -0.08; d <= 0.081; d += 0.02) {
    const v = centre + d;
    if (v > 0.01 && v < 0.995) out.push(Number(v.toFixed(3)));
  }
  return out.length > 0 ? out : [centre];
}

function fitSingleParameter(
  build: (value: number) => (number | null)[],
  series: readonly number[],
): number {
  const search = (grid: readonly number[]) => {
    let best = grid[0] as number;
    let bestSse = Infinity;
    for (const value of grid) {
      const sse = sumSquaredError(series, build(value));
      if (Number.isFinite(sse) && sse < bestSse) {
        bestSse = sse;
        best = value;
      }
    }
    return best;
  };
  return search(refineGrid(search(COARSE)));
}

function fitTwoParameters(
  build: (a: number, b: number) => (number | null)[],
  series: readonly number[],
): { alpha: number; beta: number } {
  const search = (alphas: readonly number[], betas: readonly number[]) => {
    let best = { alpha: alphas[0] as number, beta: betas[0] as number };
    let bestSse = Infinity;
    for (const a of alphas) {
      for (const b of betas) {
        const sse = sumSquaredError(series, build(a, b));
        if (Number.isFinite(sse) && sse < bestSse) {
          bestSse = sse;
          best = { alpha: a, beta: b };
        }
      }
    }
    return best;
  };
  const coarse = search(COARSE, COARSE);
  return search(refineGrid(coarse.alpha), refineGrid(coarse.beta));
}

function fitThreeParameters(
  build: (a: number, b: number, g: number) => (number | null)[],
  series: readonly number[],
): { alpha: number; beta: number; gamma: number } {
  // Coarser first pass: a full 10^3 grid with refinement is needlessly expensive
  // for the accuracy gain, and this runs synchronously inside a request.
  const coarse = [0.1, 0.3, 0.5, 0.7, 0.9];
  const search = (
    alphas: readonly number[],
    betas: readonly number[],
    gammas: readonly number[],
  ) => {
    let best = { alpha: alphas[0] as number, beta: betas[0] as number, gamma: gammas[0] as number };
    let bestSse = Infinity;
    for (const a of alphas) {
      for (const b of betas) {
        for (const g of gammas) {
          const sse = sumSquaredError(series, build(a, b, g));
          if (Number.isFinite(sse) && sse < bestSse) {
            bestSse = sse;
            best = { alpha: a, beta: b, gamma: g };
          }
        }
      }
    }
    return best;
  };
  const first = search(coarse, coarse, coarse);
  return search(refineGrid(first.alpha), refineGrid(first.beta), refineGrid(first.gamma));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
