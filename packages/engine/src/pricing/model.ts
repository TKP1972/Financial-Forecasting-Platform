/**
 * The pricing and cost-estimating model.
 *
 * Builds a multi-year cost volume from labour and direct costs, wraps it with
 * indirect pools, adds fee, and reports the price alongside the profitability
 * measures a leadership review will ask for.
 *
 * Entirely Decimal. A pricing model's output is quoted to a client and booked
 * into a forecast; it has to foot to the cent against the spreadsheet it will
 * inevitably be checked against.
 */
import {
  CalculationError,
  DEFAULT_CURRENCY,
  Decimal,
  add,
  escalationFactor,
  toDecimal,
  toMoneyString,
  toRateString,
  type ContractType,
  type CostCategory,
  type MoneyInput,
} from '@ffp/shared';
import {
  applyBurdens,
  effectiveWrapRate,
  validateBurdens,
  type AppliedBurden,
  type BurdenDefinition,
  type DirectCostBasis,
} from './burdens.js';
import {
  internalRateOfReturn,
  marginSummary,
  netPresentValue,
  paybackPeriod,
  type MarginSummary,
  type PaybackResult,
} from './finance.js';

export interface LabourLine {
  labourCategory: string;
  /** Hours per contract year, in year order. */
  hoursByYear: number[];
  /** Year-1 hourly rate. Escalation compounds from year 2 onward. */
  baseRate: MoneyInput;
  escalationRate?: MoneyInput;
  fte?: number;
  location?: string;
  /**
   * An explicit rate per contract year, overriding `baseRate` and
   * `escalationRate` entirely.
   *
   * This is how a rate card drives pricing: `buildRateSchedule` resolves the
   * rate in force on each contract anniversary, which already accounts for
   * effective-dated card changes mid-term. Applying escalation on top of that
   * would double-count the increase the card already contains.
   */
  ratesByYear?: MoneyInput[];
}

export interface DirectCostLine {
  description: string;
  category: CostCategory;
  amountByYear: MoneyInput[];
  escalationRate?: MoneyInput;
  /**
   * Billed at cost with no burden and no fee. Travel reimbursed at actuals and
   * client-directed subcontract flow-downs are the usual cases.
   */
  isPassThrough?: boolean;
}

export interface PricingModelInput {
  name: string;
  contractType: ContractType;
  currency?: string;
  years: number;
  labour?: LabourLine[];
  directCosts?: DirectCostLine[];
  burdens?: BurdenDefinition[];
  /** Fee as a fraction of burdened cost, excluding pass-throughs. */
  feeRate?: MoneyInput;
  /** Discount applied to the total price, e.g. a competitive concession. */
  discountRate?: MoneyInput;
  /** Annual rate used to discount the profit stream for NPV. */
  costOfCapital?: MoneyInput;
  assumptions?: string[];
}

export interface PricingYearResult {
  year: number;
  labourHours: number;
  directLabour: string;
  material: string;
  subcontract: string;
  otherDirect: string;
  passThrough: string;
  totalDirect: string;
  burdens: AppliedBurden[];
  totalBurden: string;
  /** Direct (excluding pass-through) plus indirect. The fee base. */
  totalCost: string;
  fee: string;
  priceBeforeDiscount: string;
  discount: string;
  price: string;
  /** Total cost per unit of direct labour. Null when there is no direct labour. */
  wrapRate: string | null;
  profit: string;
}

export interface PricingTotals {
  labourHours: number;
  directLabour: string;
  material: string;
  subcontract: string;
  otherDirect: string;
  passThrough: string;
  totalDirect: string;
  totalBurden: string;
  totalCost: string;
  fee: string;
  discount: string;
  price: string;
  profit: string;
}

export interface PricingBreakdownRow {
  key: string;
  label: string;
  amount: string;
  /** Share of total price, as a fraction. */
  share: number | null;
}

export interface PricingResult {
  name: string;
  contractType: ContractType;
  currency: string;
  years: PricingYearResult[];
  totals: PricingTotals;
  margin: MarginSummary;
  /** Effective fee rate actually achieved, after any discount. */
  effectiveFeeRate: string | null;
  npv: string;
  irr: number | null;
  payback: PaybackResult;
  byLabourCategory: PricingBreakdownRow[];
  byCostCategory: PricingBreakdownRow[];
  byBurdenPool: PricingBreakdownRow[];
  assumptions: string[];
  warnings: string[];
}

const MATERIAL_CATEGORIES: ReadonlySet<CostCategory> = new Set(['MATERIAL', 'EQUIPMENT']);
const SUBCONTRACT_CATEGORIES: ReadonlySet<CostCategory> = new Set(['SUBCONTRACT']);

