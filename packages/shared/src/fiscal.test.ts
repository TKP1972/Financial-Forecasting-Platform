/**
 * Unit tests for the fiscal calendar.
 *
 * All boundary dates below are worked out by hand from the fiscal start month;
 * the derivation is shown in the comment above each assertion block.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FISCAL_CONFIG,
  buildFiscalYear,
  buildPeriodAxis,
  calendarDaysBetween,
  calendarYearOfFiscalStart,
  fiscalYearOf,
  parsePeriodKey,
  periodForDate,
  periodKey,
  periodLabel,
  periodsYearToDate,
  yearElapsedFraction,
  type FiscalConfig,
} from './fiscal.js';
import { PERIODS_PER_YEAR, type PeriodType } from './domain.js';

const CALENDAR: FiscalConfig = { startMonth: 1, labelBy: 'START' };
const APRIL_START: FiscalConfig = { startMonth: 4, labelBy: 'START' };
const APRIL_END: FiscalConfig = { startMonth: 4, labelBy: 'END' };

/** UTC ISO date, for readable assertions. */
const iso = (d: Date) => d.toISOString();

describe('DEFAULT_FISCAL_CONFIG', () => {
  it('is a January-start, START-labelled calendar year', () => {
    expect(DEFAULT_FISCAL_CONFIG).toEqual({ startMonth: 1, labelBy: 'START' });
  });
});

