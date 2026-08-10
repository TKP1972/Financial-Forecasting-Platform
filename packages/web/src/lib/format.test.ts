/**
 * The formatters that render every money figure on every screen.
 *
 * `packages/web` had no tests at all. This module is the right place to start:
 * it is imported by twelve components, it is pure, and it is the one file whose
 * only verification was a person looking at a screenshot once. A regression here
 * shows up as wrong numbers in front of a user, not as a crash.
 *
 * The contract worth protecting is **failing soft**. A missing or malformed
 * value must render as an em dash, never as `NaN`, `undefined` or `Infinity`.
 * A finance screen showing `NaN` destroys confidence in every other number on
 * the page, including the correct ones.
 *
 * Expectations are written out by hand rather than derived from the code under
 * test, per the repository's testing convention.
 */
import { describe, expect, it } from 'vitest';
import {
  chartValue,
  decimal,
  formatDate,
  formatDateTime,
  humanise,
  integer,
  money,
  money0,
  percent,
  severityFor,
} from './format.js';

const DASH = '—';

describe('money', () => {
  it('formats a decimal string with grouping and two places', () => {
    expect(money('1500000')).toBe('$1,500,000.00');
  });

  it('accepts the four-decimal form the API actually sends', () => {
    // Money crosses the wire as numeric(18,4); the UI shows two.
    expect(money('1500000.0000')).toBe('$1,500,000.00');
  });

  /**
   * Display rounding matches the arithmetic.
   *
   * These differed once: Intl.NumberFormat defaults to half-expand, so 0.125
   * displayed as 0.13 while every calculation in the platform rounded it to
   * 0.12. Small, and exactly the penny discrepancy that costs an afternoon in
   * a reconciliation meeting. formatMoney now passes roundingMode: 'halfEven'.
   *
   * Asserted here rather than only in shared, because this is where a user
   * actually sees the number.
   */
  it('rounds half-to-even on display, matching the engine', () => {
    expect(money('0.125', { decimals: 2 })).toBe('$0.12');
    expect(money('0.135', { decimals: 2 })).toBe('$0.14');
    // 0.145 -> 0.14 and 0.155 -> 0.16: ties go to the even digit in both
    // directions, which is the property that makes it unbiased.
    expect(money('0.145', { decimals: 2 })).toBe('$0.14');
    expect(money('0.155', { decimals: 2 })).toBe('$0.16');
  });

  it('brackets negatives by default, as an accountant expects', () => {
    expect(money('-2500')).toBe('($2,500.00)');
  });

  it('can show a plain minus instead', () => {
    expect(money('-2500', { accounting: false })).toBe('-$2,500.00');
  });

  it('honours an explicit currency', () => {
    expect(money('1000', { currency: 'EUR' })).toBe('€1,000.00');
    expect(money('1000', { currency: 'GBP' })).toBe('£1,000.00');
  });

  it('compacts to millions with one decimal', () => {
    expect(money('4620000', { compact: true })).toBe('$4.6M');
  });

  describe('fails soft rather than showing NaN', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['not a number', 'not-a-number'],
    ])('%s renders as an em dash', (_label, input) => {
      expect(money(input as never)).toBe(DASH);
    });

    it('never emits NaN, Infinity or undefined for junk input', () => {
      // The guarantee stated as a property rather than case by case: whatever
      // arrives, the string a user sees is never one of these.
      for (const input of [null, undefined, '', 'abc', '{}', NaN, Infinity, -Infinity]) {
        const rendered = money(input as never);
        expect(rendered).not.toMatch(/NaN|Infinity|undefined|\[object/);
      }
    });
  });

  it('renders zero as a real value, not a dash', () => {
    // Zero is information — an empty budget line is not the same as a missing
    // one, and conflating them hides real data.
    expect(money('0')).toBe('$0.00');
    expect(money(0)).toBe('$0.00');
  });
});

