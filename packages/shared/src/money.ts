/**
 * Monetary arithmetic.
 *
 * Rule for this codebase: money is NEVER a JavaScript `number`. IEEE-754 cannot
 * represent 0.1 exactly, and budget rollups sum thousands of lines - the drift is
 * real and it shows up in variance reports as unexplained pennies.
 *
 * Everything here is built on decimal.js configured for financial precision, and
 * the canonical wire/storage format is a decimal *string*.
 */
// Named import, not default: under NodeNext resolution decimal.js's default
// export resolves to the module namespace rather than the class.
import { Decimal } from 'decimal.js';
import { DEFAULT_CURRENCY } from './domain.js';

/** 28 significant digits comfortably covers currency amounts and rate chains. */
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN, // banker's rounding: unbiased over many roundings
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export { Decimal };

/** Anything that can be coerced into a monetary value. */
export type MoneyInput = string | number | Decimal;

/** Canonical serialised money: a plain decimal string, e.g. "1234.5600". */
export type MoneyString = string;

/** Scale used for stored monetary amounts (matches the DB numeric(18,4)). */
export const MONEY_SCALE = 4;

/** Scale used for rates, percentages and factors (matches numeric(18,8)). */
export const RATE_SCALE = 8;

/** Rounding modes exposed to callers, mapped onto decimal.js constants. */
export const RoundingMode = {
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  HALF_UP: Decimal.ROUND_HALF_UP,
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  CEIL: Decimal.ROUND_CEIL,
  FLOOR: Decimal.ROUND_FLOOR,
} as const;

export type RoundingModeName = keyof typeof RoundingMode;

const NUMERIC_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Coerce a value to Decimal, rejecting anything that is not a finite number.
 *
 * `number` inputs are accepted but must be safe integers or have come from a
 * source we trust (quantities, hours, counts). Non-finite values throw rather
 * than silently becoming NaN and poisoning a whole rollup.
 */
export function toDecimal(value: MoneyInput): Decimal {
  if (value instanceof Decimal) {
    if (!value.isFinite()) throw new TypeError(`Non-finite decimal: ${value.toString()}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number: ${value}`);
    return new Decimal(value);
  }
  const trimmed = value.trim();
  if (trimmed === '' || !NUMERIC_RE.test(trimmed)) {
    throw new TypeError(`Not a valid decimal string: "${value}"`);
  }
  return new Decimal(trimmed);
}

/** Alias that reads better at call sites dealing with currency. */
export const money = toDecimal;

/** Zero, at money scale. */
export function zero(): Decimal {
  return new Decimal(0);
}

/** Round to the canonical money scale (4 dp, banker's rounding). */
export function roundMoney(
  value: MoneyInput,
  scale: number = MONEY_SCALE,
  mode: RoundingModeName = 'HALF_EVEN',
): Decimal {
  return toDecimal(value).toDecimalPlaces(scale, RoundingMode[mode]);
}

/** Round to the canonical rate scale (8 dp). */
export function roundRate(value: MoneyInput, scale: number = RATE_SCALE): Decimal {
  return toDecimal(value).toDecimalPlaces(scale, RoundingMode.HALF_EVEN);
}

/** Serialise for storage/transport: fixed-scale decimal string. */
export function toMoneyString(value: MoneyInput, scale: number = MONEY_SCALE): MoneyString {
  return roundMoney(value, scale).toFixed(scale);
}

/** Serialise a rate for storage/transport. */
export function toRateString(value: MoneyInput, scale: number = RATE_SCALE): MoneyString {
  return roundRate(value, scale).toFixed(scale);
}

/**
 * Convert to `number` for charting / statistical work only.
 * Never round-trip money through this on the way back into a ledger.
 */
export function toNumber(value: MoneyInput): number {
  return toDecimal(value).toNumber();
}

// --------------------------------------------------------------------------
// Arithmetic
// --------------------------------------------------------------------------

export function add(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));
}

export function subtract(a: MoneyInput, b: MoneyInput): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

export function multiply(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.times(toDecimal(v)), new Decimal(1));
}

/** Division that refuses to produce Infinity. Returns `fallback` when divisor is 0. */
export function divide(a: MoneyInput, b: MoneyInput, fallback: Decimal | null = null): Decimal {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    if (fallback === null) throw new RangeError('Division by zero');
    return fallback;
  }
  return toDecimal(a).dividedBy(divisor);
}

/** Sum a collection, optionally projecting each element first. */
export function sum<T>(items: readonly T[], selector: (item: T) => MoneyInput): Decimal;
export function sum(items: readonly MoneyInput[]): Decimal;
export function sum<T>(items: readonly T[], selector?: (item: T) => MoneyInput): Decimal {
  return items.reduce<Decimal>(
    (acc, item) => acc.plus(toDecimal(selector ? selector(item) : (item as MoneyInput))),
    new Decimal(0),
  );
}

