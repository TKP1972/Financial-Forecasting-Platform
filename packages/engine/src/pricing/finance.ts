/**
 * Investment appraisal measures used in pricing summaries and business cases.
 *
 * Cash flows are indexed by period, period 0 being "now". NPV discounts period 0
 * by nothing, which is the convention finance teams expect when they hand over a
 * year-by-year cash flow.
 */
import { CalculationError, Decimal, toDecimal, toMoneyString, type MoneyInput } from '@ffp/shared';

/** Net present value at a per-period discount rate. */
export function netPresentValue(
  cashFlows: readonly MoneyInput[],
  discountRate: MoneyInput,
): Decimal {
  const rate = toDecimal(discountRate);
  if (rate.lessThanOrEqualTo(-1)) {
    throw CalculationError('Discount rate must exceed -100%.', { discountRate: rate.toString() });
  }
  return cashFlows.reduce<Decimal>(
    (acc, flow, period) => acc.plus(toDecimal(flow).dividedBy(rate.plus(1).pow(period))),
    new Decimal(0),
  );
}

/**
 * Internal rate of return: the discount rate at which NPV is zero.
 *
 * Solved by bisection rather than Newton-Raphson. Bisection is slower but cannot
 * diverge, and an IRR that silently fails to converge is worse than one that
 * reports honestly that it could not be found.
 *
 * Returns null when no sign change exists in the search range - which is the
 * correct answer for a cash flow that never turns positive, not an error.
 */
export function internalRateOfReturn(
  cashFlows: readonly MoneyInput[],
  options: { lower?: number; upper?: number; tolerance?: number; maxIterations?: number } = {},
): number | null {
  const { lower = -0.9999, upper = 10, tolerance = 1e-9, maxIterations = 300 } = options;
  if (cashFlows.length < 2) return null;

  const flows = cashFlows.map((f) => toDecimal(f).toNumber());
  const hasPositive = flows.some((f) => f > 0);
  const hasNegative = flows.some((f) => f < 0);
  // Without a sign change there is no rate that zeroes the NPV.
  if (!hasPositive || !hasNegative) return null;

  const npvAt = (rate: number) =>
    flows.reduce((acc, flow, period) => acc + flow / Math.pow(1 + rate, period), 0);

  let lo = lower;
  let hi = upper;
  let npvLo = npvAt(lo);
  let npvHi = npvAt(hi);

  if (npvLo * npvHi > 0) return null;

  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (lo + hi) / 2;
    const npvMid = npvAt(mid);
    if (Math.abs(npvMid) < tolerance || (hi - lo) / 2 < tolerance) return mid;
    if (npvLo * npvMid < 0) {
      hi = mid;
      npvHi = npvMid;
    } else {
      lo = mid;
      npvLo = npvMid;
    }
  }
  return (lo + hi) / 2;
}

export interface PaybackResult {
  /** Fractional periods until cumulative cash flow turns positive. */
  periods: number | null;
  /** Payback measured on discounted cash flows. */
  discountedPeriods: number | null;
}

/**
 * Payback period, interpolated within the period in which breakeven occurs.
 * Null when the investment never pays back over the modelled horizon.
 */
export function paybackPeriod(
  cashFlows: readonly MoneyInput[],
  discountRate: MoneyInput = '0',
): PaybackResult {
  const rate = toDecimal(discountRate);
  const raw = cashFlows.map((f) => toDecimal(f));
  const discounted = raw.map((f, period) => f.dividedBy(rate.plus(1).pow(period)));

  return {
    periods: breakevenPoint(raw),
    discountedPeriods: breakevenPoint(discounted),
  };
}

function breakevenPoint(flows: readonly Decimal[]): number | null {
  let cumulative = new Decimal(0);
  for (let period = 0; period < flows.length; period += 1) {
    const flow = flows[period] as Decimal;
    const next = cumulative.plus(flow);
    if (next.greaterThanOrEqualTo(0) && cumulative.lessThan(0)) {
      // Linear interpolation inside the crossing period.
      const fraction = flow.isZero() ? 0 : cumulative.negated().dividedBy(flow).toNumber();
      return period - 1 + fraction;
    }
    cumulative = next;
  }
  return null;
}

export interface MarginSummary {
  revenue: string;
  cost: string;
  grossProfit: string;
  /** Gross profit as a fraction of revenue. Null when revenue is zero. */
  grossMargin: number | null;
  /** Gross profit as a fraction of cost - the mark-up, not the margin. */
  markup: number | null;
}

/**
 * Margin and mark-up.
 *
 * Kept together deliberately: "30% margin" and "30% mark-up" are different
 * numbers and are confused constantly. Reporting both removes the ambiguity.
 */
export function marginSummary(revenue: MoneyInput, cost: MoneyInput): MarginSummary {
  const rev = toDecimal(revenue);
  const cst = toDecimal(cost);
  const profit = rev.minus(cst);

  return {
    revenue: toMoneyString(rev),
    cost: toMoneyString(cst),
    grossProfit: toMoneyString(profit),
    grossMargin: rev.isZero() ? null : profit.dividedBy(rev).toNumber(),
    markup: cst.isZero() ? null : profit.dividedBy(cst).toNumber(),
  };
}

/** Break-even volume: fixed cost / (unit price - unit variable cost). */
export function breakEvenVolume(
  fixedCost: MoneyInput,
  unitPrice: MoneyInput,
  unitVariableCost: MoneyInput,
): Decimal | null {
  const contribution = toDecimal(unitPrice).minus(toDecimal(unitVariableCost));
  if (contribution.lessThanOrEqualTo(0)) return null;
  return toDecimal(fixedCost).dividedBy(contribution);
}

/** Contribution margin ratio: (price - variable cost) / price. */
export function contributionMarginRatio(
  unitPrice: MoneyInput,
  unitVariableCost: MoneyInput,
): number | null {
  const price = toDecimal(unitPrice);
  if (price.isZero()) return null;
  return price.minus(toDecimal(unitVariableCost)).dividedBy(price).toNumber();
}

/**
 * Expected value of a pursuit: price-weighted by probability of win, net of
 * bid cost. The number that should drive bid/no-bid, and rarely does.
 */
export function expectedValue(
  price: MoneyInput,
  margin: MoneyInput,
  probabilityOfWin: number,
  bidCost: MoneyInput = '0',
): { expectedProfit: string; expectedRevenue: string; breakEvenProbability: number | null } {
  if (probabilityOfWin < 0 || probabilityOfWin > 1) {
    throw CalculationError('Probability of win must lie between 0 and 1.', { probabilityOfWin });
  }
  const profit = toDecimal(price).times(toDecimal(margin));
  const expectedProfit = profit.times(probabilityOfWin).minus(toDecimal(bidCost));

  return {
    expectedProfit: toMoneyString(expectedProfit),
    expectedRevenue: toMoneyString(toDecimal(price).times(probabilityOfWin)),
    // Below this win probability the pursuit destroys value.
    breakEvenProbability: profit.isZero() ? null : toDecimal(bidCost).dividedBy(profit).toNumber(),
  };
}
