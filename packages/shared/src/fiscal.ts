/**
 * Fiscal calendar.
 *
 * Organisations rarely run on the Gregorian year - a fiscal year starting in
 * April or October is normal. Every period label, quarter boundary and
 * year-to-date cut in the platform derives from here so that "Q1" means the same
 * thing in a forecast, a variance report and a leadership pack.
 */
import { PERIODS_PER_YEAR, type PeriodType } from './domain.js';

/** Month the fiscal year opens on: 1 = January ... 12 = December. */
export type FiscalYearStartMonth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface FiscalConfig {
  /** Calendar month the fiscal year begins. */
  startMonth: FiscalYearStartMonth;
  /**
   * How the fiscal year is named. `END` means FY2026 ends in calendar 2026
   * (common in the UK/AU); `START` means FY2026 begins in calendar 2026.
   */
  labelBy: 'START' | 'END';
}

export const DEFAULT_FISCAL_CONFIG: FiscalConfig = { startMonth: 1, labelBy: 'START' };

export interface FiscalPeriod {
  /** Stable sortable key, e.g. "FY2026-P03". */
  key: string;
  /** Human label, e.g. "Mar FY2026". */
  label: string;
  fiscalYear: number;
  /** 1-based index within the fiscal year. */
  periodIndex: number;
  /** 1-based fiscal quarter (1-4); always 1 for YEAR periods. */
  quarter: number;
  periodType: PeriodType;
  /** Inclusive UTC start of the period. */
  startDate: Date;
  /** Exclusive UTC end of the period. */
  endDateExclusive: Date;
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function utc(year: number, month1: number, day = 1): Date {
  return new Date(Date.UTC(year, month1 - 1, day, 0, 0, 0, 0));
}

/** Calendar month (1-12) in which fiscal month `index` (1-based) falls. */
function calendarMonthFor(
  startMonth: FiscalYearStartMonth,
  index: number,
): { month: number; yearOffset: number } {
  const zeroBased = startMonth - 1 + (index - 1);
  return { month: (zeroBased % 12) + 1, yearOffset: Math.floor(zeroBased / 12) };
}

/** Calendar year in which a given fiscal year opens. */
export function calendarYearOfFiscalStart(fiscalYear: number, config: FiscalConfig): number {
  if (config.startMonth === 1) return fiscalYear;
  return config.labelBy === 'START' ? fiscalYear : fiscalYear - 1;
}

/** Which fiscal year a calendar date belongs to. */
export function fiscalYearOf(date: Date, config: FiscalConfig = DEFAULT_FISCAL_CONFIG): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const startYear = m >= config.startMonth ? y : y - 1;
  if (config.startMonth === 1) return startYear;
  return config.labelBy === 'START' ? startYear : startYear + 1;
}

/**
 * Build every period of a fiscal year, in order.
 * The result is the canonical period axis for that year - forecasts, budgets and
 * actuals all align to it.
 */
export function buildFiscalYear(
  fiscalYear: number,
  periodType: PeriodType = 'MONTH',
  config: FiscalConfig = DEFAULT_FISCAL_CONFIG,
): FiscalPeriod[] {
  const count = PERIODS_PER_YEAR[periodType];
  const monthsPerPeriod = 12 / count;
  const startCalYear = calendarYearOfFiscalStart(fiscalYear, config);

  return Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const firstMonthIndex = i * monthsPerPeriod + 1;
    const start = calendarMonthFor(config.startMonth, firstMonthIndex);
    const startDate = utc(startCalYear + start.yearOffset, start.month);

    const nextFirstMonthIndex = firstMonthIndex + monthsPerPeriod;
    const next = calendarMonthFor(config.startMonth, nextFirstMonthIndex);
    const endDateExclusive = utc(startCalYear + next.yearOffset, next.month);

    return {
      key: periodKey(fiscalYear, index, periodType),
      label: periodLabel(fiscalYear, index, periodType, config),
      fiscalYear,
      periodIndex: index,
      quarter: periodType === 'YEAR' ? 1 : Math.floor((firstMonthIndex - 1) / 3) + 1,
      periodType,
      startDate,
      endDateExclusive,
    };
  });
}

const PERIOD_PREFIX: Record<PeriodType, string> = {
  MONTH: 'P',
  QUARTER: 'Q',
  HALF: 'H',
  YEAR: 'Y',
};

export function periodKey(fiscalYear: number, periodIndex: number, periodType: PeriodType): string {
  const width = periodType === 'MONTH' ? 2 : 1;
  return `FY${fiscalYear}-${PERIOD_PREFIX[periodType]}${String(periodIndex).padStart(width, '0')}`;
}

