import { describe, it, expect } from 'vitest';
import { AppError } from '@ffp/shared';
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
} from './methods.js';

/** Assert a guard threw the shared AppError carrying the INSUFFICIENT_DATA code. */
function expectInsufficientData(run: () => unknown): AppError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const error = caught as AppError;
  expect(error.code).toBe('INSUFFICIENT_DATA');
  expect(error.statusCode).toBe(422);
  return error;
}

function meanAbs(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + Math.abs(v), 0) / values.length;
}

// ---------------------------------------------------------------------------
// naive
// ---------------------------------------------------------------------------

describe('naive', () => {
  const out = naive([10, 20, 30], 3);

  it('carries the last observation forward across the whole horizon', () => {
    expect(out.point).toEqual([30, 30, 30]);
  });

  it('aligns fitted values one period behind, with a null head', () => {
    // The first period has no prior observation to carry forward.
    expect(out.fitted).toEqual([null, 10, 20]);
  });

  it('reports no fitted parameters', () => {
    expect(out.parameters).toEqual({});
    expect(out.paramCount).toBe(0);
  });

  it('fans the interval out as sqrt(h), the random-walk expansion', () => {
    expect(out.varianceMultiplier(1)).toBeCloseTo(1, 12);
    expect(out.varianceMultiplier(2)).toBeCloseTo(Math.SQRT2, 12);
    expect(out.varianceMultiplier(4)).toBeCloseTo(2, 12);
    expect(out.varianceMultiplier(9)).toBeCloseTo(3, 12);
  });

  it('has a variance multiplier strictly increasing in h', () => {
    for (let h = 1; h < 10; h += 1) {
      expect(out.varianceMultiplier(h + 1)).toBeGreaterThan(out.varianceMultiplier(h));
    }
  });

  it('produces an empty forecast for a zero horizon', () => {
    expect(naive([1, 2], 0).point).toEqual([]);
  });

  it('throws INSUFFICIENT_DATA with fewer than two observations', () => {
    const error = expectInsufficientData(() => naive([5], 3));
    expect(error.details).toEqual({ required: 2, received: 1, method: 'Naive' });
    expectInsufficientData(() => naive([], 3));
  });
});

// ---------------------------------------------------------------------------
// seasonalNaive
// ---------------------------------------------------------------------------

