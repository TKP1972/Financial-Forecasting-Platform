/**
 * Rate cards: what an hour of a given labour category costs, by location,
 * channel and complexity, as at a date.
 *
 * Three things make this harder than a lookup table, and all three are places
 * real pricing models go wrong:
 *
 *  1. **Effective dating.** Rates change. A five-year contract crosses those
 *     changes, so pricing it needs the rate in force in each year, not today's.
 *  2. **Overlapping versions.** If two entries with the same dimensions are both
 *     in force on a date, the "right" rate depends on iteration order. That is
 *     rejected at validation rather than resolved arbitrarily.
 *  3. **Partial matches.** A card rarely enumerates every combination. Falling
 *     back from the specific to the general is what makes it usable - but the
 *     fallback has to be deterministic, and the result has to say which rule it
 *     landed on, or nobody can defend the price.
 */
import {
  CalculationError,
  escalationFactor,
  toDecimal,
  toMoneyString,
  type Decimal,
  type MoneyInput,
} from '@ffp/shared';

/** A wildcard dimension matches any query value. */
export type Dimension = string | null | undefined;

export interface RateCardEntry {
  id?: string;
  labourCategory: string;
  /** Null or absent means "any location". Same for the other two. */
  location?: Dimension;
  channel?: Dimension;
  complexity?: Dimension;
  rate: MoneyInput;
  /** Inclusive. */
  effectiveFrom: Date | string;
  /** Exclusive. Absent means open-ended. */
  effectiveTo?: Date | string | null;
}

export interface RateQuery {
  labourCategory: string;
  location?: string;
  channel?: string;
  complexity?: string;
}

export interface ResolvedRate {
  rate: string;
  /** The entry that supplied it. */
  entry: RateCardEntry;
  /**
   * How specific the match was. See the weighting note below - higher is more
   * specific, and the value is unique per wildcard pattern.
   */
  specificity: number;
  /** Dimensions the query supplied that the matched entry wildcarded. */
  fellBackOn: string[];
  /** Human-readable account of why this entry won. */
  explanation: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Dimension weights.
 *
 * Powers of two, so every combination of matched dimensions produces a distinct
 * total and two candidates can never tie. A plain count would leave
 * (location, complexity) and (location, channel) both scoring 2, and the winner
 * would depend on array order - which is exactly the kind of non-determinism
 * that makes a quoted price impossible to reproduce.
 *
 * The ordering encodes that location moves rates most, then channel, then
 * complexity.
 */
const DIMENSION_WEIGHT = { location: 4, channel: 2, complexity: 1 } as const;
type DimensionName = keyof typeof DIMENSION_WEIGHT;
const DIMENSION_NAMES: DimensionName[] = ['location', 'channel', 'complexity'];

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw CalculationError(`'${String(value)}' is not a valid date.`);
  }
  return date;
}

function normalise(value: Dimension): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Stable key for the dimension tuple, used to group entries for overlap checks. */
function dimensionKey(entry: RateCardEntry): string {
  return [
    entry.labourCategory.trim().toLowerCase(),
    normalise(entry.location)?.toLowerCase() ?? '*',
    normalise(entry.channel)?.toLowerCase() ?? '*',
    normalise(entry.complexity)?.toLowerCase() ?? '*',
  ].join('|');
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

export interface RateCardValidation {
  valid: boolean;
  entryCount: number;
  issues: Array<{
    kind: 'OVERLAP' | 'INVALID_RANGE' | 'NEGATIVE_RATE';
    message: string;
    entries: number[];
  }>;
}

/**
 * Check a card before it can be used to price anything.
 *
 * Overlaps are the important one: two entries with identical dimensions whose
 * effective ranges intersect mean there are two valid rates on some date, and
 * whichever the code happens to pick is not a decision anybody made.
 */
export function validateRateCard(entries: readonly RateCardEntry[]): RateCardValidation {
  const issues: RateCardValidation['issues'] = [];

  entries.forEach((entry, index) => {
    const from = toDate(entry.effectiveFrom);
    const to = entry.effectiveTo ? toDate(entry.effectiveTo) : null;

    if (to && to <= from) {
      issues.push({
        kind: 'INVALID_RANGE',
        message: `Entry ${index + 1} (${entry.labourCategory}) ends on or before it starts.`,
        entries: [index],
      });
    }
    if (toDecimal(entry.rate).isNegative()) {
      issues.push({
        kind: 'NEGATIVE_RATE',
        message: `Entry ${index + 1} (${entry.labourCategory}) has a negative rate.`,
        entries: [index],
      });
    }
  });

  const byKey = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = dimensionKey(entry);
    byKey.set(key, [...(byKey.get(key) ?? []), index]);
  });

  for (const indices of byKey.values()) {
    if (indices.length < 2) continue;

    // Sort by start date, then a single pass finds any intersection.
    const sorted = [...indices].sort(
      (a, b) =>
        toDate((entries[a] as RateCardEntry).effectiveFrom).getTime() -
        toDate((entries[b] as RateCardEntry).effectiveFrom).getTime(),
    );

    for (let i = 1; i < sorted.length; i += 1) {
      const previousIndex = sorted[i - 1] as number;
      const currentIndex = sorted[i] as number;
      const previous = entries[previousIndex] as RateCardEntry;
      const current = entries[currentIndex] as RateCardEntry;

      const previousEnd = previous.effectiveTo ? toDate(previous.effectiveTo) : null;
      const currentStart = toDate(current.effectiveFrom);

      // Open-ended previous, or an end after the next start, means both are in
      // force at once.
      if (previousEnd === null || previousEnd > currentStart) {
        issues.push({
          kind: 'OVERLAP',
          message: `Entries ${previousIndex + 1} and ${currentIndex + 1} (${current.labourCategory}) are both in force at the same time for the same dimensions. Close the earlier one before the later one starts.`,
          entries: [previousIndex, currentIndex],
        });
      }
    }
  }

  return { valid: issues.length === 0, entryCount: entries.length, issues };
}

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

