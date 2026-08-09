import { describe, it, expect } from 'vitest';
import {
  accuracyMetrics,
  combineMetrics,
  naiveMae,
  residualStdDev,
  sumSquaredError,
} from './metrics.js';
import type { AccuracyMetrics } from './types.js';

/** Build a fold-level metric block by hand, so combineMetrics is tested in isolation. */
function fold(partial: Partial<AccuracyMetrics> & { n: number }): AccuracyMetrics {
  return {
    mae: 0,
    rmse: 0,
    mape: null,
    smape: 0,
    mase: null,
    bias: 0,
    biasPercent: null,
    rSquared: null,
    ...partial,
  };
}

describe('accuracyMetrics - hand-computed case', () => {
  // actuals    = [10, 20, 30]
  // predictions= [12, 18, 33]
  // errors (actual - predicted) = [-2, +2, -3]
  const actuals = [10, 20, 30];
  const predictions = [12, 18, 33];
  const m = accuracyMetrics(actuals, predictions);

  it('counts every usable pair', () => {
    expect(m.n).toBe(3);
  });

  it('computes MAE as the mean absolute error', () => {
    // (2 + 2 + 3) / 3 = 7/3 = 2.3333333333333335
    expect(m.mae).toBeCloseTo(7 / 3, 12);
  });

  it('computes RMSE from the mean squared error', () => {
    // (4 + 4 + 9) / 3 = 17/3 ; sqrt(17/3) = 2.3804761428476167
    expect(m.rmse).toBeCloseTo(2.3804761428476167, 12);
  });

  it('computes MAPE as a fraction', () => {
    // |−2/10| + |2/20| + |−3/30| = 0.2 + 0.1 + 0.1 = 0.4 ; /3 = 0.13333333333333333
    expect(m.mape).toBeCloseTo(0.4 / 3, 12);
  });

  it('computes sMAPE against the mean of the absolute pair', () => {
    // 2/((10+12)/2) = 2/11    = 0.18181818181818182
    // 2/((20+18)/2) = 2/19    = 0.10526315789473684
    // 3/((30+33)/2) = 3/31.5  = 0.09523809523809523
    // mean = 0.3823194349510139 / 3 = 0.12743981165033797
    expect(m.smape).toBeCloseTo(0.1274398116503, 12);
  });

  it('computes bias as the mean signed error', () => {
    // (-2 + 2 - 3) / 3 = -3/3 = -1 (the model over-forecasts on average)
    expect(m.bias).toBeCloseTo(-1, 12);
  });

  it('computes biasPercent against the mean actual', () => {
    // mean actual = (10+20+30)/3 = 20 -> -1 / 20 = -0.05
    expect(m.biasPercent).toBeCloseTo(-0.05, 12);
  });

  it('computes rSquared against the total sum of squares', () => {
    // SStot = (10-20)^2 + (20-20)^2 + (30-20)^2 = 200 ; SSres = 17
    // 1 - 17/200 = 0.915
    expect(m.rSquared).toBeCloseTo(0.915, 12);
  });

  it('is exactly zero-error for a perfect forecast', () => {
    const perfect = accuracyMetrics([4, 8, 15], [4, 8, 15]);
    expect(perfect.mae).toBe(0);
    expect(perfect.rmse).toBe(0);
    expect(perfect.mape).toBe(0);
    expect(perfect.smape).toBe(0);
    expect(perfect.bias).toBe(0);
    expect(perfect.rSquared).toBe(1);
  });
});

describe('accuracyMetrics - MAPE at zero actuals', () => {
  it('is null when any actual is exactly 0', () => {
    // The single zero actual makes the percentage error undefined for that pair,
    // so the whole statistic is suppressed rather than silently computed on a subset.
    const m = accuracyMetrics([0, 10], [1, 11]);
    expect(m.mape).toBeNull();
  });

  it('stays defined when no actual is 0', () => {
    // |1-2|/1 = 1 ; |10-11|/10 = 0.1 -> (1 + 0.1)/2 = 0.55
    const m = accuracyMetrics([1, 10], [2, 11]);
    expect(m.mape).toBeCloseTo(0.55, 12);
  });

  it('leaves sMAPE defined when an actual is 0', () => {
    // pair 1: |0-1| / ((0+1)/2) = 1/0.5 = 2
    // pair 2: |10-11| / ((10+11)/2) = 1/10.5 = 0.09523809523809523
    // mean = (2 + 0.09523809523809523)/2 = 1.0476190476190477
    const m = accuracyMetrics([0, 10], [1, 11]);
    expect(m.smape).toBeCloseTo(1.0476190476190477, 12);
  });

  it('skips the sMAPE pair where actual and prediction are both 0', () => {
    // Only the second pair contributes: |4-6| / ((4+6)/2) = 2/5 = 0.4
    const m = accuracyMetrics([0, 4], [0, 6]);
    expect(m.smape).toBeCloseTo(0.4, 12);
  });

  it('sMAPE is 0 when every pair has a zero denominator', () => {
    const m = accuracyMetrics([0, 0], [0, 0]);
    expect(m.smape).toBe(0);
  });
});