describe('seasonalNaive', () => {
  // n = 8, m = 4 -> the last full season is [5,6,7,8]
  const out = seasonalNaive([1, 2, 3, 4, 5, 6, 7, 8], 6, 4);

  it('wraps the last season around a horizon longer than the season', () => {
    // h=1..4 -> series[4..7]; h=5,6 wrap back to series[4], series[5]
    expect(out.point).toEqual([5, 6, 7, 8, 5, 6]);
  });

  it('fits each period from the same period one season earlier', () => {
    expect(out.fitted).toEqual([null, null, null, null, 1, 2, 3, 4]);
  });

  it('wraps a realistic seasonal series', () => {
    const quarterly = [100, 80, 90, 120, 110, 85, 95, 130];
    expect(seasonalNaive(quarterly, 6, 4).point).toEqual([110, 85, 95, 130, 110, 85]);
  });

  it('reports the season length it used and truncates a fractional one', () => {
    expect(out.parameters).toEqual({ seasonLength: 4 });
    expect(seasonalNaive([1, 2, 3, 4, 5, 6, 7, 8], 1, 4.9).parameters).toEqual({ seasonLength: 4 });
    expect(out.paramCount).toBe(0);
  });

  it('holds the variance multiplier flat within a season and steps up between seasons', () => {
    // sqrt(floor((h-1)/m) + 1)
    expect(out.varianceMultiplier(1)).toBeCloseTo(1, 12);
    expect(out.varianceMultiplier(4)).toBeCloseTo(1, 12);
    expect(out.varianceMultiplier(5)).toBeCloseTo(Math.SQRT2, 12);
    expect(out.varianceMultiplier(9)).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('throws when the season length is below 2', () => {
    expectInsufficientData(() => seasonalNaive([1, 2, 3, 4], 2, 1));
  });

  it('throws without a full season plus one observation', () => {
    const error = expectInsufficientData(() => seasonalNaive([1, 2, 3, 4], 2, 4));
    expect(error.details).toEqual({ required: 5, received: 4, method: 'Seasonal naive' });
  });
});

// ---------------------------------------------------------------------------
// runRate
// ---------------------------------------------------------------------------

describe('runRate', () => {
  const out = runRate([10, 20, 30, 40], 2);

  it('projects the average of everything observed so far', () => {
    // (10+20+30+40)/4 = 25
    expect(out.point).toEqual([25, 25]);
  });

  it('fits each period from the running average of the periods before it', () => {
    // t=1 -> mean([10]) = 10 ; t=2 -> mean([10,20]) = 15 ; t=3 -> mean([10,20,30]) = 20
    expect(out.fitted).toEqual([null, 10, 15, 20]);
  });

  it('reports how many periods it averaged', () => {
    expect(out.parameters).toEqual({ periodsObserved: 4 });
    expect(out.paramCount).toBe(1);
  });

  it('holds the variance multiplier flat across the horizon', () => {
    expect(out.varianceMultiplier(1)).toBe(1);
    expect(out.varianceMultiplier(12)).toBe(1);
  });

  it('throws on an empty series', () => {
    expectInsufficientData(() => runRate([], 3));
  });
});

// ---------------------------------------------------------------------------
// movingAverage / weightedMovingAverage
// ---------------------------------------------------------------------------

describe('movingAverage', () => {
  const out = movingAverage([2, 4, 6, 8, 10], 2, 3);

  it('forecasts the mean of the last window', () => {
    // mean([6,8,10]) = 24/3 = 8
    expect(out.point).toEqual([8, 8]);
  });

  it('nulls the first `window` fitted values and averages the preceding window', () => {
    // t=3 -> mean([2,4,6]) = 4 ; t=4 -> mean([4,6,8]) = 6
    expect(out.fitted).toEqual([null, null, null, 4, 6]);
  });

  it('reports the window and holds variance flat', () => {
    expect(out.parameters).toEqual({ window: 3 });
    expect(out.paramCount).toBe(1);
    expect(out.varianceMultiplier(1)).toBe(1);
    expect(out.varianceMultiplier(8)).toBe(1);
  });

  it('handles a window of 2', () => {
    // last two are 8 and 10 -> 9 ; fitted t=2 -> mean([2,4]) = 3, t=3 -> 5, t=4 -> 7
    const w2 = movingAverage([2, 4, 6, 8, 10], 1, 2);
    expect(w2.point).toEqual([9]);
    expect(w2.fitted).toEqual([null, null, 3, 5, 7]);
  });

  it('throws when the window is below 2', () => {
    expectInsufficientData(() => movingAverage([1, 2, 3, 4], 1, 1));
  });

  it('throws when the history is not longer than the window', () => {
    const error = expectInsufficientData(() => movingAverage([1, 2, 3], 1, 3));
    expect(error.details).toEqual({ required: 4, received: 3, method: 'Moving average' });
  });
});

describe('weightedMovingAverage', () => {
  // Window 3 -> weights [1,2,3] (most recent heaviest), total 6.
  const out = weightedMovingAverage([2, 4, 6, 8, 10], 2, 3);

  it('forecasts the linearly weighted mean of the last window', () => {
    // (6*1 + 8*2 + 10*3) / 6 = (6 + 16 + 30)/6 = 52/6 = 8.666666666666666
    expect(out.point[0]).toBeCloseTo(52 / 6, 12);
    expect(out.point).toHaveLength(2);
    expect(out.point[1]).toBeCloseTo(52 / 6, 12);
  });

  it('weights recent periods more heavily than a plain moving average', () => {
    // Plain MA of the same window is 8; the WMA leans toward the recent 10.
    expect(out.point[0] as number).toBeGreaterThan(8);
  });

  it('nulls the first `window` fitted values and weights the preceding window', () => {
    // t=3 -> (2*1 + 4*2 + 6*3)/6 = 28/6 = 4.666666666666667
    // t=4 -> (4*1 + 6*2 + 8*3)/6 = 40/6 = 6.666666666666667
    expect(out.fitted[0]).toBeNull();
    expect(out.fitted[1]).toBeNull();
    expect(out.fitted[2]).toBeNull();
    expect(out.fitted[3] as number).toBeCloseTo(28 / 6, 12);
    expect(out.fitted[4] as number).toBeCloseTo(40 / 6, 12);
  });

  it('reduces to the plain mean on a constant series', () => {
    expect(weightedMovingAverage([5, 5, 5, 5], 1, 3).point).toEqual([5]);
  });

  it('reports the window and holds variance flat', () => {
    expect(out.parameters).toEqual({ window: 3 });
    expect(out.paramCount).toBe(1);
    expect(out.varianceMultiplier(5)).toBe(1);
  });

  it('throws when the window is below 2', () => {
    expectInsufficientData(() => weightedMovingAverage([1, 2, 3, 4], 1, 1));
  });

  it('throws when the history is not longer than the window', () => {
    const error = expectInsufficientData(() => weightedMovingAverage([1, 2, 3], 1, 3));
    expect(error.details).toEqual({ required: 4, received: 3, method: 'Weighted moving average' });
  });
});

// ---------------------------------------------------------------------------
// simple exponential smoothing
// ---------------------------------------------------------------------------

describe('simpleExponentialSmoothing', () => {
  // Hand-run recursion on [10, 12, 16, 14] with alpha = 0.5:
  //   l0 = 10
  //   t=1: fitted = l0 = 10        ; l1 = 0.5*12 + 0.5*10   = 11
  //   t=2: fitted = l1 = 11        ; l2 = 0.5*16 + 0.5*11   = 13.5
  //   t=3: fitted = l2 = 13.5      ; l3 = 0.5*14 + 0.5*13.5 = 13.75
  const out = simpleExponentialSmoothing([10, 12, 16, 14], 3, 0.5);

  it('reproduces the hand-run smoothing recursion', () => {
    expect(out.fitted).toEqual([null, 10, 11, 13.5]);
  });

  it('forecasts the final level flat across the horizon', () => {
    expect(out.point).toEqual([13.75, 13.75, 13.75]);
  });

  it('echoes the supplied alpha', () => {
    expect(out.parameters).toEqual({ alpha: 0.5 });
    expect(out.paramCount).toBe(1);
  });

  it('reproduces the recursion at a different alpha', () => {
    // alpha = 0.2 on [10, 12, 16, 14]:
    //   t=1: fitted 10   ; l1 = 0.2*12 + 0.8*10   = 10.4
    //   t=2: fitted 10.4 ; l2 = 0.2*16 + 0.8*10.4 = 11.52
    //   t=3: fitted 11.52; l3 = 0.2*14 + 0.8*11.52 = 12.016
    const slow = simpleExponentialSmoothing([10, 12, 16, 14], 1, 0.2);
    expect(slow.fitted[1] as number).toBeCloseTo(10, 12);
    expect(slow.fitted[2] as number).toBeCloseTo(10.4, 12);
    expect(slow.fitted[3] as number).toBeCloseTo(11.52, 12);
    expect(slow.point[0] as number).toBeCloseTo(12.016, 12);
  });

  it('reduces to the naive forecast at alpha = 1', () => {
    // The level jumps straight onto each observation.
    const out1 = simpleExponentialSmoothing([10, 12, 16, 14], 2, 1);
    expect(out1.fitted).toEqual([null, 10, 12, 16]);
    expect(out1.point).toEqual([14, 14]);
  });

  it('returns the constant for a flat series, whatever alpha is fitted', () => {
    const flat = simpleExponentialSmoothing([7, 7, 7, 7, 7], 3);
    expect(flat.point).toEqual([7, 7, 7]);
    expect(flat.fitted).toEqual([null, 7, 7, 7, 7]);
  });

  it('expands variance as sqrt(1 + (h-1) * alpha^2)', () => {
    // alpha = 0.5 -> h=1: 1 ; h=2: sqrt(1.25) ; h=3: sqrt(1.5)
    expect(out.varianceMultiplier(1)).toBeCloseTo(1, 12);
    expect(out.varianceMultiplier(2)).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(out.varianceMultiplier(3)).toBeCloseTo(Math.sqrt(1.5), 12);
  });

  it('fits alpha by grid search when none is supplied', () => {
    const fitted = simpleExponentialSmoothing([10, 12, 16, 14, 15, 13], 1);
    const alpha = fitted.parameters.alpha as number;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
    expect(Number.isFinite(fitted.point[0] as number)).toBe(true);
  });

  it('throws with fewer than three observations', () => {
    const error = expectInsufficientData(() => simpleExponentialSmoothing([1, 2], 1));
    expect(error.details).toEqual({
      required: 3,
      received: 2,
      method: 'Simple exponential smoothing',
    });
  });
});

// ---------------------------------------------------------------------------
// Holt's linear trend
// ---------------------------------------------------------------------------

describe('holtLinear', () => {
  it('reproduces the hand-run recursion on a short exact line', () => {
    // series [0,2,4,6,8,10] with alpha = beta = 0.5, phi = 1.
    // l = 0, b = 2 seeded from the first two points; the loop starts at t = 2.
    //   t=2: f = 0 + 2 = 2       ; l = .5*4  + .5*2       = 3
    //                             b = .5*(3-0) + .5*2     = 2.5
    //   t=3: f = 3 + 2.5 = 5.5   ; l = .5*6  + .5*5.5     = 5.75
    //                             b = .5*(5.75-3) + .5*2.5 = 2.625
    //   t=4: f = 8.375           ; l = .5*8  + .5*8.375   = 8.1875
    //                             b = .5*(8.1875-5.75) + .5*2.625 = 2.53125
    //   t=5: f = 10.71875        ; l = .5*10 + .5*10.71875 = 10.359375
    //                             b = .5*(10.359375-8.1875) + .5*2.53125 = 2.3515625
    // point h=1 = 10.359375 + 2.3515625 = 12.7109375
    const out = holtLinear([0, 2, 4, 6, 8, 10], 1, 0.5, 0.5, 1);
    expect(out.fitted).toEqual([null, null, 2, 5.5, 8.375, 10.71875]);
    expect(out.point[0] as number).toBeCloseTo(12.7109375, 12);
  });

  it.fails(
    'BUG: should reproduce an exact line immediately - the state is seeded one period stale',
    () => {
      // With l initialised to y0 and b to y1-y0, the first one-step-ahead forecast
      // (for t=2) is l + b = y1, not y2. Textbook Holt seeds l1 = y1, b1 = y1-y0
      // and so fits a straight line exactly from the very first fitted value.
      const out = holtLinear([0, 2, 4, 6, 8, 10], 1, 0.5, 0.5, 1);
      expect(out.fitted[2] as number).toBeCloseTo(4, 9); // gets 2
      expect(out.point[0] as number).toBeCloseTo(12, 9); // gets 12.7109375
    },
  );

  it('converges onto a perfectly linear series given enough history', () => {
    // y = 100 + 5t over t = 0..23 -> the next three values are 220, 225, 230.
    // The seeding error decays geometrically (|lambda| = sqrt(1-alpha*beta+...) < 1),
    // so by t=23 the extrapolation is on the line to within a hundredth of a unit.
    const line = Array.from({ length: 24 }, (_, i) => 100 + 5 * i);
    const out = holtLinear(line, 3, 0.5, 0.5, 1);
    expect(out.point[0] as number).toBeCloseTo(220, 2);
    expect(out.point[1] as number).toBeCloseTo(225, 2);
    expect(out.point[2] as number).toBeCloseTo(230, 1);
  });

  it('extrapolates undamped forecasts in equal steps', () => {
    const line = Array.from({ length: 24 }, (_, i) => 100 + 5 * i);
    const out = holtLinear(line, 4, 0.5, 0.5, 1);
    const steps = out.point.slice(1).map((v, i) => v - (out.point[i] as number));
    expect(steps[1] as number).toBeCloseTo(steps[0] as number, 9);
    expect(steps[2] as number).toBeCloseTo(steps[0] as number, 9);
    expect(steps[0] as number).toBeCloseTo(5, 2); // the true slope
  });

  it('flattens the extrapolation when damped (phi < 1)', () => {
    const line = Array.from({ length: 24 }, (_, i) => 100 + 5 * i);
    const undamped = holtLinear(line, 6, 0.5, 0.5, 1);
    const damped = holtLinear(line, 6, 0.5, 0.5, 0.8);

    // Every damped forecast sits below the undamped one on an upward trend,
    // and the gap widens with the horizon.
    for (let i = 0; i < 6; i += 1) {
      expect(damped.point[i] as number).toBeLessThan(undamped.point[i] as number);
    }
    const gapFirst = (undamped.point[0] as number) - (damped.point[0] as number);
    const gapLast = (undamped.point[5] as number) - (damped.point[5] as number);
    expect(gapLast).toBeGreaterThan(gapFirst);

    // The damped steps shrink geometrically instead of staying constant.
    const steps = damped.point.slice(1).map((v, i) => v - (damped.point[i] as number));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i] as number).toBeLessThan(steps[i - 1] as number);
    }
  });

  it('reports the parameters it used, rounded to 4dp', () => {
    const out = holtLinear([0, 2, 4, 6, 8, 10], 1, 0.5, 0.25, 0.9);
    expect(out.parameters).toEqual({ alpha: 0.5, beta: 0.25, phi: 0.9 });
    expect(out.paramCount).toBe(2);
  });

  it('leaves the first two fitted values null', () => {
    const out = holtLinear([0, 2, 4, 6, 8, 10], 1, 0.5, 0.5);
    expect(out.fitted[0]).toBeNull();
    expect(out.fitted[1]).toBeNull();
    expect(out.fitted).toHaveLength(6);
  });

  it('expands variance per the ETS(A,A,N) formula', () => {
    // alpha = beta = 0.5:
    //   h=1 -> sqrt(1) = 1
    //   h=2 -> sqrt(1 + (0.5*(1+1*0.5))^2) = sqrt(1 + 0.5625) = 1.25
    //   h=3 -> sqrt(1 + 0.5625 + (0.5*(1+2*0.5))^2) = sqrt(2.5625)
    const out = holtLinear([0, 2, 4, 6, 8, 10], 1, 0.5, 0.5, 1);
    expect(out.varianceMultiplier(1)).toBeCloseTo(1, 12);
    expect(out.varianceMultiplier(2)).toBeCloseTo(1.25, 12);
    expect(out.varianceMultiplier(3)).toBeCloseTo(Math.sqrt(2.5625), 12);
  });

  it('fits alpha and beta by grid search when they are not supplied', () => {
    const line = Array.from({ length: 12 }, (_, i) => 100 + 5 * i);
    const out = holtLinear(line, 2);
    expect(out.parameters.alpha as number).toBeGreaterThan(0);
    expect(out.parameters.beta as number).toBeGreaterThan(0);
    expect(out.parameters.alpha as number).toBeLessThan(1);
    expect(out.parameters.beta as number).toBeLessThan(1);
  });

  it('throws with fewer than four observations', () => {
    const error = expectInsufficientData(() => holtLinear([1, 2, 3], 1));
    expect(error.details).toEqual({
      required: 4,
      received: 3,
      method: "Holt's linear trend",
    });
  });
});