export function negate(value: MoneyInput): Decimal {
  return toDecimal(value).negated();
}

export function abs(value: MoneyInput): Decimal {
  return toDecimal(value).abs();
}

export function min(...values: MoneyInput[]): Decimal {
  if (values.length === 0) throw new RangeError('min() requires at least one value');
  return values.map(toDecimal).reduce((a, b) => (a.lessThan(b) ? a : b));
}

export function max(...values: MoneyInput[]): Decimal {
  if (values.length === 0) throw new RangeError('max() requires at least one value');
  return values.map(toDecimal).reduce((a, b) => (a.greaterThan(b) ? a : b));
}

// --------------------------------------------------------------------------
// Percentages and rates
// --------------------------------------------------------------------------

/** `applyRate(1000, 0.325)` -> 325. Rate is a fraction, not a percent. */
export function applyRate(base: MoneyInput, rate: MoneyInput): Decimal {
  return toDecimal(base).times(toDecimal(rate));
}

/** `grossUp(1000, 0.325)` -> 1325. Base plus the burden the rate represents. */
export function grossUp(base: MoneyInput, rate: MoneyInput): Decimal {
  return toDecimal(base).times(toDecimal(rate).plus(1));
}

/** Fraction -> percent, e.g. 0.0725 -> 7.25. */
export function toPercent(rate: MoneyInput): Decimal {
  return toDecimal(rate).times(100);
}

/** Percent -> fraction, e.g. 7.25 -> 0.0725. */
export function fromPercent(percent: MoneyInput): Decimal {
  return toDecimal(percent).dividedBy(100);
}

/**
 * Percentage change from `base` to `value`, as a fraction.
 * Returns null when the base is zero - "infinite % variance" is noise in a report.
 */
export function percentChange(base: MoneyInput, value: MoneyInput): Decimal | null {
  const b = toDecimal(base);
  if (b.isZero()) return null;
  return toDecimal(value).minus(b).dividedBy(b.abs());
}

/**
 * Compound escalation factor: `(1 + rate) ^ periods`.
 * Used for multi-year labour escalation and inflation indexing.
 */
export function escalationFactor(rate: MoneyInput, periods: number): Decimal {
  if (!Number.isInteger(periods)) {
    throw new TypeError(`escalationFactor periods must be an integer, got ${periods}`);
  }
  return toDecimal(rate).plus(1).pow(periods);
}

// --------------------------------------------------------------------------
// Allocation
// --------------------------------------------------------------------------

/**
 * Split an amount across `parts` without losing or inventing a cent.
 *
 * The naive `amount / n` rounded per-part leaks money. This distributes the
 * rounding remainder one minor unit at a time across the earliest parts, so the
 * result always sums exactly back to `amount`.
 */
export function allocateEvenly(
  amount: MoneyInput,
  parts: number,
  scale: number = MONEY_SCALE,
): Decimal[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`allocateEvenly requires a positive integer part count, got ${parts}`);
  }
  const total = roundMoney(amount, scale);
  const unit = new Decimal(10).pow(-scale);
  const totalUnits = total.dividedBy(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
  const baseUnits = totalUnits.dividedBy(parts).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  let remainder = totalUnits.minus(baseUnits.times(parts));
  const step = remainder.isNegative() ? new Decimal(-1) : new Decimal(1);

  const out: Decimal[] = [];
  for (let i = 0; i < parts; i += 1) {
    let units = baseUnits;
    if (!remainder.isZero()) {
      units = units.plus(step);
      remainder = remainder.minus(step);
    }
    out.push(units.times(unit).toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN));
  }
  return out;
}

/**
 * Split an amount in proportion to `weights`, preserving the exact total.
 *
 * Uses largest-remainder: allocate the floor of each share, then hand out the
 * leftover minor units to whichever parts were rounded down hardest. This is the
 * standard approach for apportioning a budget across cost centres.
 */
