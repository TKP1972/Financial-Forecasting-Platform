/**
 * The axis a caller is shown must equal the axis they are held to.
 *
 * `GET /cycles/:id` advertises a cycle's periods; `createBudget` refuses a line
 * whose amount count does not match. Those were computed by two different
 * functions and disagreed for multi-year cycles: the endpoint reported 12
 * periods for a three-year Medium Term Plan whose budgets require 36. A client
 * building a data-entry form from the advertised axis was refused every time,
 * with a message that looked like its own mistake.
 *
 * Both now call `buildPeriodAxis`. These tests pin the property that made the
 * defect possible — the count for a horizon is the per-year count times the
 * horizon — so a future change that reintroduces a one-year assumption fails
 * here rather than in a client.
 */
import { describe, expect, it } from 'vitest';
import { buildPeriodAxis, buildFiscalYear, DEFAULT_FISCAL_CONFIG } from './fiscal.js';
import { PERIODS_PER_YEAR, PERIOD_TYPES, type PeriodType } from './domain.js';

describe('buildPeriodAxis spans the whole horizon', () => {
  it.each([
    [1, 12],
    [3, 36],
    [5, 60],
  ])('a %i-year monthly horizon has %i periods', (years, expected) => {
    expect(buildPeriodAxis(2026, years, 'MONTH')).toHaveLength(expected);
  });

  it.each(PERIOD_TYPES)('holds for %s periods too', (periodType: PeriodType) => {
    const years = 3;
    expect(buildPeriodAxis(2026, years, periodType)).toHaveLength(
      PERIODS_PER_YEAR[periodType] * years,
    );
  });

  it('agrees with buildFiscalYear when the horizon is a single year', () => {
    // The single-year case is the one that was already correct; it must stay
    // correct now that both paths go through the multi-year helper.
    const axis = buildPeriodAxis(2026, 1, 'MONTH', DEFAULT_FISCAL_CONFIG);
    const single = buildFiscalYear(2026, 'MONTH', DEFAULT_FISCAL_CONFIG);
    expect(axis.map((p) => p.key)).toEqual(single.map((p) => p.key));
  });
});

describe('the axis is ordered and covers consecutive fiscal years', () => {
  it('runs year by year, period by period, without gaps or repeats', () => {
    const axis = buildPeriodAxis(2026, 3, 'MONTH');
    const keys = axis.map((p) => p.key);

    expect(new Set(keys).size, 'a repeated key would collide two amounts').toBe(keys.length);
    expect(keys[0]).toBe('FY2026-P01');
    expect(keys[11]).toBe('FY2026-P12');
    expect(keys[12]).toBe('FY2027-P01');
    expect(keys[35]).toBe('FY2028-P12');
  });

  it('carries the cycle calendar into every year of the horizon', () => {
    // An April-start three-year plan opens in April of each year, not January
    // of the first and then whatever. A horizon that lost the calendar after
    // year one would misdate two thirds of an MTP.
    const axis = buildPeriodAxis(2026, 3, 'MONTH', { startMonth: 4, labelBy: 'START' });

    expect(axis[0]!.startDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(axis[12]!.startDate.toISOString()).toBe('2027-04-01T00:00:00.000Z');
    expect(axis[24]!.startDate.toISOString()).toBe('2028-04-01T00:00:00.000Z');
  });
});

describe('guards', () => {
  it('refuses a horizon below one rather than returning an empty axis', () => {
    // An empty axis would make every budget line valid at zero amounts, which
    // is a silently wrong result rather than a loud one.
    expect(() => buildPeriodAxis(2026, 0)).toThrow(RangeError);
  });
});