// ---------------------------------------------------------------------------
// Holt-Winters
// ---------------------------------------------------------------------------

describe('holtWintersAdditive', () => {
  // Synthetic series: level 100, trend +2 per period, additive seasonal
  // pattern [10, -5, -10, 5] repeating with m = 4, over 20 periods.
  //   y_t = 100 + 2t + s[t mod 4]
  // The next four values (t = 20..23) are therefore
  //   140 + 10 = 150, 142 - 5 = 137, 144 - 10 = 134, 146 + 5 = 151
  const pattern = [10, -5, -10, 5];
  const series = Array.from({ length: 20 }, (_, t) => 100 + 2 * t + (pattern[t % 4] as number));
  const truth = [150, 137, 134, 151];
  const out = holtWintersAdditive(series, 4, 4);

  it('recovers the level, trend and seasonal pattern', () => {
    out.point.forEach((v, i) => {
      expect(v).toBeCloseTo(truth[i] as number, 0);
    });
  });

  it('reproduces the seasonal shape in the forecast, not just the level', () => {
    // Highest in the first period of the season, lowest in the third.
    expect(out.point[0] as number).toBeGreaterThan(out.point[1] as number);
    expect(out.point[2] as number).toBeLessThan(out.point[1] as number);
    expect(out.point[3] as number).toBeGreaterThan(out.point[2] as number);
  });

  it('tracks the history closely once the state has settled', () => {
    const residuals = series.slice(12).map((actual, i) => actual - (out.fitted[12 + i] as number));
    expect(meanAbs(residuals)).toBeLessThan(0.5);
  });

  it('leaves exactly one season of leading nulls', () => {
    expect(out.fitted).toHaveLength(20);
    expect(out.fitted.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out.fitted[4]).not.toBeNull();
  });

  it('honours explicitly supplied smoothing parameters', () => {
    const fixed = holtWintersAdditive(series, 4, 4, 0.3, 0.1, 0.3);
    expect(fixed.parameters).toEqual({
      alpha: 0.3,
      beta: 0.1,
      gamma: 0.3,
      seasonLength: 4,
    });
    expect(fixed.paramCount).toBe(3);
    fixed.point.forEach((v, i) => {
      expect(Math.abs(v - (truth[i] as number))).toBeLessThan(1);
    });
  });

  it('fits all three parameters inside the unit interval when none are given', () => {
    for (const key of ['alpha', 'beta', 'gamma'] as const) {
      expect(out.parameters[key] as number).toBeGreaterThan(0);
      expect(out.parameters[key] as number).toBeLessThan(1);
    }
    expect(out.parameters.seasonLength).toBe(4);
  });

  it('handles a series containing zero and negative values', () => {
    // Additive seasonality is the variant that must cope with a sign change.
    const signed = [10, -5, 0, 5, 12, -3, 0, 7, 14, -1, 0, 9];
    const result = holtWintersAdditive(signed, 4, 4, 0.3, 0.1, 0.3);
    expect(result.point.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('expands variance like Holt with the same alpha and beta', () => {
    const fixed = holtWintersAdditive(series, 4, 4, 0.5, 0.5, 0.3);
    expect(fixed.varianceMultiplier(1)).toBeCloseTo(1, 12);
    expect(fixed.varianceMultiplier(2)).toBeCloseTo(1.25, 12);
  });

  it('throws when the season length is below 2', () => {
    expectInsufficientData(() => holtWintersAdditive(series, 4, 1));
  });

  it('throws without two full seasons of history', () => {
    const error = expectInsufficientData(() => holtWintersAdditive([1, 2, 3, 4, 5, 6, 7], 4, 4));
    expect(error.details).toEqual({ required: 8, received: 7, method: 'Holt-Winters' });
  });
});

describe('holtWintersMultiplicative', () => {
  const shape = [1.1, 0.9, 0.95, 1.05];
  const positive = Array.from({ length: 20 }, (_, t) => (100 + 2 * t) * (shape[t % 4] as number));

  it('throws on a series containing a zero', () => {
    const withZero = [...positive];
    withZero[5] = 0;
    const error = expectInsufficientData(() => holtWintersMultiplicative(withZero, 4, 4));
    expect(error.message).toMatch(/strictly positive/i);
  });

  it('throws on a series containing a negative value', () => {
    const withNegative = [...positive];
    withNegative[9] = -20;
    expectInsufficientData(() => holtWintersMultiplicative(withNegative, 4, 4));
  });

  it('runs on strictly positive history and keeps the seasonal shape', () => {
    const out = holtWintersMultiplicative(positive, 4, 4, 0.3, 0.1, 0.3);
    expect(out.point.every((v) => Number.isFinite(v))).toBe(true);
    // The pattern peaks in period 1 of the season and troughs in period 2.
    expect(out.point[0] as number).toBeGreaterThan(out.point[1] as number);
    expect(out.point[1] as number).toBeLessThan(out.point[2] as number);
    expect(out.parameters.seasonLength).toBe(4);
  });

  it('still enforces the two-season history guard', () => {
    expectInsufficientData(() => holtWintersMultiplicative([1, 2, 3, 4, 5, 6, 7], 4, 4));
  });
});

// ---------------------------------------------------------------------------
// linearTrend
// ---------------------------------------------------------------------------

describe('linearTrend', () => {
  // y = 3 + 2x over the period index x = 0..4
  const out = linearTrend([3, 5, 7, 9, 11], 3);

  it('recovers the slope, intercept and a perfect R^2', () => {
    expect(out.parameters).toEqual({ slope: 2, intercept: 3, rSquared: 1 });
    expect(out.paramCount).toBe(2);
  });

  it('fits every in-sample point exactly, with no null head', () => {
    expect(out.fitted).toEqual([3, 5, 7, 9, 11]);
  });

  it('extends the line over the horizon', () => {
    // x = 5, 6, 7 -> 13, 15, 17
    expect(out.point).toEqual([13, 15, 17]);
  });

  it('recovers a negative slope', () => {
    const down = linearTrend([20, 17, 14, 11], 2);
    expect(down.parameters.slope).toBe(-3);
    expect(down.parameters.intercept).toBe(20);
    expect(down.point).toEqual([8, 5]);
  });

  it('widens the prediction band as the extrapolation reaches out', () => {
    // n = 5, meanX = 2, Sxx = 10.
    // h=1 -> x0 = 5 : sqrt(1 + 1/5 + 9/10)  = sqrt(2.1)
    // h=2 -> x0 = 6 : sqrt(1 + 1/5 + 16/10) = sqrt(2.8)
    expect(out.varianceMultiplier(1)).toBeCloseTo(Math.sqrt(2.1), 12);
    expect(out.varianceMultiplier(2)).toBeCloseTo(Math.sqrt(2.8), 12);
    expect(out.varianceMultiplier(3)).toBeGreaterThan(out.varianceMultiplier(2));
  });

  it('reports R^2 below 1 on noisy data', () => {
    const noisy = linearTrend([3, 6, 6, 9, 11], 1);
    expect(noisy.parameters.rSquared as number).toBeLessThan(1);
    expect(noisy.parameters.rSquared as number).toBeGreaterThan(0.9);
  });

  it('throws with fewer than three observations', () => {
    const error = expectInsufficientData(() => linearTrend([1, 2], 1));
    expect(error.details).toEqual({ required: 3, received: 2, method: 'Linear regression' });
  });
});

// ---------------------------------------------------------------------------
// Cross-method contract
// ---------------------------------------------------------------------------

describe('method output contract', () => {
  const series = [12, 15, 11, 18, 14, 20, 16, 22, 18, 25, 21, 28];

  const outputs = [
    ['naive', naive(series, 4)],
    ['seasonalNaive', seasonalNaive(series, 4, 4)],
    ['runRate', runRate(series, 4)],
    ['movingAverage', movingAverage(series, 4, 3)],
    ['weightedMovingAverage', weightedMovingAverage(series, 4, 3)],
    ['ses', simpleExponentialSmoothing(series, 4, 0.4)],
    ['holtLinear', holtLinear(series, 4, 0.4, 0.2)],
    ['holtWintersAdditive', holtWintersAdditive(series, 4, 4, 0.3, 0.1, 0.3)],
    ['linearTrend', linearTrend(series, 4)],
  ] as const;

  it.each(outputs)('%s aligns fitted to the history and fills the horizon', (_name, out) => {
    expect(out.fitted).toHaveLength(series.length);
    expect(out.point).toHaveLength(4);
    expect(out.point.every((v) => Number.isFinite(v))).toBe(true);
  });

  it.each(outputs)('%s returns a finite, positive variance multiplier', (_name, out) => {
    for (const h of [1, 2, 6, 12]) {
      const multiplier = out.varianceMultiplier(h);
      expect(Number.isFinite(multiplier)).toBe(true);
      expect(multiplier).toBeGreaterThan(0);
    }
  });

  it.each(outputs)('%s never fans its variance multiplier inward', (_name, out) => {
    for (let h = 1; h < 12; h += 1) {
      expect(out.varianceMultiplier(h + 1)).toBeGreaterThanOrEqual(out.varianceMultiplier(h));
    }
  });
});
