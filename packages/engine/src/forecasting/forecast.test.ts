import { describe, expect, it } from 'vitest';
import {
  TIME_SERIES_METHODS,
  autoForecast,
  backtest,
  forecast,
  nextPeriodKeys,
} from './forecast.js';
import type { HistoricalPoint } from './types.js';

/** Build a history on the monthly fiscal axis from a plain series. */
function history(values: readonly number[], startYear = 2024): HistoricalPoint[] {
  return values.map((value, i) => {
    const year = startYear + Math.floor(i / 12);
    const index = (i % 12) + 1;
    return { periodKey: `FY${year}-P${String(index).padStart(2, '0')}`, value };
  });
}

const linear = history(Array.from({ length: 24 }, (_, i) => 1000 + i * 50));
const seasonal = history(
  Array.from({ length: 36 }, (_, i) => {
    const level = 1000 + i * 10;
    const season = [0, 40, 80, 120, 60, -20, -80, -120, -60, 20, 100, 140][i % 12] as number;
    return level + season;
  }),
);

describe('nextPeriodKeys', () => {
  it('continues within a fiscal year', () => {
    expect(nextPeriodKeys('FY2026-P03', 3)).toEqual(['FY2026-P04', 'FY2026-P05', 'FY2026-P06']);
  });

  it('rolls over the fiscal year boundary', () => {
    expect(nextPeriodKeys('FY2026-P12', 3)).toEqual(['FY2027-P01', 'FY2027-P02', 'FY2027-P03']);
  });

  it('rolls over on a quarterly axis', () => {
    expect(nextPeriodKeys('FY2026-Q4', 2)).toEqual(['FY2027-Q1', 'FY2027-Q2']);
  });

  it('spans multiple years', () => {
    const keys = nextPeriodKeys('FY2026-P11', 14);
    expect(keys[0]).toBe('FY2026-P12');
    expect(keys[1]).toBe('FY2027-P01');
    expect(keys[13]).toBe('FY2028-P01');
  });

  it('returns nothing for an unparsable key', () => {
    expect(nextPeriodKeys('not-a-key', 3)).toEqual([]);
  });
});

