/**
 * Full-year outturn projection and variance decomposition.
 *
 * Mid-cycle, the question is never "how are we doing?" but "where will we land?".
 * Three projection bases are offered because they answer different questions, and
 * quoting one without saying which was used is how projections lose credibility.
 */
import {
  CalculationError,
  Decimal,
  add,
  toDecimal,
  toMoneyString,
  type AccountType,
  type MoneyInput,
  type VarianceDirection,
} from '@ffp/shared';
import { varianceDirection } from './analysis.js';

export type ProjectionBasis =
  /** Extend the observed average spend rate across the remaining periods. */
  | 'RUN_RATE'
  /** Assume the remaining budget is spent exactly as planned. */
  | 'BUDGET_REMAINING'
  /** Use the submitted reforecast for the remaining periods. */
  | 'REFORECAST';

export interface ProjectionInput {
  key: string;
  label: string;
  accountType: AccountType;
  /** Full-year budget. */
  budget: MoneyInput;
  /** Actuals to date. */
  actualToDate: MoneyInput;
  commitmentToDate?: MoneyInput;
  /** Periods elapsed, 1-based. */
  periodsElapsed: number;
  /** Periods in the full year. */
  periodsInYear: number;
  /** Required when basis is REFORECAST: forecast for the remaining periods. */
  reforecastRemaining?: MoneyInput;
  /**
   * Per-period budget phasing. When supplied, BUDGET_REMAINING and the run-rate
   * comparison respect the actual phasing rather than assuming it is even -
   * which matters enormously for anything seasonal.
   */
  budgetPhasing?: MoneyInput[];
}

export interface ProjectionResult {
  key: string;
  label: string;
  basis: ProjectionBasis;
  budget: string;
  actualToDate: string;
  commitmentToDate: string;
  /** Budget that should have been consumed by now, given the phasing. */
  budgetToDate: string;
  /** Variance against phased budget so far. Positive = under. */
  varianceToDate: string;
  /** Projected spend for the remaining periods. */
  projectedRemaining: string;
  /** Projected full-year outturn. */
  projectedOutturn: string;
  /** Budget minus projected outturn. Positive = expected underspend. */
  projectedVariance: string;
  projectedVariancePercent: number | null;
  direction: VarianceDirection;
  periodsElapsed: number;
  periodsRemaining: number;
  warnings: string[];
}

/** Project the full-year outturn for a single line. */
export function projectOutturn(
  input: ProjectionInput,
  basis: ProjectionBasis = 'RUN_RATE',
): ProjectionResult {
  const warnings: string[] = [];
  const { periodsElapsed, periodsInYear } = input;

  if (!Number.isInteger(periodsElapsed) || periodsElapsed < 1) {
    throw CalculationError('Periods elapsed must be a positive integer.', { periodsElapsed });
  }
  if (!Number.isInteger(periodsInYear) || periodsInYear < periodsElapsed) {
    throw CalculationError('Periods in year must be an integer of at least periodsElapsed.', {
      periodsElapsed,
      periodsInYear,
    });
  }

  const budget = toDecimal(input.budget);
  const actual = toDecimal(input.actualToDate);
  const commitment = toDecimal(input.commitmentToDate ?? '0');
  const consumed = actual.plus(commitment);
  const periodsRemaining = periodsInYear - periodsElapsed;

  if (periodsElapsed <= 2 && basis === 'RUN_RATE') {
    warnings.push(
      `A run-rate projection from ${periodsElapsed} period(s) of actuals is highly unstable. Treat it as indicative only.`,
    );
  }

  const budgetToDate = phasedBudgetToDate(
    budget,
    input.budgetPhasing,
    periodsElapsed,
    periodsInYear,
  );

  let projectedRemaining: Decimal;
  switch (basis) {
    case 'RUN_RATE': {
      const perPeriod = consumed.dividedBy(periodsElapsed);
      projectedRemaining = perPeriod.times(periodsRemaining);
      break;
    }
    case 'BUDGET_REMAINING': {
      projectedRemaining = budget.minus(budgetToDate);
      break;
    }
    case 'REFORECAST': {
      if (input.reforecastRemaining === undefined) {
        throw CalculationError(
          `Line '${input.key}' has no reforecast for the remaining periods; a REFORECAST projection cannot be produced.`,
          { key: input.key },
        );
      }
      projectedRemaining = toDecimal(input.reforecastRemaining);
      break;
    }
    default: {
      const exhaustive: never = basis;
      throw CalculationError(`Unknown projection basis: ${String(exhaustive)}`);
    }
  }

  const projectedOutturn = consumed.plus(projectedRemaining);
  const projectedVariance = budget.minus(projectedOutturn);

  return {
    key: input.key,
    label: input.label,
    basis,
    budget: toMoneyString(budget),
    actualToDate: toMoneyString(actual),
    commitmentToDate: toMoneyString(commitment),
    budgetToDate: toMoneyString(budgetToDate),
    varianceToDate: toMoneyString(budgetToDate.minus(consumed)),
    projectedRemaining: toMoneyString(projectedRemaining),
    projectedOutturn: toMoneyString(projectedOutturn),
    projectedVariance: toMoneyString(projectedVariance),
    projectedVariancePercent: budget.isZero()
      ? null
      : projectedVariance.dividedBy(budget.abs()).toNumber(),
    direction: varianceDirection(projectedVariance, input.accountType),
    periodsElapsed,
    periodsRemaining,
    warnings,
  };
}