export function periodLabel(
  fiscalYear: number,
  periodIndex: number,
  periodType: PeriodType,
  config: FiscalConfig = DEFAULT_FISCAL_CONFIG,
): string {
  if (periodType === 'YEAR') return `FY${fiscalYear}`;
  if (periodType === 'MONTH') {
    const { month } = calendarMonthFor(config.startMonth, periodIndex);
    return `${MONTH_ABBR[month - 1]} FY${fiscalYear}`;
  }
  return `${PERIOD_PREFIX[periodType]}${periodIndex} FY${fiscalYear}`;
}

/** Parse a period key back into its parts. Returns null on malformed input. */
export function parsePeriodKey(
  key: string,
): { fiscalYear: number; periodIndex: number; periodType: PeriodType } | null {
  const match = /^FY(\d{4})-([PQHY])(\d{1,2})$/.exec(key.trim());
  if (!match) return null;
  const [, yearStr, prefix, indexStr] = match;
  const byPrefix: Record<string, PeriodType> = { P: 'MONTH', Q: 'QUARTER', H: 'HALF', Y: 'YEAR' };
  const periodType = byPrefix[prefix as string];
  if (!periodType) return null;
  const periodIndex = Number(indexStr);
  if (periodIndex < 1 || periodIndex > PERIODS_PER_YEAR[periodType]) return null;
  return { fiscalYear: Number(yearStr), periodIndex, periodType };
}

/** The period containing `date`. */
export function periodForDate(
  date: Date,
  periodType: PeriodType = 'MONTH',
  config: FiscalConfig = DEFAULT_FISCAL_CONFIG,
): FiscalPeriod {
  const fy = fiscalYearOf(date, config);
  const periods = buildFiscalYear(fy, periodType, config);
  const found = periods.find((p) => date >= p.startDate && date < p.endDateExclusive);
  // Only reachable if the date sits outside its own fiscal year, which cannot
  // happen given fiscalYearOf - guard kept so a future config bug surfaces loudly.
  if (!found) throw new RangeError(`No ${periodType} period found for ${date.toISOString()}`);
  return found;
}

/**
 * Periods from the start of the fiscal year up to and including `throughIndex`.
 * This is the YTD window that variance reports slice on.
 */
export function periodsYearToDate(
  fiscalYear: number,
  throughIndex: number,
  periodType: PeriodType = 'MONTH',
  config: FiscalConfig = DEFAULT_FISCAL_CONFIG,
): FiscalPeriod[] {
  const count = PERIODS_PER_YEAR[periodType];
  if (throughIndex < 1 || throughIndex > count) {
    throw new RangeError(`Period index ${throughIndex} out of range for ${periodType}`);
  }
  return buildFiscalYear(fiscalYear, periodType, config).slice(0, throughIndex);
}

/** How far through the fiscal year we are, as a fraction - drives run-rate projections. */
export function yearElapsedFraction(periodIndex: number, periodType: PeriodType = 'MONTH'): number {
  const count = PERIODS_PER_YEAR[periodType];
  if (periodIndex < 0 || periodIndex > count) {
    throw new RangeError(`Period index ${periodIndex} out of range for ${periodType}`);
  }
  return periodIndex / count;
}

/**
 * Whole days from `from` to `to`, counted on calendar-day boundaries in UTC.
 *
 * Deliberately not `(to - from) / 86400000`. A deadline nine hours away would
 * otherwise be "in 0 days" for part of the day and "in 1 day" for the rest,
 * depending purely on what time the reminder job happened to run - so the same
 * deadline would be described differently to two people on the same morning.
 * Deadlines are calendar dates and everyone reading a reminder thinks in
 * calendar days. Negative means the date has passed.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const startOfFrom = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const startOfTo = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((startOfTo - startOfFrom) / 86_400_000);
}

/** Contiguous period axis spanning multiple fiscal years, for multi-year models. */
export function buildPeriodAxis(
  startFiscalYear: number,
  yearCount: number,
  periodType: PeriodType = 'MONTH',
  config: FiscalConfig = DEFAULT_FISCAL_CONFIG,
): FiscalPeriod[] {
  if (yearCount < 1) throw new RangeError('yearCount must be at least 1');
  return Array.from({ length: yearCount }, (_, i) =>
    buildFiscalYear(startFiscalYear + i, periodType, config),
  ).flat();
}
