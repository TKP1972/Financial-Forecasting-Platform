/**
 * Cost behaviour analysis: fixed versus variable, and what follows from it.
 *
 * Knowing only that spend rose 12% is not actionable. Splitting that into "we
 * did 12% more work" (variable, expected) and "our fixed base grew" (structural,
 * a decision someone made) is. Contribution margin, operating leverage and a
 * flexed budget all become available the moment cost behaviour is recorded, and
 * none of them are computable without it.
 */
import {
  COST_BEHAVIOURS,
  CalculationError,
  DEFAULT_BEHAVIOUR_BY_SPEND_CATEGORY,
  Decimal,
  add,
  toDecimal,
  toMoneyString,
  type CostBehaviour,
  type MoneyInput,
  type SpendCategory,
} from '@ffp/shared';

export interface CostLine {
  key: string;
  label: string;
  amount: MoneyInput;
  spendCategory?: SpendCategory;
  /** Overrides the category default. */
  behaviour?: CostBehaviour;
  /**
   * For SEMI_VARIABLE lines, the fraction of the amount that varies with volume.
   * Defaults to 0.5 when not stated, and the result says it was assumed.
   */
  variableShare?: number;
}

export interface ResolvedCostLine {
  key: string;
  label: string;
  amount: string;
  spendCategory: SpendCategory;
  behaviour: CostBehaviour;
  fixedAmount: string;
  variableAmount: string;
  /** True when the split rested on a default rather than a declared value. */
  assumed: boolean;
}

export interface CostBehaviourSummary {
  lines: ResolvedCostLine[];
  total: string;
  totalFixed: string;
  totalVariable: string;
  /** Fixed cost as a fraction of total. High means low flexibility. */
  fixedRatio: number | null;
  byCategory: Array<{
    category: SpendCategory;
    amount: string;
    fixed: string;
    variable: string;
    share: number | null;
  }>;
  byBehaviour: Array<{ behaviour: CostBehaviour; amount: string; share: number | null }>;
  /** Lines whose split was assumed rather than declared - the ones to go and confirm. */
  assumedLineCount: number;
  observations: string[];
}

function resolve(line: CostLine): ResolvedCostLine {
  const category = line.spendCategory ?? 'OTHER';
  const behaviour = line.behaviour ?? DEFAULT_BEHAVIOUR_BY_SPEND_CATEGORY[category];
  const amount = toDecimal(line.amount);

  let variableShare: number;
  let assumed = false;

  switch (behaviour) {
    case 'FIXED':
      variableShare = 0;
      assumed = line.behaviour === undefined;
      break;
    case 'VARIABLE':
      variableShare = 1;
      assumed = line.behaviour === undefined;
      break;
    case 'SEMI_VARIABLE':
      if (line.variableShare === undefined) {
        variableShare = 0.5;
        assumed = true;
      } else {
        if (line.variableShare < 0 || line.variableShare > 1) {
          throw CalculationError(
            `Line '${line.key}' has a variable share outside [0,1]; it is a fraction of the line, not a percentage.`,
            { key: line.key, variableShare: line.variableShare },
          );
        }
        variableShare = line.variableShare;
      }
      break;
    default: {
      const exhaustive: never = behaviour;
      throw CalculationError(`Unknown cost behaviour: ${String(exhaustive)}`);
    }
  }

  const variableAmount = amount.times(variableShare);

  return {
    key: line.key,
    label: line.label,
    amount: toMoneyString(amount),
    spendCategory: category,
    behaviour,
    fixedAmount: toMoneyString(amount.minus(variableAmount)),
    variableAmount: toMoneyString(variableAmount),
    assumed,
  };
}

