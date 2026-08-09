/**
 * Indirect cost (burden) application.
 *
 * The single most common error in a home-grown pricing model is applying burden
 * pools to the wrong base, or in the wrong order - G&A on a base that already
 * includes G&A, overhead applied before fringe, and so on. A 1% base error on a
 * 30% pool is a real margin error.
 *
 * So the base of every pool is declared explicitly, pools are applied in a fixed
 * order, and a pool may only draw on elements resolved *before* it. Anything else
 * is rejected at validation time rather than quietly producing a wrong price.
 */
import {
  BURDEN_POOLS,
  CalculationError,
  Decimal,
  add,
  toDecimal,
  type BurdenPool,
  type MoneyInput,
} from '@ffp/shared';

/** Direct-cost buckets a burden pool can draw on, alongside earlier pools. */
export const DIRECT_BASE_ELEMENTS = [
  'DIRECT_LABOUR',
  'DIRECT_NON_LABOUR',
  'MATERIAL',
  'SUBCONTRACT',
] as const;
export type DirectBaseElement = (typeof DIRECT_BASE_ELEMENTS)[number];

export type BurdenBaseElement = DirectBaseElement | BurdenPool;

/** Position of each pool in the application order. */
const POOL_ORDER: Record<BurdenPool, number> = BURDEN_POOLS.reduce(
  (acc, pool, index) => ({ ...acc, [pool]: index }),
  {} as Record<BurdenPool, number>,
);

/**
 * Conventional bases. Overridable per model - some organisations run a single
 * combined pool, and some omit pools entirely.
 *
 * FRINGE, OVERHEAD, MATERIAL_HANDLING and GA are ordinary absorption costing,
 * taught in every management-accounting syllabus and used worldwide. Nothing
 * about them is jurisdictional.
 *
 * **COM is different, and this comment used to say otherwise.** Applying a
 * cost-of-money burden to a cost base is the Facilities Capital Cost of Money
 * pattern from US federal cost accounting. Commercial cost accounting does not
 * absorb interest into a cost base at all - it records it below the line. Cost
 * of money as an internal charge does exist commercially (EVA, transfer
 * pricing), but not as a pool over direct labour inside a price build-up.
 *
 * A commercial user should **omit the COM pool**, not re-rate it. Leaving it at
 * a zero rate would still show a line on the build-up that their accountants
 * would not recognise.
 *
 * The wider constraint this sits inside is commercial, not legal: the whole
 * module assumes cost-plus pricing with ordered absorption and fee on a burdened
 * base. It suits contractors and professional services in any jurisdiction, and
 * suits a market-priced business poorly in all of them. See
 * docs/localisation-policy.md.
 */
export const STANDARD_BURDEN_BASES: Record<BurdenPool, BurdenBaseElement[]> = {
  FRINGE: ['DIRECT_LABOUR'],
  OVERHEAD: ['DIRECT_LABOUR', 'FRINGE'],
  MATERIAL_HANDLING: ['MATERIAL', 'SUBCONTRACT'],
  GA: ['DIRECT_LABOUR', 'FRINGE', 'OVERHEAD', 'DIRECT_NON_LABOUR', 'MATERIAL_HANDLING'],
  COM: ['DIRECT_LABOUR', 'FRINGE', 'OVERHEAD'],
};

export interface BurdenDefinition {
  pool: BurdenPool;
  /** One rate per contract year. A single entry applies to every year. */
  ratesByYear: MoneyInput[];
  /** Base composition. Defaults to {@link STANDARD_BURDEN_BASES}. */
  base?: BurdenBaseElement[];
}

/** Direct costs for a single year, split into the buckets burdens draw on. */
export interface DirectCostBasis {
  directLabour: Decimal;
  /** Non-labour direct costs excluding material and subcontract. */
  otherDirect: Decimal;
  material: Decimal;
  subcontract: Decimal;
  /** Excluded from every burden base and from fee, by definition. */
  passThrough: Decimal;
}

export interface AppliedBurden {
  pool: BurdenPool;
  rate: string;
  base: string;
  amount: string;
  baseElements: BurdenBaseElement[];
}

export interface BurdenResult {
  applied: AppliedBurden[];
  /** Total indirect cost for the year. */
  totalBurden: Decimal;
  /** Amount of each pool, keyed by pool, for downstream reporting. */
  byPool: Record<string, Decimal>;
}

/**
 * Reject configurations that cannot be evaluated in order.
 * Called once per model rather than per year, since the shape is year-invariant.
 */