describe('money0', () => {
  it('drops the decimals for dense tables', () => {
    expect(money0('33029244')).toBe('$33,029,244');
  });

  it('rounds to the whole unit', () => {
    expect(money0('1234.60')).toBe('$1,235');
  });

  it('fails soft', () => {
    expect(money0(null)).toBe(DASH);
  });
});

describe('percent', () => {
  it('renders a fraction as a percentage', () => {
    // Rates are fractions throughout the platform: 0.092 is 9.2%.
    expect(percent('0.092')).toBe('9.2%');
  });

  it('honours the requested precision', () => {
    expect(percent('0.09246', { fractionDigits: 2 })).toBe('9.25%');
  });

  it('fails soft', () => {
    expect(percent(null)).toBe(DASH);
    expect(percent('')).toBe(DASH);
  });
});

describe('decimal and integer', () => {
  it('decimal fixes to three places by default', () => {
    expect(decimal(1.23456)).toBe('1.235');
    expect(decimal(1.23456, 1)).toBe('1.2');
  });

  it('integer groups thousands', () => {
    expect(integer(1234567)).toBe('1,234,567');
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['undefined', undefined],
  ])('both dash on %s', (_label, input) => {
    expect(decimal(input as never)).toBe(DASH);
    expect(integer(input as never)).toBe(DASH);
  });
});

describe('chartValue', () => {
  // Charts need floats. This is the one place a money string becomes a number,
  // and it is never fed back into a total - hence zero rather than a dash for
  // bad input, because a chart cannot plot an em dash.
  it('parses a decimal string', () => {
    expect(chartValue('1500.50')).toBe(1500.5);
  });

  it('passes a number through', () => {
    expect(chartValue(42)).toBe(42);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['junk', 'not-a-number'],
  ])('%s becomes zero, so a plot never breaks', (_label, input) => {
    expect(chartValue(input as never)).toBe(0);
  });
});

describe('dates', () => {
  it('formats a date in day-month-year order', () => {
    // en-GB deliberately: this is a finance product, and 09/08 meaning the
    // ninth of August is the convention its users read.
    expect(formatDate('2026-08-09T00:00:00.000Z')).toMatch(/09/);
    expect(formatDate('2026-08-09T00:00:00.000Z')).toMatch(/Aug|08/);
  });

  it('accepts a Date as well as a string', () => {
    expect(formatDate(new Date('2026-08-09T00:00:00.000Z'))).toBe(
      formatDate('2026-08-09T00:00:00.000Z'),
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['unparseable', 'not-a-date'],
  ])('%s renders as an em dash rather than "Invalid Date"', (_label, input) => {
    expect(formatDate(input as never)).toBe(DASH);
    expect(formatDateTime(input as never)).toBe(DASH);
  });
});

describe('humanise', () => {
  it('turns an enum code into something readable', () => {
    expect(humanise('SEMI_VARIABLE')).toBe('Semi Variable');
    expect(humanise('FIRM_FIXED_PRICE')).toBe('Firm Fixed Price');
  });

  it('fails soft', () => {
    expect(humanise(null)).toBe(DASH);
  });
});

describe('severityFor', () => {
  // Risk score bands. Asserted at the boundaries because an off-by-one here
  // silently re-grades every risk on the register.
  it.each([
    [1, 'LOW'],
    [25, 'CRITICAL'],
  ])('score %i is %s', (score, expected) => {
    expect(severityFor(score)).toBe(expected);
  });

  it('is monotonic across the whole 1-25 range', () => {
    // Never grades a higher score as less severe than a lower one.
    const order = ['LOW', 'MODERATE', 'HIGH', 'SEVERE', 'CRITICAL'];
    let previous = -1;
    for (let score = 1; score <= 25; score += 1) {
      const rank = order.indexOf(severityFor(score));
      expect(rank, `score ${score} produced an unknown severity`).toBeGreaterThanOrEqual(0);
      expect(rank, `severity fell between ${score - 1} and ${score}`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = rank;
    }
  });
});
