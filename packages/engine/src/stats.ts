/**
 * Statistical primitives shared by the forecasting and risk modules.
 *
 * Deliberately `number`-based rather than Decimal. These are estimators, not
 * ledger arithmetic: the uncertainty in any forecast is many orders of magnitude
 * larger than float64 error, and Decimal-based smoothing over 10k Monte Carlo
 * iterations would be unusably slow. Money crosses back into Decimal at the
 * module boundary - see `toMoneyString` in the result builders.
 */

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mean() requires at least one value');
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Sample variance (Bessel-corrected, n-1). Returns 0 for a single observation. */
export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - mu) ** 2;
  return ss / (values.length - 1);
}

export function stdDev(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

/**
 * Linear-interpolated quantile (the "type 7" definition used by R and NumPy).
 * `p` is a fraction in [0, 1]. Input need not be sorted.
 */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('quantile() requires at least one value');
  if (p < 0 || p > 1) throw new RangeError(`Quantile p must be in [0,1], got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lo = sorted[lower] as number;
  if (lower === upper) return lo;
  const hi = sorted[upper] as number;
  return lo + (hi - lo) * (pos - lower);
}

/**
 * Quantiles from an already-sorted array. Monte Carlo sorts once and reads many
 * percentiles off the same array, so this avoids re-sorting per level.
 */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('quantileSorted() requires at least one value');
  if (p < 0 || p > 1) throw new RangeError(`Quantile p must be in [0,1], got ${p}`);
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lo = sorted[lower] as number;
  if (lower === upper) return lo;
  const hi = sorted[upper] as number;
  return lo + (hi - lo) * (pos - lower);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** Pearson correlation. Returns 0 when either series is constant. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) throw new RangeError('correlation() requires equal-length series');
  if (xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Spearman rank correlation - the standard basis for Monte Carlo tornado charts,
 * because it captures monotonic influence without assuming linearity.
 */
export function rankCorrelation(xs: readonly number[], ys: readonly number[]): number {
  return correlation(rank(xs), rank(ys));
}

/** Average ranks, with ties sharing the mean of the positions they span. */
export function rank(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (
      j + 1 < indexed.length &&
      (indexed[j + 1] as { v: number }).v === (indexed[i] as { v: number }).v
    ) {
      j += 1;
    }
    const averaged = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[(indexed[k] as { i: number }).i] = averaged;
    i = j + 1;
  }
  return ranks;
}

/**
 * Inverse standard-normal CDF (probit).
 *
 * Acklam's rational approximation, refined by one Halley step against an
 * erfc-based CDF. Accurate to roughly 1e-15 across the open interval, which is
 * well beyond what confidence banding needs but costs almost nothing.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    throw new RangeError(`normalQuantile requires p in (0,1), got ${p}`);
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q +
        (c[3] as number)) *
        q +
        (c[4] as number)) *
        q +
        (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
        1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      (((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r +
        (a[3] as number)) *
        r +
        (a[4] as number)) *
        r +
        (a[5] as number)) *
        q) /
      ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r +
        (b[3] as number)) *
        r +
        (b[4] as number)) *
        r +
        1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(
        (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q +
          (c[3] as number)) *
          q +
          (c[4] as number)) *
          q +
        (c[5] as number)
      ) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
        1);
  }

  // One Halley refinement against the true CDF.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Standard normal CDF via a high-accuracy erfc approximation. */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Complementary error function (Numerical Recipes `erfcc`, ~1.2e-7 relative). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    // Trimmed to the digits a double can actually represent. The published
    // constants carry a couple more, and the discarded tail is ~1e-17 - far
    // below this approximation's own 1.2e-7 accuracy, but a literal that does
    // not round-trip is silently not the number it appears to be.
    -1.3026537197817, 6.419697923564902e-1, 1.9476473204185836e-2, -9.56151478680863e-3,
    -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12,
    8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j -= 1) {
    const tmp = d;
    d = ty * d - dd + (cof[j] as number);
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * ((cof[0] as number) + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/** Ordinary least squares fit of `y` on `x`. */
export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination. */
  rSquared: number;
  /** Residual standard error, with n-2 degrees of freedom. */
  residualStdError: number;
  meanX: number;
  sumSquaredDeviationsX: number;
  n: number;
}

export function linearRegression(xs: readonly number[], ys: readonly number[]): LinearFit {
  if (xs.length !== ys.length)
    throw new RangeError('linearRegression requires equal-length series');
  if (xs.length < 2) throw new RangeError('linearRegression requires at least two observations');

  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx;
    sxy += dx * ((ys[i] as number) - my);
    sxx += dx * dx;
  }

  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * (xs[i] as number);
    ssRes += ((ys[i] as number) - predicted) ** 2;
    ssTot += ((ys[i] as number) - my) ** 2;
  }

  return {
    slope,
    intercept,
    rSquared: ssTot === 0 ? (ssRes === 0 ? 1 : 0) : 1 - ssRes / ssTot,
    residualStdError: n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0,
    meanX: mx,
    sumSquaredDeviationsX: sxx,
    n,
  };
}

/** Clamp a number into [lo, hi]. */
export function clampNumber(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** True when every element is finite - guards against NaN propagating silently. */
export function allFinite(values: readonly number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}
