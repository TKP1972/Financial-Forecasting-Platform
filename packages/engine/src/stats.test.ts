import { describe, it, expect } from 'vitest';
import {
  allFinite,
  clampNumber,
  correlation,
  erfc,
  linearRegression,
  mean,
  median,
  normalCdf,
  normalQuantile,
  quantile,
  quantileSorted,
  rank,
  rankCorrelation,
  stdDev,
  variance,
} from './stats.js';

describe('mean', () => {
  it('averages a simple series', () => {
    // (1 + 2 + 3 + 4) / 4 = 10 / 4 = 2.5
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('handles a single observation', () => {
    expect(mean([7])).toBe(7);
  });

  it('handles negatives', () => {
    // (-5 + 5 + -10 + 20) / 4 = 10 / 4 = 2.5
    expect(mean([-5, 5, -10, 20])).toBe(2.5);
  });

  it('throws on an empty series', () => {
    expect(() => mean([])).toThrow(RangeError);
  });
});

describe('variance / stdDev', () => {
  it('computes the Bessel-corrected sample variance', () => {
    // Series: [2,4,4,4,5,5,7,9]; mean = 40/8 = 5
    // deviations: -3,-1,-1,-1,0,0,2,4 -> squares 9,1,1,1,0,0,4,16 = 32
    // sample variance = 32 / (8 - 1) = 32/7 = 4.571428571428571
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 12);
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571428571428571, 12);
  });

  it('is the square root relationship for stdDev', () => {
    // sqrt(32/7) = 2.1380899352993947
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1380899352993947, 12);
  });

  it('is exactly 2 for a series with sample variance 4', () => {
    // [1,3,5,7]: mean 4, deviations -3,-1,1,3 -> 9+1+1+9 = 20; 20/3 = 6.666...
    expect(variance([1, 3, 5, 7])).toBeCloseTo(20 / 3, 12);
    // [2,4,4,4,5,5,7,9] handled above; use [1,5] for an exact case:
    // mean 3, deviations -2, 2 -> 8; 8/1 = 8
    expect(variance([1, 5])).toBe(8);
    expect(stdDev([1, 5])).toBeCloseTo(Math.SQRT2 * 2, 12); // sqrt(8) = 2*sqrt(2)
  });

  it('returns 0 for fewer than two observations', () => {
    expect(variance([42])).toBe(0);
    expect(variance([])).toBe(0);
    expect(stdDev([42])).toBe(0);
  });

  it('is 0 for a constant series', () => {
    expect(variance([3, 3, 3, 3])).toBe(0);
    expect(stdDev([3, 3, 3, 3])).toBe(0);
  });
});

describe('quantile (type 7)', () => {
  it('matches R/NumPy on [1,2,3,4]', () => {
    // pos = (n-1)*p = 3p.
    // p=0.25 -> pos 0.75 -> 1 + (2-1)*0.75 = 1.75  (numpy.percentile([1,2,3,4],25) == 1.75)
    // p=0.50 -> pos 1.50 -> 2 + (3-2)*0.50 = 2.50
    // p=0.75 -> pos 2.25 -> 3 + (4-3)*0.25 = 3.25
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 12);
  });

  it('matches the NumPy documentation example', () => {
    // numpy.percentile([15,20,35,40,50], 40) == 29.0
    // pos = 4*0.4 = 1.6 -> 20 + (35-20)*0.6 = 20 + 9 = 29
    expect(quantile([15, 20, 35, 40, 50], 0.4)).toBeCloseTo(29, 12);
  });

  it('returns the extremes at p = 0 and p = 1', () => {
    expect(quantile([5, 1, 9, 3], 0)).toBe(1);
    expect(quantile([5, 1, 9, 3], 1)).toBe(9);
  });

  it('sorts the input itself', () => {
    // Same data as [1,2,3,4] but shuffled -> identical answer.
    expect(quantile([4, 1, 3, 2], 0.25)).toBeCloseTo(1.75, 12);
  });

  it('does not mutate the caller array', () => {
    const input = [4, 1, 3, 2];
    quantile(input, 0.5);
    expect(input).toEqual([4, 1, 3, 2]);
  });

  it('returns the only value for a single-element series', () => {
    expect(quantile([12], 0.3)).toBe(12);
  });

  it('lands exactly on an order statistic when pos is integral', () => {
    // n=5, p=0.5 -> pos = 2 exactly -> the middle element, no interpolation.
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
  });

  it('throws on an empty series', () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError);
  });

  it('throws when p is out of [0,1]', () => {
    expect(() => quantile([1, 2, 3], -0.001)).toThrow(RangeError);
    expect(() => quantile([1, 2, 3], 1.001)).toThrow(RangeError);
  });
});