describe('forecast', () => {
  it('returns the requested number of points', () => {
    const result = forecast(linear, 'LINEAR_REGRESSION', { horizon: 6 });
    expect(result.point).toHaveLength(6);
    expect(result.periodKeys).toHaveLength(6);
    expect(result.method).toBe('LINEAR_REGRESSION');
  });

  it('labels the forecast periods continuing from the history', () => {
    const result = forecast(linear, 'LINEAR_REGRESSION', { horizon: 3 });
    // History ends at FY2025-P12.
    expect(result.periodKeys).toEqual(['FY2026-P01', 'FY2026-P02', 'FY2026-P03']);
  });

  it('extrapolates an exact line exactly', () => {
    // y = 1000 + 50t over t = 0..23, so t = 24 gives 2200 and t = 25 gives 2250.
    const result = forecast(linear, 'LINEAR_REGRESSION', { horizon: 2 });
    expect(result.point[0]).toBeCloseTo(2200, 6);
    expect(result.point[1]).toBeCloseTo(2250, 6);
    expect(result.parameters.rSquared).toBeCloseTo(1, 6);
  });

  it('brackets the point forecast with its interval', () => {
    const result = forecast(seasonal, 'HOLT_LINEAR', { horizon: 6, confidenceLevel: 0.95 });
    expect(result.interval).not.toBeNull();
    result.point.forEach((point, i) => {
      expect(result.interval?.lower[i] as number).toBeLessThan(point);
      expect(result.interval?.upper[i] as number).toBeGreaterThan(point);
    });
  });

  it('widens the interval at a higher confidence level', () => {
    const narrow = forecast(seasonal, 'HOLT_LINEAR', { horizon: 4, confidenceLevel: 0.8 });
    const wide = forecast(seasonal, 'HOLT_LINEAR', { horizon: 4, confidenceLevel: 0.99 });

    const width = (r: typeof narrow) =>
      (r.interval?.upper[0] as number) - (r.interval?.lower[0] as number);
    expect(width(wide)).toBeGreaterThan(width(narrow));
  });

  it('fans the interval out with horizon for a random walk', () => {
    const result = forecast(seasonal, 'NAIVE', { horizon: 6 });
    const width = (i: number) =>
      (result.interval?.upper[i] as number) - (result.interval?.lower[i] as number);
    expect(width(5)).toBeGreaterThan(width(0));
  });

  it('reports accuracy over the in-sample window', () => {
    const result = forecast(seasonal, 'HOLT_WINTERS_ADDITIVE', { horizon: 6, seasonLength: 12 });
    expect(result.accuracy.n).toBeGreaterThan(0);
    expect(result.accuracy.rmse).toBeGreaterThanOrEqual(0);
    expect(result.accuracy.mase).not.toBeNull();
  });

  it('warns when the history is short', () => {
    const result = forecast(history([100, 110, 120, 130, 125]), 'NAIVE', { horizon: 3 });
    expect(result.warnings.join(' ')).toMatch(/historical periods/i);
  });

  it('warns when there are fewer than two full seasons', () => {
    const result = forecast(history(Array.from({ length: 14 }, (_, i) => 100 + i)), 'NAIVE', {
      horizon: 3,
      seasonLength: 12,
    });
    expect(result.warnings.join(' ')).toMatch(/two full seasons/i);
  });

  it('rejects a history that is too short to forecast at all', () => {
    expect(() => forecast(history([100]), 'NAIVE', { horizon: 3 })).toThrow(
      /at least two historical observations/i,
    );
  });

  it('rejects non-finite history values', () => {
    expect(() => forecast(history([100, Number.NaN, 120]), 'NAIVE', { horizon: 2 })).toThrow(
      /non-numeric or infinite/i,
    );
  });

  it('refuses DRIVER_BASED, which is not a time-series method', () => {
    expect(() => forecast(linear, 'DRIVER_BASED' as never, { horizon: 3 })).toThrow(
      /not a time-series method/i,
    );
  });

  it('honours explicitly supplied period keys', () => {
    const result = forecast(linear, 'NAIVE', {
      horizon: 2,
      futurePeriodKeys: ['CUSTOM-1', 'CUSTOM-2'],
    });
    expect(result.periodKeys).toEqual(['CUSTOM-1', 'CUSTOM-2']);
  });

  it('runs every time-series method on adequate history', () => {
    for (const method of TIME_SERIES_METHODS) {
      const result = forecast(seasonal, method as never, {
        horizon: 3,
        seasonLength: 12,
        window: 3,
      });
      expect(result.point).toHaveLength(3);
      expect(result.point.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

describe('backtest', () => {
  it('scores a method over multiple rolling origins', () => {
    const score = backtest(seasonal, 'LINEAR_REGRESSION', { foldHorizon: 1 });
    expect(score.foldCount).toBeGreaterThan(0);
    expect(Number.isFinite(score.score)).toBe(true);
    expect(score.error).toBeUndefined();
  });

  it('reports honestly when there is not enough history to backtest', () => {
    const score = backtest(history([100, 105, 110]), 'LINEAR_REGRESSION', {
      foldHorizon: 6,
      minTrainSize: 3,
    });
    expect(score.foldCount).toBe(0);
    expect(score.score).toBe(Infinity);
    expect(score.error).toBeTruthy();
  });

  it('respects an explicit fold count', () => {
    const score = backtest(seasonal, 'NAIVE', { foldHorizon: 1, folds: 3, minTrainSize: 24 });
    expect(score.foldCount).toBe(3);
  });

  it('rates a good model better than a poor one on a trending series', () => {
    const good = backtest(linear, 'LINEAR_REGRESSION', { foldHorizon: 1, minTrainSize: 12 });
    const poor = backtest(linear, 'NAIVE', { foldHorizon: 1, minTrainSize: 12 });
    // A perfectly linear series is exactly what OLS is for.
    expect(good.score).toBeLessThan(poor.score);
  });
});

describe('autoForecast', () => {
  it('returns candidates sorted best-first', () => {
    const result = autoForecast(seasonal, { horizon: 6, seasonLength: 12 });
    expect(result.candidates.length).toBeGreaterThan(3);
    for (let i = 1; i < result.candidates.length; i += 1) {
      expect(result.candidates[i - 1]?.score as number).toBeLessThanOrEqual(
        result.candidates[i]?.score as number,
      );
    }
  });

  it('does not settle for the naive benchmark on a strongly linear series', () => {
    const result = autoForecast(linear, { horizon: 6 });
    expect(result.method).not.toBe('NAIVE');
  });

  it('explains its choice in the warnings', () => {
    const result = autoForecast(linear, { horizon: 4 });
    expect(result.warnings.join(' ')).toMatch(/Selected .* by rolling-origin backtest/);
    expect(['MASE', 'RMSE']).toContain(result.selectionCriterion);
  });

  it('excludes seasonal methods when no season length is given', () => {
    const result = autoForecast(linear, { horizon: 4 });
    const methods = result.candidates.map((c) => c.method);
    expect(methods).not.toContain('SEASONAL_NAIVE');
    expect(methods).not.toContain('HOLT_WINTERS_ADDITIVE');
    expect(methods).not.toContain('HOLT_WINTERS_MULTIPLICATIVE');
  });

  it('considers seasonal methods once a season length is given', () => {
    const result = autoForecast(seasonal, { horizon: 6, seasonLength: 12 });
    expect(result.candidates.map((c) => c.method)).toContain('HOLT_WINTERS_ADDITIVE');
  });

  it('excludes multiplicative seasonality when the series touches zero', () => {
    const withZero = history(
      Array.from({ length: 30 }, (_, i) => (i === 5 ? 0 : 100 + (i % 12) * 5)),
    );
    const result = autoForecast(withZero, { horizon: 3, seasonLength: 12 });
    expect(result.candidates.map((c) => c.method)).not.toContain('HOLT_WINTERS_MULTIPLICATIVE');
  });

  it('produces a usable forecast alongside the comparison', () => {
    const result = autoForecast(seasonal, { horizon: 6, seasonLength: 12 });
    expect(result.point).toHaveLength(6);
    expect(result.periodKeys).toHaveLength(6);
    expect(result.point.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('falls back to the benchmark and says so when nothing can be backtested', () => {
    // Four points is too short for any rolling-origin fold to form.
    const result = autoForecast(history([100, 102, 104, 106]), { horizon: 2 });
    expect(result.point).toHaveLength(2);
    expect(result.warnings.join(' ')).toMatch(/fell back to the naive benchmark/i);
  });
});