export function allocateByWeights(
  amount: MoneyInput,
  weights: readonly MoneyInput[],
  scale: number = MONEY_SCALE,
): Decimal[] {
  if (weights.length === 0) throw new RangeError('allocateByWeights requires at least one weight');

  const decWeights = weights.map(toDecimal);
  if (decWeights.some((w) => w.isNegative())) {
    throw new RangeError('allocateByWeights does not accept negative weights');
  }
  const totalWeight = decWeights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (totalWeight.isZero()) return allocateEvenly(amount, weights.length, scale);

  const total = roundMoney(amount, scale);
  const unit = new Decimal(10).pow(-scale);
  const totalUnits = total.dividedBy(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);

  const exact = decWeights.map((w) => totalUnits.times(w).dividedBy(totalWeight));
  const floored = exact.map((e) => e.toDecimalPlaces(0, Decimal.ROUND_FLOOR));
  let leftover = totalUnits.minus(floored.reduce((a, b) => a.plus(b), new Decimal(0)));

  const order = exact
    .map((e, i) => ({ i, frac: e.minus(floored[i] as Decimal) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);

  const result = [...floored];
  const step = leftover.isNegative() ? new Decimal(-1) : new Decimal(1);
  let cursor = 0;
  while (!leftover.isZero() && order.length > 0) {
    const target = order[cursor % order.length] as { i: number };
    result[target.i] = (result[target.i] as Decimal).plus(step);
    leftover = leftover.minus(step);
    cursor += 1;
  }

  return result.map((units) => units.times(unit).toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN));
}

// --------------------------------------------------------------------------
// Comparison helpers
// --------------------------------------------------------------------------

export function isZero(value: MoneyInput, tolerance: MoneyInput = '0'): boolean {
  return toDecimal(value).abs().lessThanOrEqualTo(toDecimal(tolerance));
}

export function equals(a: MoneyInput, b: MoneyInput, tolerance: MoneyInput = '0'): boolean {
  return toDecimal(a).minus(toDecimal(b)).abs().lessThanOrEqualTo(toDecimal(tolerance));
}

export function isNegative(value: MoneyInput): boolean {
  return toDecimal(value).isNegative() && !toDecimal(value).isZero();
}

export function isPositive(value: MoneyInput): boolean {
  return toDecimal(value).greaterThan(0);
}

export function compare(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  return toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1;
}

/** Clamp into [lower, upper]. */
export function clamp(value: MoneyInput, lower: MoneyInput, upper: MoneyInput): Decimal {
  const lo = toDecimal(lower);
  const hi = toDecimal(upper);
  if (lo.greaterThan(hi)) throw new RangeError('clamp lower bound exceeds upper bound');
  return max(lo, min(hi, value));
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

export interface FormatMoneyOptions {
  currency?: string;
  locale?: string;
  /** Render in thousands ("K") or millions ("M") - standard in board packs. */
  scaleUnit?: 'none' | 'thousands' | 'millions';
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  /** Wrap negatives in parentheses, as finance reports conventionally do. */
  accountingNegatives?: boolean;
}

const SCALE_DIVISORS: Record<NonNullable<FormatMoneyOptions['scaleUnit']>, [number, string]> = {
  none: [1, ''],
  thousands: [1_000, 'K'],
  millions: [1_000_000, 'M'],
};

export function formatMoney(value: MoneyInput, options: FormatMoneyOptions = {}): string {
  const {
    currency = DEFAULT_CURRENCY,
    // Presentation locale, distinct from the currency: a euro amount shown to a
    // German reader is the same money formatted differently. Callers that know
    // the reader should pass theirs; this is only the fallback.
    locale = 'en-US',
    scaleUnit = 'none',
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    accountingNegatives = false,
  } = options;

  const [divisor, suffix] = SCALE_DIVISORS[scaleUnit];
  const scaled = toDecimal(value).dividedBy(divisor);
  const negative = scaled.isNegative();
  const magnitude = scaled.abs().toNumber();

  // Intl.NumberFormat throws if minimum > maximum. Callers commonly lower only
  // the maximum ("whole currency units please") and would otherwise hit a
  // RangeError against the default minimum of 2. The explicit maximum wins and
  // the minimum is clamped down to it, which is what such a caller meant.
  const maxDigits = maximumFractionDigits;
  const minDigits = Math.min(minimumFractionDigits, maxDigits);

  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
    // Match the arithmetic. Every calculation in the platform rounds
    // half-to-even, but Intl defaults to half-expand, so a displayed figure
    // disagreed with the stored one on exact ties: 0.125 showed as 0.13 where
    // the engine rounds it to 0.12. Small, and exactly the kind of penny
    // discrepancy that costs an afternoon in a reconciliation meeting.
    //
    // Engines without Intl.NumberFormat v3 ignore an unrecognised option
    // rather than throwing, so this degrades to the old behaviour rather than
    // breaking.
    roundingMode: 'halfEven',
  }).format(magnitude);

  const withSuffix = suffix ? `${formatted}${suffix}` : formatted;
  if (!negative) return withSuffix;
  return accountingNegatives ? `(${withSuffix})` : `-${withSuffix}`;
}

export function formatPercent(
  rate: MoneyInput,
  { locale = 'en-US', fractionDigits = 1 }: { locale?: string; fractionDigits?: number } = {},
): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    // Half-to-even here too, for the same reason as formatMoney above.
    roundingMode: 'halfEven',
  }).format(toDecimal(rate).toNumber());
}