/** Amount for a given year, holding the last supplied value flat beyond the schedule. */
function amountForYear(amounts: readonly MoneyInput[], yearIndex: number): Decimal {
  if (amounts.length === 0) return new Decimal(0);
  const value = amounts[yearIndex] ?? amounts[amounts.length - 1];
  return toDecimal(value as MoneyInput);
}

function hoursForYear(hours: readonly number[], yearIndex: number): number {
  if (hours.length === 0) return 0;
  return hours[yearIndex] ?? 0;
}

/** Build the full cost volume and price. */
export function buildPricingModel(input: PricingModelInput): PricingResult {
  const warnings: string[] = [];
  const years = Math.trunc(input.years);
  if (years < 1 || years > 20) {
    throw CalculationError(`Contract term must be between 1 and 20 years, got ${input.years}.`, {
      years: input.years,
    });
  }

  const labour = input.labour ?? [];
  const directCosts = input.directCosts ?? [];
  const burdens = input.burdens ?? [];
  validateBurdens(burdens);

  if (labour.length === 0 && directCosts.length === 0) {
    throw CalculationError('A pricing model needs at least one labour or direct cost line.');
  }

  const feeRate = toDecimal(input.feeRate ?? '0');
  const discountRate = toDecimal(input.discountRate ?? '0');
  if (discountRate.greaterThanOrEqualTo(1)) {
    throw CalculationError('A discount of 100% or more cannot be priced.', {
      discountRate: discountRate.toString(),
    });
  }
  if (feeRate.isNegative()) {
    warnings.push('Fee rate is negative: this model prices below cost before any discount.');
  }

  for (const line of labour) {
    if (line.hoursByYear.length > years) {
      warnings.push(
        `Labour line '${line.labourCategory}' supplies ${line.hoursByYear.length} years of hours for a ${years}-year term; the excess is ignored.`,
      );
    }
  }

  const labourTotals = new Map<string, Decimal>();
  const categoryTotals = new Map<CostCategory, Decimal>();
  const poolTotals = new Map<string, Decimal>();

  const yearResults: PricingYearResult[] = [];

  for (let y = 0; y < years; y += 1) {
    let directLabour = new Decimal(0);
    let labourHours = 0;

    for (const line of labour) {
      const hours = hoursForYear(line.hoursByYear, y);
      if (hours === 0) continue;

      // An explicit schedule wins: it already carries whatever movement the
      // rate card describes, so escalating it again would double-count.
      const rate = line.ratesByYear
        ? amountForYear(line.ratesByYear, y)
        : toDecimal(line.baseRate).times(escalationFactor(line.escalationRate ?? '0', y));
      const cost = rate.times(hours);
      directLabour = directLabour.plus(cost);
      labourHours += hours;
      labourTotals.set(
        line.labourCategory,
        (labourTotals.get(line.labourCategory) ?? new Decimal(0)).plus(cost),
      );
    }

    let material = new Decimal(0);
    let subcontract = new Decimal(0);
    let otherDirect = new Decimal(0);
    let passThrough = new Decimal(0);

    for (const line of directCosts) {
      const escalated = amountForYear(line.amountByYear, y).times(
        escalationFactor(line.escalationRate ?? '0', y),
      );
      if (escalated.isZero()) continue;

      categoryTotals.set(
        line.category,
        (categoryTotals.get(line.category) ?? new Decimal(0)).plus(escalated),
      );

      if (line.isPassThrough) {
        passThrough = passThrough.plus(escalated);
      } else if (MATERIAL_CATEGORIES.has(line.category)) {
        material = material.plus(escalated);
      } else if (SUBCONTRACT_CATEGORIES.has(line.category)) {
        subcontract = subcontract.plus(escalated);
      } else {
        otherDirect = otherDirect.plus(escalated);
      }
    }

    const basis: DirectCostBasis = {
      directLabour,
      otherDirect,
      material,
      subcontract,
      passThrough,
    };
    const burdenResult = applyBurdens(basis, burdens, y);

    for (const [pool, amount] of Object.entries(burdenResult.byPool)) {
      poolTotals.set(pool, (poolTotals.get(pool) ?? new Decimal(0)).plus(amount));
    }

    // Pass-throughs sit outside the burden and fee base by definition.
    const burdenableDirect = add(directLabour, material, subcontract, otherDirect);
    const totalCost = burdenableDirect.plus(burdenResult.totalBurden);
    const fee = totalCost.times(feeRate);
    const priceBeforeDiscount = totalCost.plus(fee).plus(passThrough);
    const discount = priceBeforeDiscount.times(discountRate);
    const price = priceBeforeDiscount.minus(discount);

    yearResults.push({
      year: y + 1,
      labourHours,
      directLabour: toMoneyString(directLabour),
      material: toMoneyString(material),
      subcontract: toMoneyString(subcontract),
      otherDirect: toMoneyString(otherDirect),
      passThrough: toMoneyString(passThrough),
      totalDirect: toMoneyString(burdenableDirect.plus(passThrough)),
      burdens: burdenResult.applied,
      totalBurden: toMoneyString(burdenResult.totalBurden),
      totalCost: toMoneyString(totalCost),
      fee: toMoneyString(fee),
      priceBeforeDiscount: toMoneyString(priceBeforeDiscount),
      discount: toMoneyString(discount),
      price: toMoneyString(price),
      wrapRate: (() => {
        const wrap = effectiveWrapRate(directLabour, burdenResult.totalBurden);
        return wrap === null ? null : toRateString(wrap, 4);
      })(),
      // Pass-throughs contribute nothing to profit: billed at cost.
      profit: toMoneyString(price.minus(totalCost).minus(passThrough)),
    });
  }

  const totals = totalsFrom(yearResults);
  const margin = marginSummary(totals.price, toDecimal(totals.totalCost).plus(totals.passThrough));

  const profitFlows = yearResults.map((y) => y.profit);
  const npv = netPresentValue(profitFlows, input.costOfCapital ?? '0.10');
  const irr = internalRateOfReturn(profitFlows);
  const payback = paybackPeriod(profitFlows, input.costOfCapital ?? '0.10');

  const totalPrice = toDecimal(totals.price);
  const share = (amount: Decimal) =>
    totalPrice.isZero() ? null : amount.dividedBy(totalPrice).toNumber();
  const toRows = (entries: Iterable<[string, Decimal]>): PricingBreakdownRow[] =>
    [...entries]
      .sort((a, b) => b[1].comparedTo(a[1]))
      .map(([key, amount]) => ({
        key,
        label: key,
        amount: toMoneyString(amount),
        share: share(amount),
      }));

  if (toDecimal(totals.directLabour).isZero() && labour.length > 0) {
    warnings.push('Labour lines were supplied but produced no cost. Check the hours schedule.');
  }
  if (burdens.length === 0) {
    warnings.push(
      'No indirect cost pools are configured. This price recovers direct cost only and will understate the true cost of delivery.',
    );
  }

  return {
    name: input.name,
    contractType: input.contractType,
    currency: input.currency ?? DEFAULT_CURRENCY,
    years: yearResults,
    totals,
    margin,
    effectiveFeeRate: (() => {
      const cost = toDecimal(totals.totalCost);
      if (cost.isZero()) return null;
      return toRateString(toDecimal(totals.profit).dividedBy(cost), 6);
    })(),
    npv: toMoneyString(npv),
    irr,
    payback,
    byLabourCategory: toRows(labourTotals),
    byCostCategory: toRows(categoryTotals as Iterable<[string, Decimal]>),
    byBurdenPool: toRows(poolTotals),
    assumptions: input.assumptions ?? [],
    warnings,
  };
}