/** Classify a set of cost lines and roll them up. */
export function analyseCostBehaviour(lines: readonly CostLine[]): CostBehaviourSummary {
  const resolved = lines.map(resolve);

  const total = resolved.length === 0 ? new Decimal(0) : add(...resolved.map((l) => l.amount));
  const totalFixed =
    resolved.length === 0 ? new Decimal(0) : add(...resolved.map((l) => l.fixedAmount));
  const totalVariable =
    resolved.length === 0 ? new Decimal(0) : add(...resolved.map((l) => l.variableAmount));

  const share = (value: Decimal) => (total.isZero() ? null : value.dividedBy(total).toNumber());

  const categoryTotals = new Map<
    SpendCategory,
    { amount: Decimal; fixed: Decimal; variable: Decimal }
  >();
  for (const line of resolved) {
    const existing = categoryTotals.get(line.spendCategory) ?? {
      amount: new Decimal(0),
      fixed: new Decimal(0),
      variable: new Decimal(0),
    };
    categoryTotals.set(line.spendCategory, {
      amount: existing.amount.plus(line.amount),
      fixed: existing.fixed.plus(line.fixedAmount),
      variable: existing.variable.plus(line.variableAmount),
    });
  }

  const behaviourTotals = new Map<CostBehaviour, Decimal>();
  for (const line of resolved) {
    behaviourTotals.set(
      line.behaviour,
      (behaviourTotals.get(line.behaviour) ?? new Decimal(0)).plus(line.amount),
    );
  }

  const fixedRatio = share(totalFixed);
  const assumedLineCount = resolved.filter((l) => l.assumed).length;
  const observations: string[] = [];

  if (fixedRatio !== null && fixedRatio > 0.7) {
    observations.push(
      `${(fixedRatio * 100).toFixed(0)}% of this cost base is fixed. Volume falls will not relieve it, and cost reduction requires structural decisions rather than efficiency.`,
    );
  }
  if (fixedRatio !== null && fixedRatio < 0.3 && !total.isZero()) {
    observations.push(
      `Only ${(fixedRatio * 100).toFixed(0)}% of this cost base is fixed, so cost tracks volume closely. Margin is protected on the downside but scale gains will be limited.`,
    );
  }
  if (assumedLineCount > 0) {
    observations.push(
      `${assumedLineCount} line(s) had their fixed/variable split inferred from the spend category rather than declared. Confirm these before relying on the contribution margin.`,
    );
  }

  return {
    lines: resolved,
    total: toMoneyString(total),
    totalFixed: toMoneyString(totalFixed),
    totalVariable: toMoneyString(totalVariable),
    fixedRatio,
    byCategory: [...categoryTotals.entries()]
      .map(([category, v]) => ({
        category,
        amount: toMoneyString(v.amount),
        fixed: toMoneyString(v.fixed),
        variable: toMoneyString(v.variable),
        share: share(v.amount),
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount)),
    byBehaviour: COST_BEHAVIOURS.map((behaviour) => {
      const amount = behaviourTotals.get(behaviour) ?? new Decimal(0);
      return { behaviour, amount: toMoneyString(amount), share: share(amount) };
    }),
    assumedLineCount,
    observations,
  };
}

export interface ContributionAnalysis {
  revenue: string;
  variableCost: string;
  contribution: string;
  /** (revenue - variable cost) / revenue. */
  contributionMargin: number | null;
  fixedCost: string;
  operatingProfit: string;
  operatingMargin: number | null;
  /** Revenue at which contribution exactly covers fixed cost. */
  breakEvenRevenue: string | null;
  /** How far revenue can fall before the operation loses money, as a fraction. */
  marginOfSafety: number | null;
  /**
   * Contribution / operating profit. A high figure means small revenue moves
   * swing profit hard - the number to quote when someone calls a forecast
   * "roughly flat".
   */
  operatingLeverage: number | null;
  observations: string[];
}

/**
 * Contribution-margin analysis. Only possible once cost behaviour is known,
 * which is the practical argument for recording it.
 *
 * Note on break-even: the costs supplied are absolute amounts at the modelled
 * revenue, so the contribution *ratio* is derived at that point and then assumed
 * to hold as revenue varies - the standard CVP assumption. A consequence worth
 * knowing is that break-even moves when you re-run at a different revenue: the
 * same cost base against lower revenue implies a worse ratio and therefore a
 * higher break-even. Read the figure as "break-even given this cost structure
 * and this margin", not as a fixed property of the business.
 */
export function analyseContribution(
  revenue: MoneyInput,
  costs: readonly CostLine[],
): ContributionAnalysis {
  const behaviour = analyseCostBehaviour(costs);
  const rev = toDecimal(revenue);
  const variableCost = toDecimal(behaviour.totalVariable);
  const fixedCost = toDecimal(behaviour.totalFixed);

  const contribution = rev.minus(variableCost);
  const operatingProfit = contribution.minus(fixedCost);

  const contributionMargin = rev.isZero() ? null : contribution.dividedBy(rev).toNumber();
  const observations: string[] = [];

  // Break-even is undefined when each additional unit loses money: no volume
  // covers the fixed base, so reporting a figure would be misleading.
  const breakEvenRevenue =
    contributionMargin === null || contributionMargin <= 0
      ? null
      : fixedCost.dividedBy(contributionMargin);

  if (contributionMargin !== null && contributionMargin <= 0 && !rev.isZero()) {
    observations.push(
      'Variable cost equals or exceeds revenue, so every additional unit of volume increases the loss. There is no break-even volume.',
    );
  }

  const marginOfSafety =
    breakEvenRevenue === null || rev.isZero()
      ? null
      : rev.minus(breakEvenRevenue).dividedBy(rev).toNumber();

  if (marginOfSafety !== null && marginOfSafety < 0.1 && marginOfSafety >= 0) {
    observations.push(
      `Revenue is only ${(marginOfSafety * 100).toFixed(1)}% above break-even. A small volume shortfall turns this loss-making.`,
    );
  }
  if (marginOfSafety !== null && marginOfSafety < 0) {
    observations.push('Revenue is below break-even; this operation is currently loss-making.');
  }

  const operatingLeverage = operatingProfit.isZero()
    ? null
    : contribution.dividedBy(operatingProfit).toNumber();

  if (operatingLeverage !== null && operatingLeverage > 3) {
    observations.push(
      `Operating leverage is ${operatingLeverage.toFixed(1)}x: a 1% revenue move swings operating profit by about ${operatingLeverage.toFixed(1)}%. Treat revenue forecasts here as high-consequence.`,
    );
  }

  observations.push(...behaviour.observations);

  return {
    revenue: toMoneyString(rev),
    variableCost: toMoneyString(variableCost),
    contribution: toMoneyString(contribution),
    contributionMargin,
    fixedCost: toMoneyString(fixedCost),
    operatingProfit: toMoneyString(operatingProfit),
    operatingMargin: rev.isZero() ? null : operatingProfit.dividedBy(rev).toNumber(),
    breakEvenRevenue: breakEvenRevenue === null ? null : toMoneyString(breakEvenRevenue),
    marginOfSafety,
    operatingLeverage,
    observations,
  };
}

/**
 * Flex a budget to the volume actually achieved.
 *
 * Comparing actuals against a budget set for a different volume mixes two
 * effects and blames the wrong people: an overspend caused by doing 20% more
 * work is not the same failure as doing the same work 20% less efficiently.
 * Only the variable element flexes; the fixed element does not.
 */
export function flexBudget(
  lines: readonly CostLine[],
  budgetedVolume: MoneyInput,
  actualVolume: MoneyInput,
): {
  volumeRatio: number;
  originalBudget: string;
  flexedBudget: string;
  flexAdjustment: string;
  lines: Array<{ key: string; label: string; original: string; flexed: string }>;
} {
  const budgeted = toDecimal(budgetedVolume);
  if (budgeted.isZero()) {
    throw CalculationError('Cannot flex a budget against a zero budgeted volume.');
  }
  const ratio = toDecimal(actualVolume).dividedBy(budgeted);

  const resolved = lines.map(resolve);
  const flexedLines = resolved.map((line) => {
    const flexed = toDecimal(line.fixedAmount).plus(toDecimal(line.variableAmount).times(ratio));
    return {
      key: line.key,
      label: line.label,
      original: line.amount,
      flexed: toMoneyString(flexed),
    };
  });

  const originalBudget =
    resolved.length === 0 ? new Decimal(0) : add(...resolved.map((l) => l.amount));
  const flexedBudget =
    flexedLines.length === 0 ? new Decimal(0) : add(...flexedLines.map((l) => l.flexed));

  return {
    volumeRatio: ratio.toNumber(),
    originalBudget: toMoneyString(originalBudget),
    flexedBudget: toMoneyString(flexedBudget),
    flexAdjustment: toMoneyString(flexedBudget.minus(originalBudget)),
    lines: flexedLines,
  };
}