export function validateBurdens(burdens: readonly BurdenDefinition[]): void {
  const seen = new Set<BurdenPool>();
  for (const burden of burdens) {
    if (seen.has(burden.pool)) {
      throw CalculationError(`Burden pool ${burden.pool} is defined more than once.`, {
        pool: burden.pool,
      });
    }
    seen.add(burden.pool);
  }

  const isDirect = (element: BurdenBaseElement): element is DirectBaseElement =>
    (DIRECT_BASE_ELEMENTS as readonly string[]).includes(element);

  for (const burden of burdens) {
    const base = burden.base ?? STANDARD_BURDEN_BASES[burden.pool];
    for (const element of base) {
      if (isDirect(element)) continue;
      // Only an ordering violation is an error. A pool that simply is not
      // configured contributes zero to the base - a fringe/overhead/G&A model
      // with no material handling pool is entirely normal.
      if (POOL_ORDER[element] >= POOL_ORDER[burden.pool]) {
        throw CalculationError(
          `Burden pool ${burden.pool} draws on ${element}, which is applied at the same time or later. Pools are applied in the order ${BURDEN_POOLS.join(' -> ')}.`,
          { pool: burden.pool, element, order: BURDEN_POOLS },
        );
      }
    }
  }

  for (const burden of burdens) {
    if (burden.ratesByYear.length === 0) {
      throw CalculationError(`Burden pool ${burden.pool} has no rates.`, { pool: burden.pool });
    }
    for (const rate of burden.ratesByYear) {
      const value = toDecimal(rate);
      if (value.isNegative()) {
        throw CalculationError(`Burden pool ${burden.pool} has a negative rate.`, {
          pool: burden.pool,
          rate: value.toString(),
        });
      }
    }
  }
}

/** Rate for a given contract year, with a single-entry rate applying to all years. */
export function rateForYear(ratesByYear: readonly MoneyInput[], yearIndex: number): Decimal {
  if (ratesByYear.length === 0) return new Decimal(0);
  if (ratesByYear.length === 1) return toDecimal(ratesByYear[0] as MoneyInput);
  const rate = ratesByYear[yearIndex];
  if (rate === undefined) {
    // Beyond the supplied schedule, hold the last declared rate flat rather than
    // dropping to zero - a silent zero would understate cost dramatically.
    return toDecimal(ratesByYear[ratesByYear.length - 1] as MoneyInput);
  }
  return toDecimal(rate);
}

/**
 * Apply every burden pool for one contract year, in order.
 *
 * Each pool's amount is `rate x base`, where the base is the sum of its declared
 * elements - including the amounts of pools already applied. Returns the audit
 * trail alongside the totals, because a price review will ask to see the base.
 */
export function applyBurdens(
  direct: DirectCostBasis,
  burdens: readonly BurdenDefinition[],
  yearIndex: number,
): BurdenResult {
  const values = new Map<BurdenBaseElement, Decimal>([
    ['DIRECT_LABOUR', direct.directLabour],
    ['DIRECT_NON_LABOUR', direct.otherDirect],
    ['MATERIAL', direct.material],
    ['SUBCONTRACT', direct.subcontract],
  ]);

  const ordered = [...burdens].sort((a, b) => POOL_ORDER[a.pool] - POOL_ORDER[b.pool]);
  const applied: AppliedBurden[] = [];
  const byPool: Record<string, Decimal> = {};
  let totalBurden = new Decimal(0);

  for (const burden of ordered) {
    const baseElements = burden.base ?? STANDARD_BURDEN_BASES[burden.pool];
    const baseAmount = baseElements.reduce<Decimal>(
      (acc, element) => acc.plus(values.get(element) ?? new Decimal(0)),
      new Decimal(0),
    );
    const rate = rateForYear(burden.ratesByYear, yearIndex);
    const amount = baseAmount.times(rate);

    values.set(burden.pool, amount);
    byPool[burden.pool] = amount;
    totalBurden = totalBurden.plus(amount);
    applied.push({
      pool: burden.pool,
      rate: rate.toString(),
      base: baseAmount.toFixed(4),
      amount: amount.toFixed(4),
      baseElements,
    });
  }

  return { applied, totalBurden, byPool };
}

/**
 * Effective wrap rate: total price-relevant cost per unit of direct labour.
 * The number pricing leads quote in review meetings.
 */
export function effectiveWrapRate(directLabour: Decimal, burdenTotal: Decimal): Decimal | null {
  if (directLabour.isZero()) return null;
  return directLabour.plus(burdenTotal).dividedBy(directLabour);
}

/** Convenience: sum a set of decimals defensively. */
export function sumDecimals(values: readonly MoneyInput[]): Decimal {
  return values.length === 0 ? new Decimal(0) : add(...values);
}