describe('accuracyMetrics - MASE', () => {
  it('is null when no training series is supplied', () => {
    expect(accuracyMetrics([10, 20], [11, 19]).mase).toBeNull();
  });

  it('is null when the training series is too short for a naive comparison', () => {
    // length 1 <= seasonLength 1 -> no in-sample naive error to scale by
    expect(accuracyMetrics([10], [11], { trainingSeries: [5] }).mase).toBeNull();
    // length 4 <= seasonLength 4
    expect(
      accuracyMetrics([10], [11], { trainingSeries: [1, 2, 3, 4], seasonLength: 4 }).mase,
    ).toBeNull();
  });

  it('is null when the naive benchmark has zero error', () => {
    // A constant training series gives a naive MAE of 0; scaling by it is undefined.
    expect(accuracyMetrics([10], [11], { trainingSeries: [5, 5, 5] }).mase).toBeNull();
  });

  it('is below 1 when the model beats the naive benchmark', () => {
    // training [10,12,14,16,18] -> naive MAE = mean(|2|,|2|,|2|,|2|) = 2
    // model MAE = mean(|20-20.5|, |22-21.5|) = 0.5 -> MASE = 0.5 / 2 = 0.25
    const m = accuracyMetrics([20, 22], [20.5, 21.5], {
      trainingSeries: [10, 12, 14, 16, 18],
    });
    expect(m.mase).toBeCloseTo(0.25, 12);
    expect(m.mase as number).toBeLessThan(1);
  });

  it('is above 1 when the model is worse than the naive benchmark', () => {
    // naive MAE = 2 ; model MAE = mean(|20-26|, |22-16|) = 6 -> MASE = 3
    const m = accuracyMetrics([20, 22], [26, 16], { trainingSeries: [10, 12, 14, 16, 18] });
    expect(m.mase).toBeCloseTo(3, 12);
  });

  it('scales by the seasonal naive benchmark when a season length is given', () => {
    // training [1,2,3,4,5,6,7,8] with m=4 -> |5-1|,|6-2|,|7-3|,|8-4| all 4 -> scale 4
    // model MAE = 2 -> MASE = 0.5
    const m = accuracyMetrics([10, 20], [8, 22], {
      trainingSeries: [1, 2, 3, 4, 5, 6, 7, 8],
      seasonLength: 4,
    });
    expect(m.mase).toBeCloseTo(0.5, 12);
  });
});

describe('accuracyMetrics - bias sign convention', () => {
  it('is positive when the model under-forecasts', () => {
    // bias = actual - predicted; predictions below the actuals -> positive bias.
    const m = accuracyMetrics([10, 10], [8, 8]);
    expect(m.bias).toBeCloseTo(2, 12);
    expect(m.bias).toBeGreaterThan(0);
    expect(m.biasPercent).toBeCloseTo(0.2, 12); // 2 / |10|
  });

  it('is negative when the model over-forecasts', () => {
    const m = accuracyMetrics([10, 10], [13, 13]);
    expect(m.bias).toBeCloseTo(-3, 12);
    expect(m.biasPercent).toBeCloseTo(-0.3, 12);
  });

  it('cancels to zero when errors are symmetric', () => {
    const m = accuracyMetrics([10, 10], [8, 12]);
    expect(m.bias).toBeCloseTo(0, 12);
    expect(m.mae).toBeCloseTo(2, 12);
  });

  it('uses the absolute mean actual so biasPercent keeps the error sign', () => {
    // actuals [-10,-10] mean = -10; predicted [-8,-8] -> bias = -2
    // biasPercent = -2 / |-10| = -0.2 (not +0.2)
    const m = accuracyMetrics([-10, -10], [-8, -8]);
    expect(m.bias).toBeCloseTo(-2, 12);
    expect(m.biasPercent).toBeCloseTo(-0.2, 12);
  });

  it('reports biasPercent as null when the mean actual is 0', () => {
    const m = accuracyMetrics([-10, 10], [-9, 9]);
    expect(m.biasPercent).toBeNull();
  });
});