function totalsFrom(years: readonly PricingYearResult[]): PricingTotals {
  const total = (pick: (y: PricingYearResult) => string) => toMoneyString(add(...years.map(pick)));

  return {
    labourHours: years.reduce((acc, y) => acc + y.labourHours, 0),
    directLabour: total((y) => y.directLabour),
    material: total((y) => y.material),
    subcontract: total((y) => y.subcontract),
    otherDirect: total((y) => y.otherDirect),
    passThrough: total((y) => y.passThrough),
    totalDirect: total((y) => y.totalDirect),
    totalBurden: total((y) => y.totalBurden),
    totalCost: total((y) => y.totalCost),
    fee: total((y) => y.fee),
    discount: total((y) => y.discount),
    price: total((y) => y.price),
    profit: total((y) => y.profit),
  };
}

// --------------------------------------------------------------------------
// Price to win
// --------------------------------------------------------------------------

export interface PriceToWinTarget {
  kind: 'MARGIN' | 'PRICE';
  value: MoneyInput;
}

export interface PriceToWinResult {
  /** Fee rate that hits the target. */
  feeRate: string;
  achieved: PricingResult;
  /** How close the solver got, in target units. */
  residual: string;
  converged: boolean;
  iterations: number;
}

/**
 * Solve for the fee rate that hits a target margin or a target price.
 *
 * Bisection over the fee rate. The relationship is monotonic - more fee means
 * more price and more margin - so bisection is guaranteed to converge inside the
 * bracket, and it stays correct if discount or burden behaviour is ever made
 * non-linear. A closed-form solution would not.
 */
