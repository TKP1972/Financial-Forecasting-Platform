/**
 * Unit tests for the monetary arithmetic layer.
 *
 * Every expected value below is derived by hand in the accompanying comment.
 * Nothing here was produced by executing the code under test.
 */
import { describe, it, expect } from 'vitest';
import {
  Decimal,
  MONEY_SCALE,
  RATE_SCALE,
  abs,
  add,
  allocateByWeights,
  allocateEvenly,
  applyRate,
  clamp,
  compare,
  divide,
  equals,
  escalationFactor,
  formatMoney,
  formatPercent,
  fromPercent,
  grossUp,
  isNegative,
  isPositive,
  isZero,
  max,
  min,
  money,
  multiply,
  negate,
  percentChange,
  roundMoney,
  roundRate,
  subtract,
  sum,
  toDecimal,
  toMoneyString,
  toNumber,
  toPercent,
  toRateString,
  zero,
} from './money.js';

/** Convenience: exact string equality at a chosen scale. */
const s = (v: Parameters<typeof toMoneyString>[0], scale?: number) => toMoneyString(v, scale);

describe('toDecimal', () => {
  it('rejects non-finite numbers', () => {
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => toDecimal(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(/Non-finite number/);
  });

  it('rejects NaN', () => {
    expect(() => toDecimal(Number.NaN)).toThrow(TypeError);
  });

  it('rejects a non-finite Decimal instance', () => {
    expect(() => toDecimal(new Decimal(Number.NaN))).toThrow(/Non-finite decimal/);
    expect(() => toDecimal(new Decimal(Number.POSITIVE_INFINITY))).toThrow(/Non-finite decimal/);
  });

  it('rejects the empty string and whitespace-only strings', () => {
    expect(() => toDecimal('')).toThrow(TypeError);
    expect(() => toDecimal('   ')).toThrow(/Not a valid decimal string/);
  });

  it("rejects '12abc'", () => {
    expect(() => toDecimal('12abc')).toThrow(/Not a valid decimal string/);
  });

  it("rejects '1.2.3'", () => {
    expect(() => toDecimal('1.2.3')).toThrow(/Not a valid decimal string/);
  });

  it('rejects other near-miss numeric strings', () => {
    // The regex is ^-?(\d+(\.\d*)?|\.\d+)$ - no exponents, no separators, no plus sign.
    for (const bad of ['1e5', '1,000', '+1', '--1', '.', '-', '0x10', 'NaN', 'Infinity']) {
      expect(() => toDecimal(bad), bad).toThrow(TypeError);
    }
  });

  it("accepts '.5' as one half", () => {
    // '.5' matches the \.\d+ branch of the regex.
    expect(toDecimal('.5').toString()).toBe('0.5');
    expect(s(toDecimal('.5'))).toBe('0.5000');
  });

  it("accepts '-0.25'", () => {
    expect(s('-0.25')).toBe('-0.2500');
  });

  it('accepts integers, both as strings and as numbers', () => {
    expect(s('42')).toBe('42.0000');
    expect(s(42)).toBe('42.0000');
    expect(s('-7')).toBe('-7.0000');
    expect(s(0)).toBe('0.0000');
  });

  it('accepts a trailing decimal point, e.g. "12."', () => {
    // \d+(\.\d*)? permits an empty fractional part.
    expect(s('12.')).toBe('12.0000');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(s('  123.45  ')).toBe('123.4500');
  });

  it('passes a finite Decimal straight through (identity)', () => {
    const d = new Decimal('1.5');
    expect(toDecimal(d)).toBe(d);
  });

  it('exposes `money` as an alias of toDecimal', () => {
    expect(money).toBe(toDecimal);
  });
});

describe('float safety', () => {
  it("add('0.1','0.2') is exactly 0.3, not 0.30000000000000004", () => {
    // IEEE-754: 0.1 + 0.2 === 0.30000000000000004. Decimal arithmetic must not.
    expect(toMoneyString(add('0.1', '0.2'))).toBe('0.3000');
    expect(add('0.1', '0.2').equals(new Decimal('0.3'))).toBe(true);
    // Sanity check that the float hazard being guarded against is real.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('sums a long series of thirds without drift', () => {
    // 0.01 added 100 times = exactly 1.00
    const parts = Array.from({ length: 100 }, () => '0.01');
    expect(toMoneyString(add(...parts))).toBe('1.0000');
  });

  it('subtract is exact for values a float would fumble', () => {
    // 1.005 - 1.00 = 0.005 exactly
    expect(s(subtract('1.005', '1.00'))).toBe('0.0050');
  });
});

describe('basic arithmetic', () => {
  it('zero() is 0', () => {
    expect(zero().isZero()).toBe(true);
  });

  it('add() of nothing is 0 (identity element)', () => {
    expect(s(add())).toBe('0.0000');
  });

  it('multiply() of nothing is 1 (identity element)', () => {
    expect(s(multiply())).toBe('1.0000');
  });

  it('multiply chains exactly: 2.5 * 4 * 0.1 = 1', () => {
    expect(s(multiply('2.5', '4', '0.1'))).toBe('1.0000');
  });

  it('negate and abs', () => {
    expect(s(negate('12.34'))).toBe('-12.3400');
    expect(s(abs('-12.34'))).toBe('12.3400');
    expect(s(abs('12.34'))).toBe('12.3400');
  });

  it('min/max pick the extremes and throw when given nothing', () => {
    expect(s(min('3', '-1', '7'))).toBe('-1.0000');
    expect(s(max('3', '-1', '7'))).toBe('7.0000');
    expect(() => min()).toThrow(RangeError);
    expect(() => max()).toThrow(RangeError);
  });

  it('sum() over a bare list and over a projection', () => {
    expect(s(sum(['1.10', '2.20', '3.30']))).toBe('6.6000');
    const rows = [{ v: '10.005' }, { v: '20.005' }];
    // 10.005 + 20.005 = 30.010
    expect(s(sum(rows, (r) => r.v))).toBe('30.0100');
    expect(s(sum([]))).toBe('0.0000');
  });

  it('toNumber converts for charting', () => {
    expect(toNumber('1234.5')).toBe(1234.5);
  });
});

describe('divide', () => {
  it('divides normally', () => {
    // 1000 / 8 = 125
    expect(s(divide('1000', '8'))).toBe('125.0000');
  });

  it('throws on a zero divisor when no fallback is supplied', () => {
    expect(() => divide('1000', '0')).toThrow(RangeError);
    expect(() => divide('1000', '0')).toThrow(/Division by zero/);
    expect(() => divide('0', 0)).toThrow(RangeError);
  });

  it('returns the fallback instead of throwing when one is supplied', () => {
    expect(s(divide('1000', '0', new Decimal(0)))).toBe('0.0000');
    expect(s(divide('1000', '0', new Decimal('-1')))).toBe('-1.0000');
  });

  it('never produces Infinity', () => {
    const result = divide('1000', '0', new Decimal(0));
    expect(result.isFinite()).toBe(true);
  });
});

describe('roundMoney - banker’s rounding', () => {
  it("rounds 0.125 down to '0.12' (half-to-EVEN, not half-up)", () => {
    // 0.125 sits exactly on the boundary. The digit before it is 2 (even),
    // so ROUND_HALF_EVEN keeps it: 0.12.  Half-up would give 0.13.
    expect(toMoneyString('0.125', 2)).toBe('0.12');
    expect(roundMoney('0.125', 2).toFixed(2)).toBe('0.12');
  });

  it("rounds 0.135 up to '0.14' (half-to-EVEN)", () => {
    // Boundary again; preceding digit is 3 (odd), so it rounds up to the even 4.
    expect(toMoneyString('0.135', 2)).toBe('0.14');
  });

  it("rounds 0.145 down to '0.14', proving it is not half-up", () => {
    // Preceding digit 4 is even -> stays. Half-up would give 0.15.
    expect(toMoneyString('0.145', 2)).toBe('0.14');
  });

  it('honours an explicit HALF_UP override', () => {
    expect(roundMoney('0.125', 2, 'HALF_UP').toFixed(2)).toBe('0.13');
    expect(roundMoney('0.145', 2, 'HALF_UP').toFixed(2)).toBe('0.15');
  });

  it('honours DOWN / UP / CEIL / FLOOR', () => {
    // DOWN truncates toward zero; UP moves away from zero.
    expect(roundMoney('1.239', 2, 'DOWN').toFixed(2)).toBe('1.23');
    expect(roundMoney('-1.231', 2, 'DOWN').toFixed(2)).toBe('-1.23');
    expect(roundMoney('1.231', 2, 'UP').toFixed(2)).toBe('1.24');
    expect(roundMoney('-1.231', 2, 'CEIL').toFixed(2)).toBe('-1.23');
    expect(roundMoney('1.231', 2, 'FLOOR').toFixed(2)).toBe('1.23');
  });

  it('defaults to the 4dp money scale', () => {
    expect(MONEY_SCALE).toBe(4);
    expect(toMoneyString('1.234567')).toBe('1.2346'); // 1.23456|7 -> up
    expect(toMoneyString('1.23445')).toBe('1.2344'); // half-even, 4 is even
  });

  it('roundRate / toRateString use the 8dp rate scale', () => {
    expect(RATE_SCALE).toBe(8);
    expect(toRateString('0.0725')).toBe('0.07250000');
    expect(roundRate('0.123456785').toFixed(8)).toBe('0.12345678'); // half-even on 8
  });
});

describe('percentages and rates', () => {
  it('applyRate multiplies base by the fraction', () => {
    // 1000 * 0.325 = 325
    expect(s(applyRate('1000', '0.325'))).toBe('325.0000');
  });

  it('grossUp adds the burden', () => {
    // 1000 * (1 + 0.325) = 1325
    expect(s(grossUp('1000', '0.325'))).toBe('1325.0000');
  });

  it('toPercent / fromPercent round-trip', () => {
    // 0.0725 -> 7.25 -> 0.0725
    expect(s(toPercent('0.0725'))).toBe('7.2500');
    expect(toRateString(fromPercent('7.25'))).toBe('0.07250000');
  });

  it('percentChange is (value - base) / |base|', () => {
    // (110 - 100)/100 = 0.10
    expect(toRateString(percentChange('100', '110') as Decimal)).toBe('0.10000000');
    // (90 - 100)/100 = -0.10
    expect(toRateString(percentChange('100', '90') as Decimal)).toBe('-0.10000000');
    // Base is negative: divisor is |base| so the sign reports the direction of travel.
    // (-80 - -100)/100 = 0.20
    expect(toRateString(percentChange('-100', '-80') as Decimal)).toBe('0.20000000');
  });

  it('percentChange returns null when the base is zero', () => {
    expect(percentChange('0', '100')).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange('-0.0000', '5')).toBeNull();
  });

  it('escalationFactor is (1 + r)^n', () => {
    // (1.03)^2 = 1.0609
    expect(escalationFactor('0.03', 2).toFixed(4)).toBe('1.0609');
    // (1.03)^3 = 1.092727
    expect(escalationFactor('0.03', 3).toFixed(6)).toBe('1.092727');
    // (1.10)^5 = 1.61051
    expect(escalationFactor('0.10', 5).toFixed(5)).toBe('1.61051');
  });

  it('escalationFactor with n = 0 is exactly 1', () => {
    expect(escalationFactor('0.03', 0).toFixed(8)).toBe('1.00000000');
    expect(escalationFactor('0.99', 0).equals(1)).toBe(true);
  });

  it('escalationFactor supports negative periods (discounting)', () => {
    // (1.25)^-1 = 0.8
    expect(escalationFactor('0.25', -1).toFixed(4)).toBe('0.8000');
  });

  it('escalationFactor throws on a non-integer period count', () => {
    expect(() => escalationFactor('0.03', 2.5)).toThrow(TypeError);
    expect(() => escalationFactor('0.03', 2.5)).toThrow(/must be an integer/);
    expect(() => escalationFactor('0.03', Number.NaN)).toThrow(TypeError);
  });
});