/**
 * Find the rate for a query as at a date.
 *
 * Candidates are entries whose labour category matches, whose effective range
 * covers the date, and whose every declared dimension either matches the query
 * or is a wildcard. The most specific candidate wins.
 */
export function resolveRate(
  entries: readonly RateCardEntry[],
  query: RateQuery,
  asOf: Date | string,
): ResolvedRate {
  const at = toDate(asOf);
  const category = query.labourCategory.trim().toLowerCase();

  const inForce = entries.filter((entry) => {
    if (entry.labourCategory.trim().toLowerCase() !== category) return false;
    const from = toDate(entry.effectiveFrom);
    const to = entry.effectiveTo ? toDate(entry.effectiveTo) : null;
    return from <= at && (to === null || at < to);
  });

  if (inForce.length === 0) {
    throw CalculationError(
      `No rate is in force for '${query.labourCategory}' on ${at.toISOString().slice(0, 10)}. Either the labour category is not on this rate card, or the card does not cover that date.`,
      { labourCategory: query.labourCategory, asOf: at.toISOString() },
    );
  }

  let best: { entry: RateCardEntry; specificity: number; fellBackOn: string[] } | null = null;

  for (const entry of inForce) {
    let specificity = 0;
    const fellBackOn: string[] = [];
    let compatible = true;

    for (const dimension of DIMENSION_NAMES) {
      const entryValue = normalise(entry[dimension]);
      const queryValue = normalise(query[dimension]);

      if (entryValue === null) {
        // Wildcard. Only counts as a fallback if the caller actually asked for
        // something on this dimension.
        if (queryValue !== null) fellBackOn.push(dimension);
        continue;
      }
      if (queryValue === null || entryValue.toLowerCase() !== queryValue.toLowerCase()) {
        compatible = false;
        break;
      }
      specificity += DIMENSION_WEIGHT[dimension];
    }

    if (!compatible) continue;
    if (best === null || specificity > best.specificity) {
      best = { entry, specificity, fellBackOn };
    }
  }

  if (best === null) {
    const asked = DIMENSION_NAMES.filter((d) => normalise(query[d]) !== null)
      .map((d) => `${d}=${query[d]}`)
      .join(', ');
    throw CalculationError(
      `'${query.labourCategory}' has rates in force on ${at.toISOString().slice(0, 10)}, but none matches ${asked || 'the query'}. Add a wildcard entry to act as a default.`,
      { labourCategory: query.labourCategory, query },
    );
  }

  const matched = DIMENSION_NAMES.filter((d) => normalise(best.entry[d]) !== null);
  const explanation =
    matched.length === 0
      ? `Matched the default rate for ${best.entry.labourCategory} (no dimensions specified on the entry).`
      : `Matched on ${matched.join(', ')}` +
        (best.fellBackOn.length > 0
          ? `; fell back to the default for ${best.fellBackOn.join(', ')}.`
          : '.');

  return {
    rate: toMoneyString(best.entry.rate, 6),
    entry: best.entry,
    specificity: best.specificity,
    fellBackOn: best.fellBackOn,
    explanation,
    effectiveFrom: toDate(best.entry.effectiveFrom).toISOString(),
    effectiveTo: best.entry.effectiveTo ? toDate(best.entry.effectiveTo).toISOString() : null,
  };
}