export function solvePriceToWin(
  model: PricingModelInput,
  target: PriceToWinTarget,
  options: { lower?: number; upper?: number; tolerance?: number; maxIterations?: number } = {},
): PriceToWinResult {
  const { lower = -0.5, upper = 5, tolerance = 1e-9, maxIterations = 200 } = options;

  const evaluate = (feeRate: number) => buildPricingModel({ ...model, feeRate: String(feeRate) });

  const objective = (result: PricingResult): number => {
    if (target.kind === 'MARGIN') {
      const achieved = result.margin.grossMargin;
      // A zero-revenue model has no margin to steer; treat it as maximally short.
      if (achieved === null) return -Infinity;
      return achieved - toDecimal(target.value).toNumber();
    }
    return toDecimal(result.totals.price).minus(toDecimal(target.value)).toNumber();
  };

  let lo = lower;
  let hi = upper;
  let fLo = objective(evaluate(lo));
  const fHi = objective(evaluate(hi));

  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) {
    // No bracket: report the closest endpoint rather than a fabricated answer.
    const bestRate = Math.abs(fLo) <= Math.abs(fHi) ? lo : hi;
    const achieved = evaluate(bestRate);
    return {
      feeRate: toRateString(bestRate, 6),
      achieved,
      residual: toMoneyString(objective(achieved), 6),
      converged: false,
      iterations: 0,
    };
  }

  let mid = lo;
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    mid = (lo + hi) / 2;
    const fMid = objective(evaluate(mid));
    if (Math.abs(fMid) < tolerance || (hi - lo) / 2 < tolerance) break;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }

  const achieved = evaluate(mid);
  const residual = objective(achieved);
  return {
    feeRate: toRateString(mid, 6),
    achieved,
    residual: toMoneyString(residual, 6),
    converged: Math.abs(residual) < Math.max(tolerance, 1e-6),
    iterations,
  };
}

// --------------------------------------------------------------------------
// Sensitivity
// --------------------------------------------------------------------------

export interface SensitivityCase {
  label: string;
  /** Multiplier applied to every labour rate. */
  labourRateFactor?: number;
  /** Multiplier applied to every labour hour figure. */
  hoursFactor?: number;
  /** Additive shift applied to every burden rate, e.g. 0.02 for +2pp. */
  burdenRateShift?: number;
  /** Replacement fee rate. */
  feeRate?: MoneyInput;
}

export interface SensitivityRow {
  label: string;
  price: string;
  cost: string;
  margin: number | null;
  priceDelta: string;
  marginDelta: number | null;
}

/**
 * Re-price the model under a set of what-if cases.
 * This is the table that goes in front of leadership: "what happens to margin if
 * rates come in 5% high and we lose two points of overhead recovery?"
 */
export function runSensitivity(
  model: PricingModelInput,
  cases: readonly SensitivityCase[],
): { base: PricingResult; rows: SensitivityRow[] } {
  const base = buildPricingModel(model);
  const basePrice = toDecimal(base.totals.price);
  const baseMargin = base.margin.grossMargin;

  const rows = cases.map((testCase) => {
    const adjusted: PricingModelInput = {
      ...model,
      feeRate: testCase.feeRate ?? model.feeRate,
      labour: (model.labour ?? []).map((line) => ({
        ...line,
        baseRate: toDecimal(line.baseRate)
          .times(testCase.labourRateFactor ?? 1)
          .toString(),
        // A rate-card-driven line ignores baseRate, so the factor has to be
        // applied to the schedule as well or the sensitivity does nothing.
        ...(line.ratesByYear
          ? {
              ratesByYear: line.ratesByYear.map((rate) =>
                toDecimal(rate)
                  .times(testCase.labourRateFactor ?? 1)
                  .toString(),
              ),
            }
          : {}),
        hoursByYear: line.hoursByYear.map((h) => h * (testCase.hoursFactor ?? 1)),
      })),
      burdens: (model.burdens ?? []).map((burden) => ({
        ...burden,
        ratesByYear: burden.ratesByYear.map((rate) =>
          // Clamp at zero: a negative burden rate is not a meaningful scenario.
          Decimal.max(toDecimal(rate).plus(testCase.burdenRateShift ?? 0), 0).toString(),
        ),
      })),
    };

    const result = buildPricingModel(adjusted);
    return {
      label: testCase.label,
      price: result.totals.price,
      cost: result.totals.totalCost,
      margin: result.margin.grossMargin,
      priceDelta: toMoneyString(toDecimal(result.totals.price).minus(basePrice)),
      marginDelta:
        result.margin.grossMargin === null || baseMargin === null
          ? null
          : result.margin.grossMargin - baseMargin,
    };
  });

  return { base, rows };
}