/** Budget that should have been consumed by now, honouring any phasing. */
function phasedBudgetToDate(
  budget: Decimal,
  phasing: readonly MoneyInput[] | undefined,
  periodsElapsed: number,
  periodsInYear: number,
): Decimal {
  if (!phasing || phasing.length === 0) {
    return budget.times(periodsElapsed).dividedBy(periodsInYear);
  }
  const elapsed = phasing.slice(0, periodsElapsed);
  return elapsed.length === 0 ? new Decimal(0) : add(...elapsed);
}

/** Project a whole set of lines and total them. */
export function projectPortfolio(
  inputs: readonly ProjectionInput[],
  basis: ProjectionBasis = 'RUN_RATE',
): {
  lines: ProjectionResult[];
  totals: {
    budget: string;
    actualToDate: string;
    projectedOutturn: string;
    projectedVariance: string;
    projectedVariancePercent: number | null;
  };
} {
  const lines = inputs.map((input) => projectOutturn(input, basis));
  const total = (pick: (l: ProjectionResult) => string) =>
    lines.length === 0 ? new Decimal(0) : add(...lines.map(pick));

  const budget = total((l) => l.budget);
  const projectedOutturn = total((l) => l.projectedOutturn);
  const projectedVariance = budget.minus(projectedOutturn);

  return {
    lines,
    totals: {
      budget: toMoneyString(budget),
      actualToDate: toMoneyString(total((l) => l.actualToDate)),
      projectedOutturn: toMoneyString(projectedOutturn),
      projectedVariance: toMoneyString(projectedVariance),
      projectedVariancePercent: budget.isZero()
        ? null
        : projectedVariance.dividedBy(budget.abs()).toNumber(),
    },
  };
}

// --------------------------------------------------------------------------
// Variance decomposition
// --------------------------------------------------------------------------

export interface PriceVolumeInput {
  label: string;
  budgetVolume: MoneyInput;
  budgetPrice: MoneyInput;
  actualVolume: MoneyInput;
  actualPrice: MoneyInput;
  /**
   * Decides which direction is good news. Spending more on a cost is adverse;
   * earning more revenue is favourable, and the arithmetic cannot tell them
   * apart. Defaults to OPEX because a price-and-volume split is nearly always
   * asked of a cost line.
   */
  accountType?: AccountType;
}

export interface PriceVolumeResult {
  label: string;
  budgetAmount: string;
  actualAmount: string;
  totalVariance: string;
  /** Effect of the volume difference, held at budget price. */
  volumeVariance: string;
  /** Effect of the price difference, applied to actual volume. */
  priceVariance: string;
  /** Cross term, reported separately rather than silently absorbed. */
  jointVariance: string;
  /**
   * Whether each effect is good news, decided by {@link varianceDirection}.
   *
   * The components here are signed `actual - budget`, because a decomposition
   * explains a change. A variance report signs the other way, `budget - actual`.
   * Both conventions are standard and a reader cannot tell which they are
   * looking at, so neither screen should present a bare sign: the direction
   * word carries the meaning, and it comes from the same helper the variance
   * report uses rather than being re-derived here.
   */
  direction: {
    volume: VarianceDirection;
    price: VarianceDirection;
    joint: VarianceDirection;
    total: VarianceDirection;
  };
}