describe('buildFiscalYear - calendar year (startMonth = 1)', () => {
  const periods = buildFiscalYear(2026, 'MONTH', CALENDAR);

  it('produces 12 monthly periods', () => {
    expect(periods).toHaveLength(12);
    expect(PERIODS_PER_YEAR.MONTH).toBe(12);
  });

  it('runs Jan..Dec with correct UTC boundaries', () => {
    // P01 = Jan 2026: [2026-01-01, 2026-02-01)
    expect(iso(periods[0]!.startDate)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(periods[0]!.endDateExclusive)).toBe('2026-02-01T00:00:00.000Z');
    // P12 = Dec 2026: [2026-12-01, 2027-01-01)
    expect(iso(periods[11]!.startDate)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(periods[11]!.endDateExclusive)).toBe('2027-01-01T00:00:00.000Z');
    // Mid-year sample: P07 = Jul 2026
    expect(iso(periods[6]!.startDate)).toBe('2026-07-01T00:00:00.000Z');
    expect(iso(periods[6]!.endDateExclusive)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('is contiguous - each period starts where the previous one ended', () => {
    for (let i = 1; i < periods.length; i += 1) {
      expect(periods[i]!.startDate.getTime()).toBe(periods[i - 1]!.endDateExclusive.getTime());
    }
  });

  it('labels the months Jan..Dec', () => {
    expect(periods.map((p) => p.label)).toEqual([
      'Jan FY2026',
      'Feb FY2026',
      'Mar FY2026',
      'Apr FY2026',
      'May FY2026',
      'Jun FY2026',
      'Jul FY2026',
      'Aug FY2026',
      'Sep FY2026',
      'Oct FY2026',
      'Nov FY2026',
      'Dec FY2026',
    ]);
  });

  it('keys the months P01..P12 with a zero-padded index', () => {
    expect(periods.map((p) => p.key)).toEqual([
      'FY2026-P01',
      'FY2026-P02',
      'FY2026-P03',
      'FY2026-P04',
      'FY2026-P05',
      'FY2026-P06',
      'FY2026-P07',
      'FY2026-P08',
      'FY2026-P09',
      'FY2026-P10',
      'FY2026-P11',
      'FY2026-P12',
    ]);
  });

  it('carries the fiscal year and a 1-based period index', () => {
    expect(periods.map((p) => p.fiscalYear)).toEqual(Array(12).fill(2026));
    expect(periods.map((p) => p.periodIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(periods.every((p) => p.periodType === 'MONTH')).toBe(true);
  });

  it('assigns quarters: months 1-3 => Q1, 4-6 => Q2, 7-9 => Q3, 10-12 => Q4', () => {
    // quarter = floor((periodIndex - 1) / 3) + 1
    expect(periods.map((p) => p.quarter)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  });
});

describe('buildFiscalYear - non-calendar fiscal year (startMonth = 4)', () => {
  it("labelBy 'START': FY2026 P01 opens 2026-04-01 and P12 closes at 2027-04-01", () => {
    // labelBy START -> FY2026 begins in calendar 2026.
    // P01 = Apr 2026. P12 = the 12th month from April = March 2027,
    // whose exclusive end is 2027-04-01.
    const periods = buildFiscalYear(2026, 'MONTH', APRIL_START);
    expect(periods).toHaveLength(12);
    expect(iso(periods[0]!.startDate)).toBe('2026-04-01T00:00:00.000Z');
    expect(iso(periods[0]!.endDateExclusive)).toBe('2026-05-01T00:00:00.000Z');
    expect(periods[0]!.label).toBe('Apr FY2026');

    expect(iso(periods[11]!.startDate)).toBe('2027-03-01T00:00:00.000Z');
    expect(iso(periods[11]!.endDateExclusive)).toBe('2027-04-01T00:00:00.000Z');
    expect(periods[11]!.label).toBe('Mar FY2026');
  });

  it("labelBy 'START': the calendar year rolls over between P09 and P10", () => {
    // Apr(1) May(2) Jun(3) Jul(4) Aug(5) Sep(6) Oct(7) Nov(8) Dec(9) | Jan(10) 2027
    const periods = buildFiscalYear(2026, 'MONTH', APRIL_START);
    expect(iso(periods[8]!.startDate)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(periods[9]!.startDate)).toBe('2027-01-01T00:00:00.000Z');
    expect(periods[9]!.label).toBe('Jan FY2026');
  });

  it("labelBy 'END': FY2026 starts 2025-04-01 and ends at 2026-04-01", () => {
    // labelBy END -> FY2026 *ends* in calendar 2026, so it opens a year earlier.
    const periods = buildFiscalYear(2026, 'MONTH', APRIL_END);
    expect(iso(periods[0]!.startDate)).toBe('2025-04-01T00:00:00.000Z');
    expect(iso(periods[11]!.endDateExclusive)).toBe('2026-04-01T00:00:00.000Z');
  });

  it('assigns fiscal (not calendar) quarters', () => {
    // Fiscal Q1 = Apr/May/Jun, Q2 = Jul/Aug/Sep, Q3 = Oct/Nov/Dec, Q4 = Jan/Feb/Mar
    const periods = buildFiscalYear(2026, 'MONTH', APRIL_START);
    expect(periods.map((p) => p.quarter)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  });

  it('remains contiguous across the calendar year boundary', () => {
    const periods = buildFiscalYear(2026, 'MONTH', APRIL_START);
    for (let i = 1; i < periods.length; i += 1) {
      expect(periods[i]!.startDate.getTime()).toBe(periods[i - 1]!.endDateExclusive.getTime());
    }
  });
});

describe('calendarYearOfFiscalStart', () => {
  it('is the fiscal year itself for a January start, whatever the labelling', () => {
    expect(calendarYearOfFiscalStart(2026, CALENDAR)).toBe(2026);
    expect(calendarYearOfFiscalStart(2026, { startMonth: 1, labelBy: 'END' })).toBe(2026);
  });

  it('is the fiscal year for START labelling and one year earlier for END', () => {
    expect(calendarYearOfFiscalStart(2026, APRIL_START)).toBe(2026);
    expect(calendarYearOfFiscalStart(2026, APRIL_END)).toBe(2025);
  });
});

describe('fiscalYearOf', () => {
  it('is the calendar year for a January start', () => {
    expect(fiscalYearOf(new Date('2026-01-01T00:00:00Z'), CALENDAR)).toBe(2026);
    expect(fiscalYearOf(new Date('2026-12-31T23:59:59Z'), CALENDAR)).toBe(2026);
    expect(fiscalYearOf(new Date('2027-01-01T00:00:00Z'), CALENDAR)).toBe(2027);
  });

  it("straddles the April boundary correctly with labelBy 'START'", () => {
    // 31 Mar 2026 is month 3 < 4, so it belongs to the year that opened Apr 2025;
    // under START labelling that year is FY2025.
    expect(fiscalYearOf(new Date('2026-03-31T23:59:59Z'), APRIL_START)).toBe(2025);
    // 1 Apr 2026 opens the next fiscal year, FY2026.
    expect(fiscalYearOf(new Date('2026-04-01T00:00:00Z'), APRIL_START)).toBe(2026);
  });

  it("straddles the April boundary correctly with labelBy 'END'", () => {
    // Same underlying year (opened Apr 2025) but END labelling names it by its
    // closing calendar year: FY2026.
    expect(fiscalYearOf(new Date('2026-03-31T23:59:59Z'), APRIL_END)).toBe(2026);
    // The year opening Apr 2026 closes in 2027 -> FY2027.
    expect(fiscalYearOf(new Date('2026-04-01T00:00:00Z'), APRIL_END)).toBe(2027);
  });

  it('defaults to the calendar configuration', () => {
    expect(fiscalYearOf(new Date('2026-06-15T00:00:00Z'))).toBe(2026);
  });

  it('agrees with buildFiscalYear on the year a date lands in', () => {
    for (const config of [CALENDAR, APRIL_START, APRIL_END]) {
      const date = new Date('2026-08-07T12:00:00Z');
      const fy = fiscalYearOf(date, config);
      const periods = buildFiscalYear(fy, 'MONTH', config);
      expect(date >= periods[0]!.startDate, JSON.stringify(config)).toBe(true);
      expect(date < periods[11]!.endDateExclusive, JSON.stringify(config)).toBe(true);
    }
  });
});

describe('period type construction', () => {
  it('QUARTER produces 4 three-month periods', () => {
    const quarters = buildFiscalYear(2026, 'QUARTER', CALENDAR);
    expect(quarters).toHaveLength(4);
    // Q1 = [2026-01-01, 2026-04-01); Q4 = [2026-10-01, 2027-01-01)
    expect(iso(quarters[0]!.startDate)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(quarters[0]!.endDateExclusive)).toBe('2026-04-01T00:00:00.000Z');
    expect(iso(quarters[3]!.startDate)).toBe('2026-10-01T00:00:00.000Z');
    expect(iso(quarters[3]!.endDateExclusive)).toBe('2027-01-01T00:00:00.000Z');
    expect(quarters.map((q) => q.key)).toEqual([
      'FY2026-Q1',
      'FY2026-Q2',
      'FY2026-Q3',
      'FY2026-Q4',
    ]);
    expect(quarters.map((q) => q.label)).toEqual([
      'Q1 FY2026',
      'Q2 FY2026',
      'Q3 FY2026',
      'Q4 FY2026',
    ]);
    // quarter = floor((firstMonthIndex - 1)/3) + 1 with firstMonthIndex 1,4,7,10
    expect(quarters.map((q) => q.quarter)).toEqual([1, 2, 3, 4]);
  });

  it('QUARTER respects a non-calendar start month', () => {
    // startMonth 4 -> Q1 = Apr..Jun 2026, Q4 = Jan..Mar 2027
    const quarters = buildFiscalYear(2026, 'QUARTER', APRIL_START);
    expect(iso(quarters[0]!.startDate)).toBe('2026-04-01T00:00:00.000Z');
    expect(iso(quarters[0]!.endDateExclusive)).toBe('2026-07-01T00:00:00.000Z');
    expect(iso(quarters[3]!.startDate)).toBe('2027-01-01T00:00:00.000Z');
    expect(iso(quarters[3]!.endDateExclusive)).toBe('2027-04-01T00:00:00.000Z');
  });

  it('HALF produces 2 six-month periods', () => {
    const halves = buildFiscalYear(2026, 'HALF', CALENDAR);
    expect(halves).toHaveLength(2);
    expect(iso(halves[0]!.startDate)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(halves[0]!.endDateExclusive)).toBe('2026-07-01T00:00:00.000Z');
    expect(iso(halves[1]!.startDate)).toBe('2026-07-01T00:00:00.000Z');
    expect(iso(halves[1]!.endDateExclusive)).toBe('2027-01-01T00:00:00.000Z');
    expect(halves.map((h) => h.key)).toEqual(['FY2026-H1', 'FY2026-H2']);
    expect(halves.map((h) => h.label)).toEqual(['H1 FY2026', 'H2 FY2026']);
    // H2 opens at fiscal month 7, so floor((7-1)/3)+1 = 3.
    expect(halves.map((h) => h.quarter)).toEqual([1, 3]);
  });

  it('YEAR produces a single period whose quarter is forced to 1', () => {
    const years = buildFiscalYear(2026, 'YEAR', CALENDAR);
    expect(years).toHaveLength(1);
    expect(iso(years[0]!.startDate)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(years[0]!.endDateExclusive)).toBe('2027-01-01T00:00:00.000Z');
    expect(years[0]!.key).toBe('FY2026-Y1');
    expect(years[0]!.label).toBe('FY2026');
    expect(years[0]!.quarter).toBe(1);
  });

  it('YEAR respects a non-calendar start month', () => {
    const [year] = buildFiscalYear(2026, 'YEAR', APRIL_START);
    expect(iso(year!.startDate)).toBe('2026-04-01T00:00:00.000Z');
    expect(iso(year!.endDateExclusive)).toBe('2027-04-01T00:00:00.000Z');
  });

  it('every period type tiles the same 12 months', () => {
    for (const type of ['MONTH', 'QUARTER', 'HALF', 'YEAR'] as PeriodType[]) {
      const periods = buildFiscalYear(2026, type, APRIL_START);
      expect(periods, type).toHaveLength(PERIODS_PER_YEAR[type]);
      expect(iso(periods[0]!.startDate), type).toBe('2026-04-01T00:00:00.000Z');
      expect(iso(periods[periods.length - 1]!.endDateExclusive), type).toBe(
        '2027-04-01T00:00:00.000Z',
      );
    }
  });
});

describe('periodKey / periodLabel formatting', () => {
  it('zero-pads the month index to 2 digits and leaves the others unpadded', () => {
    expect(periodKey(2026, 3, 'MONTH')).toBe('FY2026-P03');
    expect(periodKey(2026, 12, 'MONTH')).toBe('FY2026-P12');
    expect(periodKey(2026, 3, 'QUARTER')).toBe('FY2026-Q3');
    expect(periodKey(2026, 2, 'HALF')).toBe('FY2026-H2');
    expect(periodKey(2026, 1, 'YEAR')).toBe('FY2026-Y1');
  });

  it('labels months by calendar month abbreviation, shifted by the start month', () => {
    // startMonth 1, index 3 -> March.  startMonth 4, index 3 -> June.
    expect(periodLabel(2026, 3, 'MONTH', CALENDAR)).toBe('Mar FY2026');
    expect(periodLabel(2026, 3, 'MONTH', APRIL_START)).toBe('Jun FY2026');
    // startMonth 4, index 10 -> Apr + 9 months = January.
    expect(periodLabel(2026, 10, 'MONTH', APRIL_START)).toBe('Jan FY2026');
  });

  it('labels quarters, halves and years', () => {
    expect(periodLabel(2026, 2, 'QUARTER')).toBe('Q2 FY2026');
    expect(periodLabel(2026, 1, 'HALF')).toBe('H1 FY2026');
    expect(periodLabel(2026, 1, 'YEAR')).toBe('FY2026');
  });
});

describe('parsePeriodKey', () => {
  it('round-trips every period of every type', () => {
    for (const type of ['MONTH', 'QUARTER', 'HALF', 'YEAR'] as PeriodType[]) {
      for (let index = 1; index <= PERIODS_PER_YEAR[type]; index += 1) {
        const key = periodKey(2026, index, type);
        expect(parsePeriodKey(key), key).toEqual({
          fiscalYear: 2026,
          periodIndex: index,
          periodType: type,
        });
      }
    }
  });

  it('round-trips the keys buildFiscalYear emits', () => {
    for (const period of buildFiscalYear(2026, 'MONTH', APRIL_START)) {
      expect(parsePeriodKey(period.key)).toEqual({
        fiscalYear: period.fiscalYear,
        periodIndex: period.periodIndex,
        periodType: period.periodType,
      });
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePeriodKey('  FY2026-P03  ')).toEqual({
      fiscalYear: 2026,
      periodIndex: 3,
      periodType: 'MONTH',
    });
  });

  it('returns null on malformed input', () => {
    for (const bad of [
      '',
      'FY2026',
      'FY26-P01', // year must be 4 digits
      'FY2026-P', // missing index
      'FY2026-X01', // unknown prefix
      'FY2026-P001', // index is 1-2 digits
      '2026-P01', // missing FY
      'FY2026P01', // missing separator
      'fy2026-p01', // case-sensitive
      'FY2026-P01 extra',
    ]) {
      expect(parsePeriodKey(bad), bad).toBeNull();
    }
  });

  it('returns null on an out-of-range index', () => {
    // QUARTER has 4 periods, so Q05 is not a real period.
    expect(parsePeriodKey('FY2026-Q05')).toBeNull();
    expect(parsePeriodKey('FY2026-Q5')).toBeNull();
    expect(parsePeriodKey('FY2026-P13')).toBeNull();
    expect(parsePeriodKey('FY2026-H3')).toBeNull();
    expect(parsePeriodKey('FY2026-Y2')).toBeNull();
    // ...and on a zero index, since indices are 1-based.
    expect(parsePeriodKey('FY2026-P00')).toBeNull();
    expect(parsePeriodKey('FY2026-Q0')).toBeNull();
  });

  it('accepts the top of each range', () => {
    expect(parsePeriodKey('FY2026-P12')?.periodIndex).toBe(12);
    expect(parsePeriodKey('FY2026-Q4')?.periodIndex).toBe(4);
    expect(parsePeriodKey('FY2026-H2')?.periodIndex).toBe(2);
    expect(parsePeriodKey('FY2026-Y1')?.periodIndex).toBe(1);
  });
});

describe('periodForDate', () => {
  it('finds the month containing a date in a calendar year', () => {
    const period = periodForDate(new Date('2026-08-07T12:00:00Z'), 'MONTH', CALENDAR);
    expect(period.key).toBe('FY2026-P08');
    expect(period.label).toBe('Aug FY2026');
    expect(period.quarter).toBe(3);
  });

  it('finds the fiscal month in an April-start year', () => {
    // Apr=P01, May=P02, Jun=P03 -> 15 Jun 2026 is P03 of FY2026.
    const period = periodForDate(new Date('2026-06-15T00:00:00Z'), 'MONTH', APRIL_START);
    expect(period.key).toBe('FY2026-P03');
    expect(period.label).toBe('Jun FY2026');
    expect(period.fiscalYear).toBe(2026);
    expect(period.quarter).toBe(1);
  });

  it('puts a January date into the back half of an April-start fiscal year', () => {
    // Jan 2027 is fiscal month 10 of FY2026 (Apr 2026 start).
    const period = periodForDate(new Date('2027-01-10T00:00:00Z'), 'MONTH', APRIL_START);
    expect(period.key).toBe('FY2026-P10');
    expect(period.fiscalYear).toBe(2026);
  });

  it('is inclusive of the start instant and exclusive of the end instant', () => {
    expect(periodForDate(new Date('2026-02-01T00:00:00.000Z'), 'MONTH', CALENDAR).key).toBe(
      'FY2026-P02',
    );
    expect(periodForDate(new Date('2026-01-31T23:59:59.999Z'), 'MONTH', CALENDAR).key).toBe(
      'FY2026-P01',
    );
  });

  it('works for quarters, halves and years', () => {
    const date = new Date('2026-08-07T00:00:00Z');
    expect(periodForDate(date, 'QUARTER', CALENDAR).key).toBe('FY2026-Q3');
    expect(periodForDate(date, 'HALF', CALENDAR).key).toBe('FY2026-H2');
    expect(periodForDate(date, 'YEAR', CALENDAR).key).toBe('FY2026-Y1');
  });

  it('defaults to monthly periods on the calendar configuration', () => {
    expect(periodForDate(new Date('2026-05-05T00:00:00Z')).key).toBe('FY2026-P05');
  });
});

describe('periodsYearToDate', () => {
  it('slices from the start of the year through the given index inclusive', () => {
    const ytd = periodsYearToDate(2026, 3, 'MONTH', CALENDAR);
    expect(ytd).toHaveLength(3);
    expect(ytd.map((p) => p.key)).toEqual(['FY2026-P01', 'FY2026-P02', 'FY2026-P03']);
    expect(iso(ytd[2]!.endDateExclusive)).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns the whole year at the last index', () => {
    expect(periodsYearToDate(2026, 12, 'MONTH', CALENDAR)).toHaveLength(12);
    expect(periodsYearToDate(2026, 4, 'QUARTER', CALENDAR)).toHaveLength(4);
  });

  it('throws when the index is out of range', () => {
    expect(() => periodsYearToDate(2026, 0)).toThrow(RangeError);
    expect(() => periodsYearToDate(2026, 13)).toThrow(RangeError);
    expect(() => periodsYearToDate(2026, 5, 'QUARTER')).toThrow(/out of range for QUARTER/);
    expect(() => periodsYearToDate(2026, -1)).toThrow(RangeError);
  });
});

describe('yearElapsedFraction', () => {
  it('is periodIndex / periodsPerYear', () => {
    expect(yearElapsedFraction(3, 'MONTH')).toBeCloseTo(0.25, 12); // 3/12
    expect(yearElapsedFraction(6, 'MONTH')).toBeCloseTo(0.5, 12); // 6/12
    expect(yearElapsedFraction(12, 'MONTH')).toBe(1);
    expect(yearElapsedFraction(1, 'QUARTER')).toBe(0.25);
    expect(yearElapsedFraction(1, 'HALF')).toBe(0.5);
    expect(yearElapsedFraction(1, 'YEAR')).toBe(1);
  });

  it('permits zero (nothing elapsed)', () => {
    expect(yearElapsedFraction(0, 'MONTH')).toBe(0);
  });

  it('defaults to monthly periods', () => {
    expect(yearElapsedFraction(9)).toBeCloseTo(0.75, 12);
  });

  it('throws outside [0, periodsPerYear]', () => {
    expect(() => yearElapsedFraction(-1)).toThrow(RangeError);
    expect(() => yearElapsedFraction(13)).toThrow(RangeError);
    expect(() => yearElapsedFraction(5, 'QUARTER')).toThrow(/out of range for QUARTER/);
  });
});

describe('buildPeriodAxis', () => {
  it('spans multiple fiscal years contiguously', () => {
    const axis = buildPeriodAxis(2026, 3, 'MONTH', CALENDAR);
    expect(axis).toHaveLength(36); // 3 years x 12 months
    expect(iso(axis[0]!.startDate)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(axis[35]!.endDateExclusive)).toBe('2029-01-01T00:00:00.000Z');
    for (let i = 1; i < axis.length; i += 1) {
      expect(axis[i]!.startDate.getTime(), `gap before ${axis[i]!.key}`).toBe(
        axis[i - 1]!.endDateExclusive.getTime(),
      );
    }
  });

  it('remains contiguous across a non-calendar fiscal boundary', () => {
    const axis = buildPeriodAxis(2026, 2, 'MONTH', APRIL_START);
    expect(axis).toHaveLength(24);
    expect(iso(axis[0]!.startDate)).toBe('2026-04-01T00:00:00.000Z');
    // Last month of FY2026 is Mar 2027; FY2027 P01 opens 2027-04-01.
    expect(iso(axis[11]!.endDateExclusive)).toBe('2027-04-01T00:00:00.000Z');
    expect(iso(axis[12]!.startDate)).toBe('2027-04-01T00:00:00.000Z');
    expect(axis[12]!.key).toBe('FY2027-P01');
    expect(iso(axis[23]!.endDateExclusive)).toBe('2028-04-01T00:00:00.000Z');
  });

  it('emits unique keys across the whole axis', () => {
    const axis = buildPeriodAxis(2026, 5, 'MONTH', CALENDAR);
    expect(new Set(axis.map((p) => p.key)).size).toBe(axis.length);
  });

  it('works for coarser period types', () => {
    expect(buildPeriodAxis(2026, 3, 'QUARTER', CALENDAR)).toHaveLength(12);
    expect(buildPeriodAxis(2026, 3, 'YEAR', CALENDAR)).toHaveLength(3);
  });

  it('throws when yearCount is below 1', () => {
    expect(() => buildPeriodAxis(2026, 0)).toThrow(RangeError);
    expect(() => buildPeriodAxis(2026, -2)).toThrow(/yearCount must be at least 1/);
  });

  it('accepts a single year', () => {
    expect(buildPeriodAxis(2026, 1, 'MONTH', CALENDAR)).toHaveLength(12);
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole days forward', () => {
    // 2026-03-01 to 2026-03-08 is exactly 7 days.
    expect(
      calendarDaysBetween(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-08T00:00:00Z')),
    ).toBe(7);
  });

  it('ignores the time of day on both sides', () => {
    // 23:59 on the 1st to 00:01 on the 2nd is 2 minutes but one calendar day -
    // the whole reason this is not a millisecond division.
    expect(
      calendarDaysBetween(new Date('2026-03-01T23:59:00Z'), new Date('2026-03-02T00:01:00Z')),
    ).toBe(1);
    // And 00:01 to 23:59 on the same day is still 0.
    expect(
      calendarDaysBetween(new Date('2026-03-01T00:01:00Z'), new Date('2026-03-01T23:59:00Z')),
    ).toBe(0);
  });

  it('returns a negative count once the date has passed', () => {
    expect(
      calendarDaysBetween(new Date('2026-03-10T09:00:00Z'), new Date('2026-03-07T17:00:00Z')),
    ).toBe(-3);
  });

  it('crosses a month boundary', () => {
    // 2026-01-28 to 2026-02-03: 3 days left in January (29, 30, 31) + 3 = 6.
    expect(
      calendarDaysBetween(new Date('2026-01-28T00:00:00Z'), new Date('2026-02-03T00:00:00Z')),
    ).toBe(6);
  });

  it('crosses a leap day', () => {
    // 2028 is a leap year: 2028-02-27 to 2028-03-01 is 27->28->29->1 = 3 days.
    expect(
      calendarDaysBetween(new Date('2028-02-27T00:00:00Z'), new Date('2028-03-01T00:00:00Z')),
    ).toBe(3);
    // 2026 is not: 2026-02-27 to 2026-03-01 is 27->28->1 = 2 days.
    expect(
      calendarDaysBetween(new Date('2026-02-27T00:00:00Z'), new Date('2026-03-01T00:00:00Z')),
    ).toBe(2);
  });

  it('crosses a year boundary', () => {
    expect(
      calendarDaysBetween(new Date('2025-12-30T00:00:00Z'), new Date('2026-01-02T00:00:00Z')),
    ).toBe(3);
  });
});
