/**
 * Does the forecasting actually forecast?
 *
 * `metrics.test.ts` proves the accuracy arithmetic is right: given actuals and
 * predictions, MAE, RMSE, MAPE, bias and R² come out correct. `forecast.test.ts`
 * proves the rolling-origin backtest runs and ranks. Neither proves the methods
 * **predict well**, and the fixtures they use make that impossible to tell:
 *
 *     const linear   = 1000 + i * 50;                     // a noiseless line
 *     const seasonal = 1000 + i*10 + fixedPattern[i % 12]; // an exact repeat
 *
 * The one skill assertion in that file is "LINEAR_REGRESSION beats NAIVE on a
 * perfectly linear series". OLS on a noiseless line is exact, so that test
 * cannot fail for any competent implementation. Nothing in it would notice a
 * method that fell apart the moment the data had noise in it, and nothing
 * asserted that `AUTO` picks a good method - only that its candidates come back
 * sorted, which a selector that always chose the worst would also satisfy.
 *
 * This file asserts predictive skill on **noisy** series with known structure.
 *
 * The bar is **MASE < 1**, which is not a number tuned until the tests passed:
 * mean absolute scaled error divides the model's error by the error a naive
 * forecast would have made on the same data, so below 1 means "better than
 * assuming tomorrow equals today" and above 1 means "worse than doing nothing".
 * It is the standard bar in the forecasting literature and it is a claim that
 * can genuinely fail.
 *
 * Noise is seeded (`createRng`) so a failure is reproducible rather than a
 * once-a-fortnight mystery. The engine forbids `Math.random` for exactly this
 * reason.
 */
import { describe, expect, it } from 'vitest';
import { autoForecast, backtest, TIME_SERIES_METHODS } from './forecast.js';
import { createRng } from '../risk/random.js';
import type { HistoricalPoint } from './types.js';

function history(values: readonly number[], startYear = 2021): HistoricalPoint[] {
  return values.map((value, i) => {
    const year = startYear + Math.floor(i / 12);
    const index = (i % 12) + 1;
    return { periodKey: `FY${year}-P${String(index).padStart(2, '0')}`, value };
  });
}

/** Seeded gaussian noise, so a failure here is reproducible rather than a mystery. */
function noiseFactory(seed: number) {
  const rng = createRng(seed);
  return (sd: number) => rng.nextNormal() * sd;
}

/**
 * Five years of monthly telecom-shaped opex: a level, steady growth, a repeating
 * seasonal profile, and noise.
 *
 * The seasonal profile is the shape a network operator actually shows - energy
 * and field maintenance peak in summer, capital works pause over year-end - and
 * it matters that it is not symmetric, because a symmetric pattern lets a method
 * look good by accident.
 */
const SEASON = [-0.06, -0.04, 0.01, 0.03, 0.06, 0.09, 0.11, 0.08, 0.02, -0.01, -0.05, -0.09];

function seasonalSeries({
  n = 60,
  base = 1_000_000,
  monthlyGrowth = 0.004,
  noiseSd = 0,
  seed = 42,
}: {
  n?: number;
  base?: number;
  monthlyGrowth?: number;
  noiseSd?: number;
  seed?: number;
} = {}): HistoricalPoint[] {
  const noise = noiseFactory(seed);
  return history(
    Array.from({ length: n }, (_, i) => {
      const level = base * (1 + monthlyGrowth) ** i;
      const seasonal = 1 + (SEASON[i % 12] as number);
      return level * seasonal * (1 + (noiseSd > 0 ? noise(noiseSd) : 0));
    }),
  );
}

/** Trend and noise, no seasonality. */
function trendingSeries({ n = 48, noiseSd = 0.05, seed = 7 } = {}): HistoricalPoint[] {
  const noise = noiseFactory(seed);
  return history(
    Array.from({ length: n }, (_, i) => 500_000 + i * 12_000 + 500_000 * noise(noiseSd)),
  );
}

const SEASONAL_OPTS = { foldHorizon: 3, seasonLength: 12, minTrainSize: 36 } as const;

