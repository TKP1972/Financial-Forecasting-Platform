/**
 * A cycle's fiscal calendar travels with the cycle.
 *
 * `FiscalConfig` existed and was tested from the day it was written, but nothing
 * ever supplied it — every call fell through to the January default, so the
 * capability looked finished and was not. These tests cover the wiring rather
 * than the arithmetic: that a stored calendar is read back faithfully, and that
 * it actually changes the dates a period covers.
 *
 * The property worth protecting is the reason the calendar is stored per cycle
 * at all: **changing the deployment default must not re-date a closed year.**
 */
import { describe, expect, it } from 'vitest';
import { buildFiscalYear, fiscalConfigOf, periodKey, DEFAULT_FISCAL_CONFIG } from './fiscal.js';

describe('fiscalConfigOf', () => {
  it('maps a stored record to a config', () => {
    expect(fiscalConfigOf({ fiscalStartMonth: 4, fiscalYearLabel: 'END' })).toEqual({
      startMonth: 4,
      labelBy: 'END',
    });
  });

  it('treats any label other than END as START', () => {
    // The column is an enum in the database, but this helper also receives
    // values from JSON payloads. Defaulting to START matches the platform
    // default rather than throwing on data that is already stored.
    expect(fiscalConfigOf({ fiscalStartMonth: 1, fiscalYearLabel: 'START' }).labelBy).toBe('START');
    expect(fiscalConfigOf({ fiscalStartMonth: 1, fiscalYearLabel: 'nonsense' }).labelBy).toBe(
      'START',
    );
  });
});

describe('a stored calendar changes the dates a period covers', () => {
  it('January start: FY2026-P01 begins 1 January 2026', () => {
    // Hand-computed: startMonth 1 means period 1 is the first calendar month
    // of the same calendar year.
    const periods = buildFiscalYear(2026, 'MONTH', DEFAULT_FISCAL_CONFIG);
    expect(periods[0]!.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(periods[11]!.startDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('April start, labelled by START: FY2026-P01 begins 1 April 2026', () => {
    // UK and India convention when the year is named by the calendar year it
    // opens in. Period 12 then falls in March of the *following* calendar year.
    const periods = buildFiscalYear(
      2026,
      'MONTH',
      fiscalConfigOf({ fiscalStartMonth: 4, fiscalYearLabel: 'START' }),
    );
    expect(periods[0]!.startDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(periods[11]!.startDate.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  it('July start: FY2026-P01 begins 1 July 2026', () => {
    // Australia and New Zealand.
    const periods = buildFiscalYear(
      2026,
      'MONTH',
      fiscalConfigOf({ fiscalStartMonth: 7, fiscalYearLabel: 'START' }),
    );
    expect(periods[0]!.startDate.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('October start: FY2026-P01 begins 1 October 2026', () => {
    // US federal.
    const periods = buildFiscalYear(
      2026,
      'MONTH',
      fiscalConfigOf({ fiscalStartMonth: 10, fiscalYearLabel: 'START' }),
    );
    expect(periods[0]!.startDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('labelBy END shifts the calendar year the fiscal year opens in', () => {
    // FY2026 ending in calendar 2026 with an April start opens in April 2025.
    // This is the convention that most often surprises people, which is why it
    // is asserted with an explicit date rather than described.
    const periods = buildFiscalYear(
      2026,
      'MONTH',
      fiscalConfigOf({ fiscalStartMonth: 4, fiscalYearLabel: 'END' }),
    );
    expect(periods[0]!.startDate.toISOString()).toBe('2025-04-01T00:00:00.000Z');
    expect(periods[11]!.startDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('period keys are independent of the fiscal calendar', () => {
  // This is what makes changing the setting safe for existing data: the join
  // key between budgets and actuals does not move. Only the dates and the
  // label do. If this ever stopped being true, every stored actual would need
  // remapping and the migration would be brutal.
  it.each([
    ['January', 1, 'START'],
    ['April', 4, 'START'],
    ['April, END-labelled', 4, 'END'],
    ['October', 10, 'START'],
  ])('%s produces the same keys', (_label, startMonth, labelBy) => {
    const periods = buildFiscalYear(
      2026,
      'MONTH',
      fiscalConfigOf({ fiscalStartMonth: startMonth, fiscalYearLabel: labelBy }),
    );

    expect(periods.map((p) => p.key)).toEqual(
      Array.from({ length: 12 }, (_, i) => periodKey(2026, i + 1, 'MONTH')),
    );
    expect(periods[0]!.key).toBe('FY2026-P01');
  });
});