// --------------------------------------------------------------------------
// Rate schedules across a term
// --------------------------------------------------------------------------

export interface RateScheduleEntry {
  year: number;
  asOf: string;
  rate: string;
  /** True when this year's rate differs from the previous year's. */
  changed: boolean;
  source: 'RATE_CARD' | 'ESCALATED';
  explanation: string;
}

export interface RateSchedule {
  labourCategory: string;
  entries: RateScheduleEntry[];
  /** Rates in the shape the pricing model consumes. */
  ratesByYear: string[];
  warnings: string[];
}

export interface RateScheduleOptions {
  /** Contract start. Year 1 is priced as at this date. */
  startDate: Date | string;
  years: number;
  /**
   * Applied to the last card rate for years the card does not reach, rather
   * than silently holding it flat. A rate card that stops before the contract
   * does is a real situation and pretending otherwise understates cost.
   */
  escalationBeyondCard?: MoneyInput;
}

/**
 * Build a year-by-year rate schedule for a term.
 *
 * Each contract year is priced at the rate in force on its anniversary, so a
 * card version that takes effect mid-term is picked up automatically. That is
 * the whole reason effective dating exists, and it is exactly what a manually
 * maintained spreadsheet misses.
 */
export function buildRateSchedule(
  entries: readonly RateCardEntry[],
  query: RateQuery,
  options: RateScheduleOptions,
): RateSchedule {
  const { startDate, years } = options;
  if (!Number.isInteger(years) || years < 1 || years > 20) {
    throw CalculationError(`Contract term must be between 1 and 20 years, got ${years}.`);
  }

  const start = toDate(startDate);
  const warnings: string[] = [];
  const scheduleEntries: RateScheduleEntry[] = [];

  let lastCardRate: Decimal | null = null;
  let yearsBeyondCard = 0;

  for (let year = 0; year < years; year += 1) {
    const asOf = new Date(start);
    asOf.setUTCFullYear(asOf.getUTCFullYear() + year);

    let rate: Decimal;
    let source: RateScheduleEntry['source'];
    let explanation: string;

    try {
      const resolved = resolveRate(entries, query, asOf);
      rate = toDecimal(resolved.rate);
      lastCardRate = rate;
      yearsBeyondCard = 0;
      source = 'RATE_CARD';
      explanation = resolved.explanation;
    } catch (error) {
      // The card does not reach this year. Escalate the last known rate rather
      // than failing outright, and say so.
      if (lastCardRate === null) throw error;
      yearsBeyondCard += 1;
      const escalation = options.escalationBeyondCard ?? '0';
      rate = lastCardRate.times(escalationFactor(escalation, yearsBeyondCard));
      source = 'ESCALATED';
      explanation = `The rate card does not cover ${asOf.toISOString().slice(0, 10)}; escalated the last card rate by ${toMoneyString(toDecimal(escalation).times(100), 2)}% for ${yearsBeyondCard} year(s).`;
      warnings.push(
        `The rate card ends before contract year ${year + 1}. Rates from that point are escalated estimates, not agreed rates - extend the card before quoting.`,
      );
    }

    const previous = scheduleEntries.at(-1);
    scheduleEntries.push({
      year: year + 1,
      asOf: asOf.toISOString(),
      rate: toMoneyString(rate, 6),
      changed: previous !== undefined && previous.rate !== toMoneyString(rate, 6),
      source,
      explanation,
    });
  }

  const changes = scheduleEntries.filter((e) => e.changed).length;
  if (changes > 0) {
    warnings.push(
      `The rate changes ${changes} time(s) during the term because the card is effective-dated. Each contract year is priced at the rate in force on its anniversary.`,
    );
  }

  return {
    labourCategory: query.labourCategory,
    entries: scheduleEntries,
    ratesByYear: scheduleEntries.map((e) => e.rate),
    warnings: [...new Set(warnings)],
  };
}

/** Every distinct dimension value present on a card, for building a UI. */
export function rateCardDimensions(entries: readonly RateCardEntry[]): {
  labourCategories: string[];
  locations: string[];
  channels: string[];
  complexities: string[];
} {
  const collect = (pick: (e: RateCardEntry) => Dimension): string[] =>
    [
      ...new Set(entries.map((e) => normalise(pick(e))).filter((v): v is string => v !== null)),
    ].sort();

  return {
    labourCategories: [...new Set(entries.map((e) => e.labourCategory.trim()))].sort(),
    locations: collect((e) => e.location),
    channels: collect((e) => e.channel),
    complexities: collect((e) => e.complexity),
  };
}