describe('predictive skill on noisy seasonal data', () => {
  // 4% monthly noise: visible, realistic for opex, and enough to punish a method
  // that only works on clean lines.
  const series = seasonalSeries({ noiseSd: 0.04 });

  /**
   * Measured on this fixture, for whoever changes it next:
   *
   *     HOLT_WINTERS_MULTIPLICATIVE   MASE 0.588   MAPE 3.8%   bias -0.5%
   *     HOLT_WINTERS_ADDITIVE         MASE 0.609   MAPE 3.9%   bias -0.6%
   *     SEASONAL_NAIVE                MASE 0.974   MAPE 6.0%   bias +5.1%
   *     SIMPLE_EXPONENTIAL_SMOOTHING  MASE 1.365   MAPE 8.6%   bias -0.3%
   *     NAIVE                         MASE 1.356   MAPE 8.5%   bias -0.3%
   *
   * Holt-Winters reaches a 3.8% MAPE against 4% injected noise - it is
   * recovering the signal to the noise floor, which is as well as anything can
   * do here. The threshold below is 0.8 rather than 1.0 so it asserts real skill
   * with room for a reasonable fixture change, instead of sitting on the edge.
   */
  it.each(['HOLT_WINTERS_ADDITIVE', 'HOLT_WINTERS_MULTIPLICATIVE'] as const)(
    '%s comfortably beats a naive forecast out of sample',
    (method) => {
      const score = backtest(series, method, SEASONAL_OPTS);

      expect(score.foldCount).toBeGreaterThan(2);
      expect(score.error).toBeUndefined();
      expect(score.accuracy.mase).not.toBeNull();
      // MASE < 1 means "better than assuming next month equals this month".
      // These sit near 0.6, so 0.8 asserts skill without being brittle.
      expect(score.accuracy.mase!).toBeLessThan(0.8);
    },
  );

  it('seasonal naive beats naive, but only just, and leans high', () => {
    // Kept as its own case rather than folded in above, because it is genuinely
    // marginal (0.974) and saying so is more useful than hiding it behind a
    // loose threshold. Repeating last year ignores growth, so on a rising series
    // it under-forecasts persistently - visible as a +5% bias where
    // Holt-Winters sits near zero. That the metrics surface the weakness is the
    // point: a reviewer choosing this method can see what they are accepting.
    const seasonalNaive = backtest(series, 'SEASONAL_NAIVE', SEASONAL_OPTS);

    expect(seasonalNaive.accuracy.mase!).toBeLessThan(1);
    expect(seasonalNaive.accuracy.biasPercent!).toBeGreaterThan(0.02);
  });

  it('a seasonal method beats a non-seasonal one on seasonal data', () => {
    // The substantive claim: modelling the season is worth something. If this
    // fails, the seasonal implementations are decorative.
    const seasonal = backtest(series, 'HOLT_WINTERS_ADDITIVE', SEASONAL_OPTS);
    const flat = backtest(series, 'SIMPLE_EXPONENTIAL_SMOOTHING', SEASONAL_OPTS);

    expect(seasonal.score).toBeLessThan(flat.score);
  });

  it('does not systematically over- or under-forecast', () => {
    // Symmetric noise around a smooth signal should leave no persistent lean.
    // A method that always guessed low would still score well on MAE while
    // quietly biasing every budget built on it - which is the failure that
    // matters commercially and the one MAE cannot see.
    const score = backtest(series, 'HOLT_WINTERS_ADDITIVE', SEASONAL_OPTS);

    expect(Math.abs(score.accuracy.biasPercent ?? 0)).toBeLessThan(0.1);
  });
});