describe('allocateEvenly', () => {
  it('splits 100 three ways at scale 2 with the remainder on the earliest parts', () => {
    // totalUnits = 100 / 0.01 = 10000
    // baseUnits  = floor(10000 / 3) = 3333
    // remainder  = 10000 - 3*3333 = 1  -> one extra minor unit to part[0]
    // => [3334, 3333, 3333] units = [33.34, 33.33, 33.33]
    const parts = allocateEvenly('100', 3, 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
  });

  it('sums back EXACTLY to the input', () => {
    // 33.34 + 33.33 + 33.33 = 100.00 exactly
    const parts = allocateEvenly('100', 3, 2);
    expect(add(...parts).equals(new Decimal('100'))).toBe(true);
    expect(toMoneyString(add(...parts), 2)).toBe('100.00');
  });

  it('sums back exactly for a range of awkward amount/part combinations', () => {
    const cases: Array<[string, number, number]> = [
      ['100', 3, 2],
      ['100', 7, 2],
      ['1', 3, 4],
      ['0.01', 3, 2],
      ['1000000.01', 13, 2],
      ['999.99', 11, 2],
      ['12345.6789', 7, 4],
      ['-100', 3, 2],
      ['0', 5, 2],
    ];
    for (const [amount, parts, scale] of cases) {
      const split = allocateEvenly(amount, parts, scale);
      expect(split).toHaveLength(parts);
      expect(
        add(...split).equals(roundMoney(amount, scale)),
        `${amount} / ${parts} @${scale}`,
      ).toBe(true);
    }
  });

  it('handles negative amounts, distributing the deficit to the earliest parts', () => {
    // totalUnits = -10000; baseUnits = ROUND_DOWN(-3333.33) = -3333 (toward zero)
    // remainder = -10000 - 3*(-3333) = -1 -> step is -1, applied to part[0]
    // => [-33.34, -33.33, -33.33], summing to exactly -100.00
    const parts = allocateEvenly('-100', 3, 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['-33.34', '-33.33', '-33.33']);
    expect(add(...parts).equals(new Decimal('-100'))).toBe(true);
  });

  it('with parts = 1 returns the whole amount', () => {
    expect(allocateEvenly('123.45', 1, 2).map((p) => p.toFixed(2))).toEqual(['123.45']);
    expect(allocateEvenly('-123.45', 1, 2).map((p) => p.toFixed(2))).toEqual(['-123.45']);
  });

  it('spreads a remainder larger than one unit across consecutive early parts', () => {
    // 100 across 6 at scale 2: totalUnits 10000, base = floor(10000/6) = 1666,
    // remainder = 10000 - 6*1666 = 4 -> parts 0..3 get +1.
    // => [16.67, 16.67, 16.67, 16.67, 16.66, 16.66]; sum = 4*16.67 + 2*16.66 = 100.00
    const parts = allocateEvenly('100', 6, 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual([
      '16.67',
      '16.67',
      '16.67',
      '16.67',
      '16.66',
      '16.66',
    ]);
    expect(add(...parts).equals(new Decimal('100'))).toBe(true);
  });

  it('divides cleanly when there is no remainder', () => {
    // 100 / 4 = 25 exactly
    expect(allocateEvenly('100', 4, 2).map((p) => p.toFixed(2))).toEqual([
      '25.00',
      '25.00',
      '25.00',
      '25.00',
    ]);
  });

  it('throws on a zero, negative or non-integer part count', () => {
    expect(() => allocateEvenly('100', 0)).toThrow(RangeError);
    expect(() => allocateEvenly('100', -3)).toThrow(RangeError);
    expect(() => allocateEvenly('100', 2.5)).toThrow(RangeError);
    expect(() => allocateEvenly('100', Number.NaN)).toThrow(/positive integer part count/);
  });
});

describe('allocateByWeights', () => {
  it('splits 100 on equal weights [1,1,1] like an even split', () => {
    // totalUnits = 10000, totalWeight = 3
    // exact = 3333.333... each; floored = 3333 each; leftover = 1
    // all fractional parts tie, so the stable sort keeps index order -> part[0] gets it
    const parts = allocateByWeights('100', [1, 1, 1], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(add(...parts).equals(new Decimal('100'))).toBe(true);
  });

  it('splits 1000 on weights [50,30,20] into 500/300/200', () => {
    // totalWeight = 100; 1000*50/100 = 500, *30/100 = 300, *20/100 = 200. No remainder.
    const parts = allocateByWeights('1000', [50, 30, 20]);
    expect(parts.map((p) => p.toFixed(4))).toEqual(['500.0000', '300.0000', '200.0000']);
    expect(add(...parts).equals(new Decimal('1000'))).toBe(true);
  });

  it('uses largest-remainder when the shares do not divide evenly', () => {
    // 100 on weights [1,2,4] at scale 2. totalWeight = 7, totalUnits = 10000.
    //   exact:   10000/7 = 1428.5714..., 20000/7 = 2857.1428..., 40000/7 = 5714.2857...
    //   floored: 1428, 2857, 5714 -> 9999, leftover = 1
    //   fractions: .5714 (idx0), .1428 (idx1), .2857 (idx2) -> largest is idx0
    // => [1429, 2857, 5714] units = [14.29, 28.57, 57.14]; sum = 100.00
    const parts = allocateByWeights('100', [1, 2, 4], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['14.29', '28.57', '57.14']);
    expect(add(...parts).equals(new Decimal('100'))).toBe(true);
  });

  it('sums back EXACTLY across a spread of awkward weightings', () => {
    const cases: Array<[string, number[], number]> = [
      ['100', [1, 1, 1], 2],
      ['100', [1, 2, 4], 2],
      ['1000000.07', [17, 3, 11, 2], 2],
      ['0.05', [1, 1, 1, 1, 1, 1, 1], 2],
      ['-250.55', [3, 5, 7], 2],
      ['987654.3211', [1, 1, 1], 4],
      ['1', [0.3333, 0.3333, 0.3334], 4],
    ];
    for (const [amount, weights, scale] of cases) {
      const parts = allocateByWeights(amount, weights, scale);
      expect(parts).toHaveLength(weights.length);
      expect(
        add(...parts).equals(roundMoney(amount, scale)),
        `${amount} by [${weights.join(',')}] @${scale}`,
      ).toBe(true);
    }
  });

  it('falls back to an even split when every weight is zero', () => {
    // totalWeight = 0 -> allocateEvenly(100, 3, 2) -> [33.34, 33.33, 33.33]
    const parts = allocateByWeights('100', [0, 0, 0], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(add(...parts).equals(new Decimal('100'))).toBe(true);
  });

  it('gives zero-weighted parts nothing when other weights are positive', () => {
    // totalWeight = 2; 100*0/2 = 0, 100*2/2 = 100
    const parts = allocateByWeights('100', [0, 2], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['0.00', '100.00']);
  });

  it('throws on a negative weight', () => {
    expect(() => allocateByWeights('100', [1, -1, 1])).toThrow(RangeError);
    expect(() => allocateByWeights('100', [1, -1, 1])).toThrow(/negative weights/);
  });

  it('throws on an empty weight array', () => {
    expect(() => allocateByWeights('100', [])).toThrow(RangeError);
    expect(() => allocateByWeights('100', [])).toThrow(/at least one weight/);
  });

  it('handles a single weight by returning the whole amount', () => {
    expect(allocateByWeights('123.45', [7], 2).map((p) => p.toFixed(2))).toEqual(['123.45']);
  });
});

describe('comparison helpers', () => {
  it('isZero, with and without a tolerance', () => {
    expect(isZero('0')).toBe(true);
    expect(isZero('0.0001')).toBe(false);
    expect(isZero('0.0001', '0.001')).toBe(true);
    expect(isZero('-0.0005', '0.001')).toBe(true);
  });

  it('equals, with and without a tolerance', () => {
    expect(equals('1.0000', '1')).toBe(true);
    expect(equals('1.0001', '1')).toBe(false);
    expect(equals('1.0001', '1', '0.001')).toBe(true);
  });

  it('isNegative treats zero as not negative', () => {
    expect(isNegative('-0.01')).toBe(true);
    expect(isNegative('0')).toBe(false);
    expect(isNegative('-0')).toBe(false);
    expect(isNegative('0.01')).toBe(false);
  });

  it('isPositive treats zero as not positive', () => {
    expect(isPositive('0.01')).toBe(true);
    expect(isPositive('0')).toBe(false);
    expect(isPositive('-0.01')).toBe(false);
  });

  it('compare returns -1 / 0 / 1', () => {
    expect(compare('1', '2')).toBe(-1);
    expect(compare('2', '2.0000')).toBe(0);
    expect(compare('3', '2')).toBe(1);
  });

  it('clamp bounds a value into [lower, upper]', () => {
    expect(s(clamp('5', '1', '10'))).toBe('5.0000');
    expect(s(clamp('-5', '1', '10'))).toBe('1.0000');
    expect(s(clamp('50', '1', '10'))).toBe('10.0000');
    expect(s(clamp('10', '10', '10'))).toBe('10.0000');
  });

  it('clamp throws when the lower bound exceeds the upper bound', () => {
    expect(() => clamp('5', '10', '1')).toThrow(RangeError);
    expect(() => clamp('5', '10', '1')).toThrow(/lower bound exceeds upper bound/);
  });
});

describe('formatMoney', () => {
  it('formats a plain positive amount', () => {
    expect(formatMoney('1234.56')).toBe('$1,234.56');
  });

  it('prefixes a minus sign by default for negatives', () => {
    expect(formatMoney('-1234.56')).toBe('-$1,234.56');
  });

  it('wraps negatives in parentheses when accountingNegatives is set', () => {
    expect(formatMoney('-1234.56', { accountingNegatives: true })).toBe('($1,234.56)');
  });

  it('leaves positives untouched under accountingNegatives', () => {
    expect(formatMoney('1234.56', { accountingNegatives: true })).toBe('$1,234.56');
  });

  it("scaleUnit 'thousands' divides by 1,000 and suffixes K", () => {
    // 1,500,000 / 1,000 = 1,500.00
    expect(formatMoney('1500000', { scaleUnit: 'thousands' })).toBe('$1,500.00K');
  });

  it("scaleUnit 'millions' divides by 1,000,000 and suffixes M", () => {
    // 1,500,000 / 1,000,000 = 1.50
    expect(formatMoney('1500000', { scaleUnit: 'millions' })).toBe('$1.50M');
  });

  it('combines scaling with accounting negatives', () => {
    // -2,500,000 / 1,000,000 = -2.50 -> "($2.50M)"
    expect(formatMoney('-2500000', { scaleUnit: 'millions', accountingNegatives: true })).toBe(
      '($2.50M)',
    );
  });

  it("scaleUnit 'none' is the default and adds no suffix", () => {
    expect(formatMoney('1500000', { scaleUnit: 'none' })).toBe(formatMoney('1500000'));
  });

  it('honours fraction-digit overrides', () => {
    expect(formatMoney('1234.5678', { minimumFractionDigits: 0, maximumFractionDigits: 0 })).toBe(
      '$1,235',
    );
  });

  it('honours a different currency', () => {
    // Symbol placement is locale/ICU driven; assert the amount and that USD is not used.
    const gbp = formatMoney('1234.56', { currency: 'GBP' });
    expect(gbp).toContain('1,234.56');
    expect(gbp).not.toContain('$1,234.56');
  });
});

describe('formatPercent', () => {
  it('formats a fraction as a percentage', () => {
    // 0.0725 -> 7.2% at one fraction digit.
    //
    // This expected 7.3% until formatMoney and formatPercent were given
    // roundingMode: 'halfEven'. 7.25 is an exact tie at one place, and the
    // engine has always rounded it to 7.2 - toPercent('0.0725') is 7.25 and
    // Decimal rounds half-to-even. Intl's default is half-expand, so the
    // display and the arithmetic disagreed. The old expectation encoded that
    // disagreement rather than a deliberate choice.
    expect(formatPercent('0.0725')).toBe('7.2%');
    expect(formatPercent('0.0725', { fractionDigits: 2 })).toBe('7.25%');
    expect(formatPercent('-0.125', { fractionDigits: 1 })).toBe('-12.5%');
  });
});