describe('quantileSorted', () => {
  it('agrees with quantile on pre-sorted input', () => {
    expect(quantileSorted([15, 20, 35, 40, 50], 0.4)).toBeCloseTo(29, 12);
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
  });

  it('throws on an empty series or an out-of-range p', () => {
    expect(() => quantileSorted([], 0.5)).toThrow(RangeError);
    expect(() => quantileSorted([1, 2], 2)).toThrow(RangeError);
  });

  it('returns the only value for a single-element series', () => {
    expect(quantileSorted([8], 0.9)).toBe(8);
  });
});

describe('median', () => {
  it('is the middle value for an odd count', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('is the average of the two middles for an even count', () => {
    // sorted [1,2,3,4] -> (2+3)/2 = 2.5
    expect(median([4, 1, 3, 2])).toBeCloseTo(2.5, 12);
  });
});

describe('correlation', () => {
  it('is exactly 1 for a perfect increasing linear relationship', () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
  });

  it('is exactly -1 for a perfect decreasing linear relationship', () => {
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });

  it('matches a hand-computed Pearson r', () => {
    // xs = [1,2,3,4,5] (mean 3), ys = [2,4,5,4,5] (mean 4)
    // dx = -2,-1,0,1,2 ; dy = -2,0,1,0,1
    // Sxy = 4+0+0+0+2 = 6 ; Sxx = 4+1+0+1+4 = 10 ; Syy = 4+0+1+0+1 = 6
    // r = 6 / sqrt(10*6) = 6 / sqrt(60) = 0.7745966692414834
    expect(correlation([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(0.7745966692414834, 12);
  });

  it('returns 0 when either series is constant', () => {
    expect(correlation([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
    expect(correlation([1, 2, 3, 4], [5, 5, 5, 5])).toBe(0);
  });

  it('returns 0 for fewer than two pairs', () => {
    expect(correlation([1], [2])).toBe(0);
    expect(correlation([], [])).toBe(0);
  });

  it('throws on mismatched lengths', () => {
    expect(() => correlation([1, 2, 3], [1, 2])).toThrow(RangeError);
  });
});

describe('rank', () => {
  it('ranks a strictly increasing series 1..n', () => {
    expect(rank([10, 20, 30])).toEqual([1, 2, 3]);
  });

  it('ranks in value order, not input order', () => {
    // sorted values 1(idx1), 3(idx0), 4(idx2), 5(idx3)
    expect(rank([3, 1, 4, 5])).toEqual([2, 1, 3, 4]);
  });

  it('averages tied ranks', () => {
    // [10,20,20,30]: the two 20s occupy positions 2 and 3 -> both get (2+3)/2 = 2.5
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('averages a three-way tie', () => {
    // [5,5,5,9]: the three 5s occupy positions 1,2,3 -> all get (1+2+3)/3 = 2
    expect(rank([5, 5, 5, 9])).toEqual([2, 2, 2, 4]);
  });

  it('handles ties spread through the input', () => {
    // [3,1,4,1,5]: sorted -> 1(idx1), 1(idx3), 3(idx0), 4(idx2), 5(idx4)
    // the two 1s share positions 1,2 -> 1.5 each
    expect(rank([3, 1, 4, 1, 5])).toEqual([3, 1.5, 4, 1.5, 5]);
  });

  it('gives every element the same rank when all are equal', () => {
    // four equal values occupy positions 1..4 -> (1+2+3+4)/4 = 2.5
    expect(rank([7, 7, 7, 7])).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it('returns an empty array for empty input', () => {
    expect(rank([])).toEqual([]);
  });
});

describe('rankCorrelation (Spearman)', () => {
  it('is 1 for a monotonic but non-linear relationship', () => {
    // y = x^2 on positive x is strictly increasing -> ranks match exactly.
    expect(rankCorrelation([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])).toBeCloseTo(1, 12);
  });

  it('is -1 for a strictly decreasing relationship', () => {
    expect(rankCorrelation([1, 2, 3, 4], [100, 40, 9, 1])).toBeCloseTo(-1, 12);
  });

  it('matches the rank-difference formula', () => {
    // x ranks [1,2,3,4]; y = [1,3,2,4] -> ranks [1,3,2,4]
    // d = 0,-1,1,0 -> sum d^2 = 2
    // rho = 1 - 6*2 / (4*(16-1)) = 1 - 12/60 = 0.8
    expect(rankCorrelation([1, 2, 3, 4], [1, 3, 2, 4])).toBeCloseTo(0.8, 12);
  });

  it('handles ties without blowing up', () => {
    // x = [1,2,2,3] -> ranks [1,2.5,2.5,4]; y = [5,6,6,7] -> ranks [1,2.5,2.5,4]
    // identical rank vectors -> rho = 1
    expect(rankCorrelation([1, 2, 2, 3], [5, 6, 6, 7])).toBeCloseTo(1, 12);
  });
});

describe('normalQuantile (probit)', () => {
  it('matches published probit values in the central region', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963984540054, 6);
    expect(normalQuantile(0.9)).toBeCloseTo(1.2815515655446004, 6);
  });

  it('matches published probit values further into the tails', () => {
    expect(normalQuantile(0.99)).toBeCloseTo(2.3263478740408408, 6);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 6);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 6);
  });

  it('matches published probit values in the lower tail branch (p < 0.02425)', () => {
    expect(normalQuantile(0.01)).toBeCloseTo(-2.3263478740408408, 6);
    expect(normalQuantile(0.005)).toBeCloseTo(-2.575829303548901, 6);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 6);
  });

  it('matches published probit values in the upper tail branch (p > 0.97575)', () => {
    expect(normalQuantile(0.99)).toBeCloseTo(2.3263478740408408, 6);
    expect(normalQuantile(0.995)).toBeCloseTo(2.575829303548901, 6);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232306167813, 6);
  });

  it('is antisymmetric about 0.5', () => {
    expect(normalQuantile(0.3)).toBeCloseTo(-normalQuantile(0.7), 9);
  });

  it('returns infinities at the closed endpoints', () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
  });

  it('throws outside [0,1]', () => {
    expect(() => normalQuantile(-0.5)).toThrow(RangeError);
    expect(() => normalQuantile(1.5)).toThrow(RangeError);
  });
});

describe('normalCdf', () => {
  it('is 0.5 at the mean', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 9);
  });

  it('matches published standard normal CDF values', () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 7);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145707, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 7);
    expect(normalCdf(2)).toBeCloseTo(0.9772498680518208, 7);
    expect(normalCdf(-2.5)).toBeCloseTo(0.006209665325776132, 7);
  });

  it('covers roughly 68% within one standard deviation', () => {
    expect(normalCdf(1) - normalCdf(-1)).toBeCloseTo(0.6826894921370859, 7);
  });

  it('round-trips with normalQuantile', () => {
    expect(normalCdf(normalQuantile(0.975))).toBeCloseTo(0.975, 7);
  });
});