/**
 * Split a variance into its price and volume components.
 *
 * "We spent 200k more than budget" is not actionable. "We used 12% more hours at
 * a 3% higher rate" is. The joint (cross) term is reported explicitly instead of
 * being folded into the price variance - folding it in is a common shortcut that
 * quietly overstates the price effect.
 */
export function decomposePriceVolume(input: PriceVolumeInput): PriceVolumeResult {
  const bv = toDecimal(input.budgetVolume);
  const bp = toDecimal(input.budgetPrice);
  const av = toDecimal(input.actualVolume);
  const ap = toDecimal(input.actualPrice);

  const budgetAmount = bv.times(bp);
  const actualAmount = av.times(ap);

  const volumeVariance = av.minus(bv).times(bp);
  const priceVariance = ap.minus(bp).times(bv);
  const jointVariance = av.minus(bv).times(ap.minus(bp));

  const accountType = input.accountType ?? 'OPEX';
  // varianceDirection reads `budget - actual`; these are `actual - budget`, so
  // they are negated on the way in rather than the rule being restated.
  const directionOf = (effect: Decimal) => varianceDirection(effect.negated(), accountType);

  return {
    label: input.label,
    budgetAmount: toMoneyString(budgetAmount),
    actualAmount: toMoneyString(actualAmount),
    totalVariance: toMoneyString(actualAmount.minus(budgetAmount)),
    volumeVariance: toMoneyString(volumeVariance),
    priceVariance: toMoneyString(priceVariance),
    jointVariance: toMoneyString(jointVariance),
    direction: {
      volume: directionOf(volumeVariance),
      price: directionOf(priceVariance),
      joint: directionOf(jointVariance),
      total: directionOf(actualAmount.minus(budgetAmount)),
    },
  };
}

export interface MixVarianceResult {
  lines: Array<{
    label: string;
    mixVariance: string;
    quantityVariance: string;
  }>;
  totalMixVariance: string;
  totalQuantityVariance: string;
}

/**
 * Mix and quantity variance across a portfolio.
 *
 * Separates "we did more work overall" (quantity) from "the shape of the work
 * shifted toward more expensive categories" (mix). The second is the one that
 * usually explains an unexpected margin move.
 */
export function decomposeMix(inputs: readonly PriceVolumeInput[]): MixVarianceResult {
  if (inputs.length === 0) {
    return {
      lines: [],
      totalMixVariance: toMoneyString(0),
      totalQuantityVariance: toMoneyString(0),
    };
  }

  const budgetVolumes = inputs.map((i) => toDecimal(i.budgetVolume));
  const actualVolumes = inputs.map((i) => toDecimal(i.actualVolume));
  const totalBudgetVolume = budgetVolumes.reduce((a, b) => a.plus(b), new Decimal(0));
  const totalActualVolume = actualVolumes.reduce((a, b) => a.plus(b), new Decimal(0));

  if (totalBudgetVolume.isZero()) {
    throw CalculationError('Mix variance is undefined when total budget volume is zero.');
  }

  const weightedAveragePrice = inputs
    .reduce(
      (acc, input, i) =>
        acc.plus((budgetVolumes[i] as Decimal).times(toDecimal(input.budgetPrice))),
      new Decimal(0),
    )
    .dividedBy(totalBudgetVolume);

  const lines = inputs.map((input, i) => {
    const budgetShare = (budgetVolumes[i] as Decimal).dividedBy(totalBudgetVolume);
    const expectedAtActualTotal = totalActualVolume.times(budgetShare);
    const budgetPrice = toDecimal(input.budgetPrice);

    return {
      label: input.label,
      // Mix: this line took a different share of the total than planned.
      mixVariance: toMoneyString(
        (actualVolumes[i] as Decimal).minus(expectedAtActualTotal).times(budgetPrice),
      ),
      // Quantity: the whole portfolio grew or shrank, at the blended rate.
      quantityVariance: toMoneyString(
        expectedAtActualTotal.minus(budgetVolumes[i] as Decimal).times(weightedAveragePrice),
      ),
    };
  });

  return {
    lines,
    totalMixVariance: toMoneyString(add(...lines.map((l) => l.mixVariance))),
    totalQuantityVariance: toMoneyString(add(...lines.map((l) => l.quantityVariance))),
  };
}