describe('accuracyMetrics - rSquared', () => {
  it('is 1 for a perfect fit', () => {
    expect(accuracyMetrics([1, 2, 3], [1, 2, 3]).rSquared).toBe(1);
  });

  it('is 0 when the prediction is no better than the mean', () => {
    // actuals [10,20,30], mean 20; predicting the mean everywhere:
    // SSres = 100 + 0 + 100 = 200 = SStot -> R^2 = 0
    expect(accuracyMetrics([10, 20, 30], [20, 20, 20]).rSquared).toBeCloseTo(0, 12);
  });

  it('goes negative when the prediction is worse than the mean', () => {
    // SSres = (10-30)^2 + 0 + (30-10)^2 = 800 ; SStot = 200 -> 1 - 4 = -3
    expect(accuracyMetrics([10, 20, 30], [30, 20, 10]).rSquared).toBeCloseTo(-3, 12);
  });

  it('is null when the actuals have no variance', () => {
    expect(accuracyMetrics([5, 5, 5], [4, 5, 6]).rSquared).toBeNull();
  });
});

describe('accuracyMetrics - pair filtering', () => {
  it('drops pairs where the actual is null', () => {
    // Only (10,9) and (20,19) survive -> MAE = 1
    const m = accuracyMetrics([null, 10, 20], [5, 9, 19]);
    expect(m.n).toBe(2);
    expect(m.mae).toBeCloseTo(1, 12);
  });

  it('drops pairs where the prediction is null (an unfitted head)', () => {
    const m = accuracyMetrics([10, 20, 30], [null, 19, 31]);
    expect(m.n).toBe(2);
    // errors +1 and -1 -> MAE 1, bias 0
    expect(m.mae).toBeCloseTo(1, 12);
    expect(m.bias).toBeCloseTo(0, 12);
  });

  it('drops non-finite pairs', () => {
    const m = accuracyMetrics([10, Number.NaN, 30, 40], [11, 5, Infinity, 41]);
    expect(m.n).toBe(2);
    expect(m.mae).toBeCloseTo(1, 12);
  });

  it('truncates to the shorter of the two arrays', () => {
    const m = accuracyMetrics([10, 20, 30], [11, 21]);
    expect(m.n).toBe(2);
  });

  it('returns the empty metric block when nothing pairs up', () => {
    const m = accuracyMetrics([], []);
    expect(m).toEqual({
      mae: 0,
      rmse: 0,
      mape: null,
      smape: 0,
      mase: null,
      bias: 0,
      biasPercent: null,
      rSquared: null,
      n: 0,
    });
  });

  it('returns the empty metric block when every pair is unusable', () => {
    expect(accuracyMetrics([null, null], [1, 2]).n).toBe(0);
  });
});

describe('naiveMae', () => {
  it('averages the absolute period-over-period change', () => {
    // |12-10| + |14-12| = 2 + 2 -> /2 = 2
    expect(naiveMae([10, 12, 14])).toBeCloseTo(2, 12);
  });

  it('handles a non-monotonic series', () => {
    // [4, 9, 6, 6] -> |5| + |-3| + |0| = 8 -> /3 = 2.6666666666666665
    expect(naiveMae([4, 9, 6, 6])).toBeCloseTo(8 / 3, 12);
  });

  it('uses the seasonal lag when a season length is supplied', () => {
    // [1..8] with m=4 -> |5-1|,|6-2|,|7-3|,|8-4| = 4,4,4,4 -> 4
    expect(naiveMae([1, 2, 3, 4, 5, 6, 7, 8], 4)).toBeCloseTo(4, 12);
  });

  it('is 0 for a perfectly seasonal series', () => {
    // The season repeats exactly, so the seasonal naive forecast is error-free.
    expect(naiveMae([10, 20, 30, 10, 20, 30], 3)).toBe(0);
  });

  it('returns null when the series is not longer than the lag', () => {
    expect(naiveMae([5])).toBeNull();
    expect(naiveMae([1, 2, 3, 4], 4)).toBeNull();
    expect(naiveMae([], 1)).toBeNull();
  });

  it('coerces a fractional or sub-1 season length to at least 1', () => {
    // m = max(1, trunc(0.5)) = 1 -> plain naive on [10,12,14] = 2
    expect(naiveMae([10, 12, 14], 0.5)).toBeCloseTo(2, 12);
  });

  it('skips non-finite observations', () => {
    // [1, NaN, 3, 5] with m=1: i=1 skipped (NaN), i=2 skipped (NaN lag),
    // i=3 contributes |5-3| = 2 -> mean over 1 usable comparison = 2
    expect(naiveMae([1, Number.NaN, 3, 5])).toBeCloseTo(2, 12);
  });

  it('returns null when every comparison is non-finite', () => {
    expect(naiveMae([Number.NaN, Number.NaN])).toBeNull();
  });
});