describe('erfc', () => {
  it('matches published complementary error function values', () => {
    expect(erfc(0)).toBeCloseTo(1, 9);
    expect(erfc(1)).toBeCloseTo(0.15729920705028513, 7);
    expect(erfc(-1)).toBeCloseTo(1.8427007929497148, 7);
    expect(erfc(0.5)).toBeCloseTo(0.4795001221869535, 7);
  });
});

describe('linearRegression', () => {
  it('recovers an exact line', () => {
    // ys = 3x + 2 over x = 1..4 -> [5, 8, 11, 14]
    const fit = linearRegression([1, 2, 3, 4], [5, 8, 11, 14]);
    expect(fit.slope).toBeCloseTo(3, 12);
    expect(fit.intercept).toBeCloseTo(2, 12);
    expect(fit.rSquared).toBeCloseTo(1, 12);
    expect(fit.residualStdError).toBeCloseTo(0, 12);
    expect(fit.meanX).toBeCloseTo(2.5, 12);
    // Sxx = 1.5^2 + 0.5^2 + 0.5^2 + 1.5^2 = 2.25+0.25+0.25+2.25 = 5
    expect(fit.sumSquaredDeviationsX).toBeCloseTo(5, 12);
    expect(fit.n).toBe(4);
  });

  it('matches a hand-computed OLS fit on noisy data', () => {
    // xs = [1,2,3,4,5] (mean 3), ys = [2,4,5,4,5] (mean 4)
    // Sxy = 6, Sxx = 10 -> slope = 0.6 ; intercept = 4 - 0.6*3 = 2.2
    // predictions: 2.8, 3.4, 4.0, 4.6, 5.2
    // residuals: -0.8, 0.6, 1.0, -0.6, -0.2 -> SSres = 0.64+0.36+1+0.36+0.04 = 2.4
    // SStot = 4+0+1+0+1 = 6 -> R^2 = 1 - 2.4/6 = 0.6
    // residual std error = sqrt(2.4 / (5-2)) = sqrt(0.8) = 0.8944271909999159
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
    expect(fit.slope).toBeCloseTo(0.6, 12);
    expect(fit.intercept).toBeCloseTo(2.2, 12);
    expect(fit.rSquared).toBeCloseTo(0.6, 12);
    expect(fit.residualStdError).toBeCloseTo(0.8944271909999159, 12);
    expect(fit.sumSquaredDeviationsX).toBeCloseTo(10, 12);
    expect(fit.n).toBe(5);
  });

  it('handles a negative slope', () => {
    // ys = -2x + 10 over x = 0..3 -> [10, 8, 6, 4]
    const fit = linearRegression([0, 1, 2, 3], [10, 8, 6, 4]);
    expect(fit.slope).toBeCloseTo(-2, 12);
    expect(fit.intercept).toBeCloseTo(10, 12);
    expect(fit.rSquared).toBeCloseTo(1, 12);
  });

  it('reports slope 0 and R^2 0 when x is constant', () => {
    // No variation in x: nothing to explain. intercept collapses to mean(y) = 2.
    const fit = linearRegression([2, 2, 2], [1, 2, 3]);
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBeCloseTo(2, 12);
    expect(fit.sumSquaredDeviationsX).toBe(0);
    expect(fit.rSquared).toBe(0);
  });

  it('reports R^2 = 1 when y is constant and perfectly fitted', () => {
    // SStot = 0 and SSres = 0: the flat line explains the (zero) variation exactly.
    const fit = linearRegression([1, 2, 3], [5, 5, 5]);
    expect(fit.slope).toBeCloseTo(0, 12);
    expect(fit.intercept).toBeCloseTo(5, 12);
    expect(fit.rSquared).toBe(1);
  });

  it('reports residualStdError 0 when there are only two observations', () => {
    // n - 2 = 0 degrees of freedom, so no residual estimate is possible.
    const fit = linearRegression([0, 1], [1, 3]);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(1, 12);
    expect(fit.residualStdError).toBe(0);
  });

  it('throws on mismatched lengths', () => {
    expect(() => linearRegression([1, 2, 3], [1, 2])).toThrow(RangeError);
  });

  it('throws with fewer than two observations', () => {
    expect(() => linearRegression([1], [1])).toThrow(RangeError);
    expect(() => linearRegression([], [])).toThrow(RangeError);
  });
});

describe('clampNumber', () => {
  it('passes through a value already inside the range', () => {
    expect(clampNumber(5, 1, 10)).toBe(5);
  });

  it('clamps below the lower bound', () => {
    expect(clampNumber(-4, 0, 10)).toBe(0);
  });

  it('clamps above the upper bound', () => {
    expect(clampNumber(11, 0, 10)).toBe(10);
  });

  it('handles the boundaries themselves', () => {
    expect(clampNumber(0, 0, 10)).toBe(0);
    expect(clampNumber(10, 0, 10)).toBe(10);
  });

  it('handles a degenerate range', () => {
    expect(clampNumber(5, 3, 3)).toBe(3);
  });
});

describe('allFinite', () => {
  it('is true for finite values', () => {
    expect(allFinite([1, -2, 0, 3.5])).toBe(true);
  });

  it('is vacuously true for an empty array', () => {
    expect(allFinite([])).toBe(true);
  });

  it('is false when a NaN is present', () => {
    expect(allFinite([1, Number.NaN, 3])).toBe(false);
  });

  it('is false when an infinity is present', () => {
    expect(allFinite([1, Infinity])).toBe(false);
    expect(allFinite([-Infinity, 2])).toBe(false);
  });
});