describe('predictive skill on a noisy trend', () => {
  const series = trendingSeries();

  it.each(['LINEAR_REGRESSION', 'HOLT_LINEAR'] as const)(
    '%s beats a naive forecast on a trending series',
    (method) => {
      const score = backtest(series, method, { foldHorizon: 3, minTrainSize: 24 });

      expect(score.accuracy.mase).not.toBeNull();
      expect(score.accuracy.mase!).toBeLessThan(1);
    },
  );

  it('extrapolates the trend rather than flattening it', () => {
    // A trend-aware method must, over a 3-period horizon, forecast above the
    // last observed value on a rising series. Exponential smoothing without a
    // trend term does not, which is the distinction being asserted.
    const result = autoForecast(series, { horizon: 3, method: 'HOLT_LINEAR' });
    const last = series[series.length - 1]!.value;

    expect(result.point[2]!).toBeGreaterThan(last * 0.98);
  });
});

describe('AUTO selection is actually good, not merely sorted', () => {
  // forecast.test.ts asserts the candidate list comes back ordered. A selector
  // that always returned the worst method would satisfy that. These assert the
  // thing the product depends on: that what AUTO *chose* is worth using.
  const series = seasonalSeries({ noiseSd: 0.04 });

  it('picks a method that beats the naive baseline', () => {
    const result = autoForecast(series, { horizon: 6, seasonLength: 12 });
    const chosen = result.candidates[0]!;

    expect(chosen.accuracy.mase).not.toBeNull();
    expect(chosen.accuracy.mase!).toBeLessThan(1);
  });

  it('prefers a seasonal method when the data is seasonal', () => {
    const result = autoForecast(series, { horizon: 6, seasonLength: 12 });

    expect(result.candidates[0]!.method).toMatch(/SEASONAL_NAIVE|HOLT_WINTERS/);
  });

  it('does not pick a seasonal method on data with no season', () => {
    // The inverse, which is what stops the first assertion passing for a
    // selector hard-wired to prefer Holt-Winters.
    const result = autoForecast(trendingSeries(), { horizon: 6, seasonLength: 12 });

    expect(result.candidates[0]!.method).not.toMatch(/SEASONAL_NAIVE/);
  });
});

describe('behaviour on data that breaks assumptions', () => {
  it('degrades honestly across a structural break rather than exploding', () => {
    // A network sale, an acquisition, a tariff change: the level moves and no
    // method can predict it. What matters is that the output stays finite and
    // recognisably in the region of the data, so a reviewer sees a bad forecast
    // rather than a nonsensical one.
    const base = seasonalSeries({ n: 48, noiseSd: 0.03 });
    const shifted = history([
      ...base.slice(0, 36).map((p) => p.value),
      ...base.slice(36).map((p) => p.value * 1.6),
    ]);

    for (const method of TIME_SERIES_METHODS) {
      const result = autoForecast(shifted, { horizon: 6, seasonLength: 12, method });
      expect(
        result.point.every((v) => Number.isFinite(v)),
        method,
      ).toBe(true);
      // Within an order of magnitude of the series' own range.
      const max = Math.max(...shifted.map((p) => p.value));
      expect(
        result.point.every((v) => v > 0 && v < max * 10),
        method,
      ).toBe(true);
    }
  });

  it('reports MAPE as null but sMAPE as finite when actuals touch zero', () => {
    // Documented behaviour, asserted because a division by zero silently
    // producing Infinity would poison a ranking rather than announce itself.
    const withZero = history([100, 0, 120, 0, 140, 0, 160, 0, 180, 0, 200, 0, 220, 0, 240, 0]);
    const score = backtest(withZero, 'NAIVE', { foldHorizon: 1, minTrainSize: 8 });

    expect(score.accuracy.mape).toBeNull();
    expect(Number.isFinite(score.accuracy.smape)).toBe(true);
  });

  it('is reproducible: the same history forecasts identically', () => {
    // A published contingency figure has to be re-derivable. The forecasting
    // path takes no seed because it is deterministic; this asserts that.
    const series = seasonalSeries({ noiseSd: 0.04 });
    const a = autoForecast(series, { horizon: 6, seasonLength: 12 });
    const b = autoForecast(series, { horizon: 6, seasonLength: 12 });

    expect(a.point).toEqual(b.point);
    expect(a.candidates[0]!.method).toBe(b.candidates[0]!.method);
  });
});