describe('sumSquaredError', () => {
  it('sums the squared one-step-ahead errors', () => {
    // (2-1.5)^2 + (3-2.5)^2 = 0.25 + 0.25 = 0.5 ; the leading null is skipped
    expect(sumSquaredError([1, 2, 3], [null, 1.5, 2.5])).toBeCloseTo(0.5, 12);
  });

  it('is 0 for a perfect fit', () => {
    expect(sumSquaredError([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('skips non-finite fitted values', () => {
    // Only the last pair counts: (30-25)^2 = 25
    expect(sumSquaredError([10, 20, 30], [Number.NaN, Infinity, 25])).toBeCloseTo(25, 12);
  });

  it('truncates to the shorter array', () => {
    // Only index 0 is compared: (10-8)^2 = 4
    expect(sumSquaredError([10, 20, 30], [8])).toBeCloseTo(4, 12);
  });

  it('is 0 when nothing is comparable', () => {
    expect(sumSquaredError([1, 2, 3], [null, null, null])).toBe(0);
  });
});

describe('residualStdDev', () => {
  it('divides the sum of squares by the usable count when no parameters were fitted', () => {
    // 1 + 1 + 4 + 4 = 10 over df = 4 -> sqrt(2.5) = 1.5811388300841898
    expect(residualStdDev([1, -1, 2, -2])).toBeCloseTo(1.5811388300841898, 12);
  });

  it('reduces the degrees of freedom by the parameters estimated', () => {
    // 10 over df = 4 - 2 = 2 -> sqrt(5) = 2.23606797749979
    expect(residualStdDev([1, -1, 2, -2], 2)).toBeCloseTo(2.23606797749979, 12);
  });

  it('ignores non-finite residuals when counting degrees of freedom', () => {
    // Same four usable residuals as above -> sqrt(10/4)
    expect(residualStdDev([1, -1, Number.NaN, 2, -2, Infinity])).toBeCloseTo(
      1.5811388300841898,
      12,
    );
  });

  it('returns 0 when the degrees of freedom are exhausted', () => {
    expect(residualStdDev([1, -1], 2)).toBe(0);
    expect(residualStdDev([1], 3)).toBe(0);
    expect(residualStdDev([])).toBe(0);
  });

  it('is 0 for zero residuals', () => {
    expect(residualStdDev([0, 0, 0])).toBe(0);
  });
});

describe('combineMetrics', () => {
  it('pools RMSE through the squares rather than averaging it', () => {
    // Fold A: n=2, RMSE 3 (mean squared error 9)
    // Fold B: n=2, RMSE 5 (mean squared error 25)
    // Pooled MSE = (9*2 + 25*2) / 4 = 68/4 = 17 -> RMSE = sqrt(17) = 4.123105625617661
    // A plain average would give 4, which is NOT a genuine RMSE.
    const combined = combineMetrics([
      fold({ n: 2, rmse: 3, mae: 3 }),
      fold({ n: 2, rmse: 5, mae: 5 }),
    ]);
    expect(combined.rmse).toBeCloseTo(4.123105625617661, 12);
    expect(combined.rmse).not.toBeCloseTo(4, 6);
  });

  it('weights the pooled RMSE by fold size', () => {
    // Fold A: n=3, RMSE 2 ; Fold B: n=1, RMSE 6
    // Pooled MSE = (4*3 + 36*1)/4 = 48/4 = 12 -> sqrt(12) = 3.4641016151377544
    const combined = combineMetrics([fold({ n: 3, rmse: 2 }), fold({ n: 1, rmse: 6 })]);
    expect(combined.rmse).toBeCloseTo(3.4641016151377544, 12);
  });

  it('averages MAE, sMAPE and bias weighted by fold size', () => {
    // MAE: (3*2 + 5*2)/4 = 4 ; sMAPE: (0.1*2 + 0.3*2)/4 = 0.2
    // bias: (2*2 + (-6)*2)/4 = -2
    const combined = combineMetrics([
      fold({ n: 2, mae: 3, smape: 0.1, bias: 2 }),
      fold({ n: 2, mae: 5, smape: 0.3, bias: -6 }),
    ]);
    expect(combined.mae).toBeCloseTo(4, 12);
    expect(combined.smape).toBeCloseTo(0.2, 12);
    expect(combined.bias).toBeCloseTo(-2, 12);
  });

  it('sums the observation counts', () => {
    expect(combineMetrics([fold({ n: 2 }), fold({ n: 5 })]).n).toBe(7);
  });

  it('keeps MAPE only when every fold defined it', () => {
    // (0.1*2 + 0.2*2)/4 = 0.15
    const defined = combineMetrics([fold({ n: 2, mape: 0.1 }), fold({ n: 2, mape: 0.2 })]);
    expect(defined.mape).toBeCloseTo(0.15, 12);

    const partial = combineMetrics([fold({ n: 2, mape: 0.1 }), fold({ n: 2, mape: null })]);
    expect(partial.mape).toBeNull();
  });

  it('averages MASE over just the folds that defined it', () => {
    // Only the two defined folds count: (0.5*2 + 1.5*2)/4 = 1
    const combined = combineMetrics([
      fold({ n: 2, mase: 0.5 }),
      fold({ n: 2, mase: 1.5 }),
      fold({ n: 4, mase: null }),
    ]);
    expect(combined.mase).toBeCloseTo(1, 12);
  });

  it('returns null MASE when no fold defined it', () => {
    expect(combineMetrics([fold({ n: 2 }), fold({ n: 3 })]).mase).toBeNull();
  });

  it('averages rSquared and biasPercent over the folds that defined them', () => {
    // rSquared: (0.9*1 + 0.5*3)/4 = 2.4/4 = 0.6
    // biasPercent: only the second fold defines it -> 0.04
    const combined = combineMetrics([
      fold({ n: 1, rSquared: 0.9 }),
      fold({ n: 3, rSquared: 0.5, biasPercent: 0.04 }),
    ]);
    expect(combined.rSquared).toBeCloseTo(0.6, 12);
    expect(combined.biasPercent).toBeCloseTo(0.04, 12);
  });

  it('ignores folds with no observations', () => {
    const combined = combineMetrics([
      fold({ n: 0, rmse: 1000, mae: 1000 }),
      fold({ n: 2, rmse: 3, mae: 3 }),
    ]);
    expect(combined.n).toBe(2);
    expect(combined.rmse).toBeCloseTo(3, 12);
    expect(combined.mae).toBeCloseTo(3, 12);
  });

  it('returns the empty metric block for no usable folds', () => {
    expect(combineMetrics([]).n).toBe(0);
    expect(combineMetrics([fold({ n: 0 })])).toEqual({
      mae: 0,
      rmse: 0,
      mape: null,
      smape: 0,
      mase: null,
      bias: 0,
      biasPercent: null,
      rSquared: null,
      n: 0,
    });
  });

  it('reproduces a single fold unchanged (to floating-point tolerance)', () => {
    const single = fold({ n: 3, mae: 2, rmse: 2.5, mape: 0.1, mase: 0.8, bias: -1 });
    const combined = combineMetrics([single]);
    expect(combined.n).toBe(3);
    expect(combined.mae).toBeCloseTo(2, 12);
    expect(combined.rmse).toBeCloseTo(2.5, 12);
    expect(combined.mape).toBeCloseTo(0.1, 12);
    expect(combined.mase).toBeCloseTo(0.8, 12);
    expect(combined.bias).toBeCloseTo(-1, 12);
    expect(combined.rSquared).toBeNull();
    expect(combined.biasPercent).toBeNull();
  });
});
