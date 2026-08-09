/**
 * Budget-versus-actual analysis - the reporting end of the budget cycle.
 *
 * The subtlety that catches most implementations is direction. Spending less
 * than budget is favourable; earning less than budget is not. Both are "actual
 * below budget". The sign convention comes from the account type and is applied
 * in exactly one place, {@link varianceDirection}.
 *
 * Commitments are treated as spent. A budget holder with 100k left and 90k on
 * purchase orders does not have 100k available, and a report that says otherwise
 * causes overspend.
 */
import {
  Decimal,
  FAVOURABLE_WHEN_OVER,
  add,
  percentChange,
  toDecimal,
  toMoneyString,
  type AccountType,
  type CostCategory,
  type RagStatus,
  type VarianceDirection,
} from '@ffp/shared';

export interface VarianceInput {
  key: string;
  label: string;
  accountType: AccountType;
  costCategory?: CostCategory;
  businessUnitId?: string;
  accountId?: string;
  periodKey?: string;
  budget: string;
  actual: string;
  /** Committed but not yet incurred. */
  commitment?: string;
  /** Latest forecast for the full period, where one exists. */
  forecast?: string;
}

export interface VarianceThresholds {
  /** Absolute percentage variance at which a line turns amber. */
  amber: number;
  /** ...and red. */
  red: number;
  /**
   * Lines smaller than this are never flagged, regardless of percentage.
   * Stops a 40 budget overspent by 30 dominating a report about millions.
   */
  materialityFloor?: string;
}

export const DEFAULT_THRESHOLDS: VarianceThresholds = {
  amber: 0.05,
  red: 0.1,
  materialityFloor: '1000',
};

export interface VarianceLine extends VarianceInput {
  /** Actual plus commitment - what is genuinely consumed. */
  consumed: string;
  /** budget - consumed, signed so that positive is always "under budget". */
  variance: string;
  variancePercent: number | null;
  direction: VarianceDirection;
  rag: RagStatus;
  /** Budget still genuinely available. */
  remaining: string;
  /** Fraction of budget consumed. Null when the budget is zero. */
  utilisation: number | null;
  /** Forecast full-period outturn against budget, when a forecast is present. */
  forecastVariance: string | null;
  forecastVariancePercent: number | null;
}

/**
 * Direction of a variance, given the account type.
 * `variance` here is budget - actual, so positive means "spent/earned less".
 */
export function varianceDirection(variance: Decimal, accountType: AccountType): VarianceDirection {
  if (variance.isZero()) return 'NEUTRAL';
  const under = variance.greaterThan(0);
  // For revenue, being under budget is bad; for cost, it is good.
  const favourable = FAVOURABLE_WHEN_OVER[accountType] ? !under : under;
  return favourable ? 'FAVOURABLE' : 'UNFAVOURABLE';
}

/** RAG band. Favourable variances never go red, however large. */
export function ragFor(
  variancePercent: number | null,
  direction: VarianceDirection,
  thresholds: VarianceThresholds,
): RagStatus {
  if (variancePercent === null || direction !== 'UNFAVOURABLE') return 'GREEN';
  const magnitude = Math.abs(variancePercent);
  if (magnitude >= thresholds.red) return 'RED';
  if (magnitude >= thresholds.amber) return 'AMBER';
  return 'GREEN';
}

export function analyseVarianceLine(
  input: VarianceInput,
  thresholds: VarianceThresholds = DEFAULT_THRESHOLDS,
  options: { includeCommitments?: boolean } = {},
): VarianceLine {
  const includeCommitments = options.includeCommitments ?? true;

  const budget = toDecimal(input.budget);
  const actual = toDecimal(input.actual);
  const commitment = includeCommitments ? toDecimal(input.commitment ?? '0') : new Decimal(0);
  const consumed = actual.plus(commitment);

  const variance = budget.minus(consumed);
  const variancePercent = budget.isZero() ? null : variance.dividedBy(budget.abs()).toNumber();
  const direction = varianceDirection(variance, input.accountType);

  const floor = toDecimal(thresholds.materialityFloor ?? '0');
  const immaterial = variance.abs().lessThan(floor);

  const forecast = input.forecast === undefined ? null : toDecimal(input.forecast);
  const forecastVariance = forecast === null ? null : budget.minus(forecast);

  return {
    ...input,
    consumed: toMoneyString(consumed),
    variance: toMoneyString(variance),
    variancePercent,
    direction,
    rag: immaterial ? 'GREEN' : ragFor(variancePercent, direction, thresholds),
    remaining: toMoneyString(budget.minus(consumed)),
    utilisation: budget.isZero() ? null : consumed.dividedBy(budget).toNumber(),
    forecastVariance: forecastVariance === null ? null : toMoneyString(forecastVariance),
    forecastVariancePercent:
      forecast === null ? null : (percentChange(budget, forecast)?.negated().toNumber() ?? null),
  };
}

export interface VarianceGroup {
  key: string;
  label: string;
  budget: string;
  actual: string;
  commitment: string;
  consumed: string;
  variance: string;
  variancePercent: number | null;
  direction: VarianceDirection;
  rag: RagStatus;
  lineCount: number;
  lines: VarianceLine[];
}

export interface VarianceReport {
  lines: VarianceLine[];
  groups: VarianceGroup[];
  totals: Omit<VarianceGroup, 'lines' | 'key' | 'label'>;
  /** Unfavourable lines, worst first - what the review meeting works through. */
  exceptions: VarianceLine[];
  thresholds: VarianceThresholds;
}

export type GroupBy = 'ACCOUNT' | 'BUSINESS_UNIT' | 'COST_CATEGORY' | 'PERIOD' | 'NONE';

function groupKeyFor(line: VarianceLine, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'ACCOUNT':
      return line.accountId ?? line.key;
    case 'BUSINESS_UNIT':
      return line.businessUnitId ?? 'UNASSIGNED';
    case 'COST_CATEGORY':
      return line.costCategory ?? 'UNCATEGORISED';
    case 'PERIOD':
      return line.periodKey ?? 'UNDATED';
    case 'NONE':
      return 'ALL';
    default: {
      const exhaustive: never = groupBy;
      return String(exhaustive);
    }
  }
}

/** Full variance report: lines, roll-ups, totals and an exception list. */
export function buildVarianceReport(
  inputs: readonly VarianceInput[],
  options: {
    thresholds?: VarianceThresholds;
    groupBy?: GroupBy;
    includeCommitments?: boolean;
  } = {},
): VarianceReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const groupBy = options.groupBy ?? 'ACCOUNT';
  const includeCommitments = options.includeCommitments ?? true;

  const lines = inputs.map((input) =>
    analyseVarianceLine(input, thresholds, { includeCommitments }),
  );

  const buckets = new Map<string, VarianceLine[]>();
  for (const line of lines) {
    const key = groupKeyFor(line, groupBy);
    const existing = buckets.get(key);
    if (existing) existing.push(line);
    else buckets.set(key, [line]);
  }

  const groups = [...buckets.entries()]
    .map(([key, groupLines]) => rollUp(key, groupLines[0]?.label ?? key, groupLines, thresholds))
    .sort((a, b) => toDecimal(a.variance).comparedTo(toDecimal(b.variance)));

  const totalsGroup = rollUp('TOTAL', 'Total', lines, thresholds);
  const { key: _k, label: _l, lines: _lines, ...totals } = totalsGroup;

  return {
    lines,
    groups,
    totals,
    exceptions: lines
      .filter((l) => l.direction === 'UNFAVOURABLE' && l.rag !== 'GREEN')
      .sort((a, b) => toDecimal(a.variance).comparedTo(toDecimal(b.variance))),
    thresholds,
  };
}

function rollUp(
  key: string,
  label: string,
  lines: readonly VarianceLine[],
  thresholds: VarianceThresholds,
): VarianceGroup {
  const total = (pick: (l: VarianceLine) => string) =>
    lines.length === 0 ? new Decimal(0) : add(...lines.map(pick));

  const budget = total((l) => l.budget);
  const actual = total((l) => l.actual);
  const commitment = total((l) => l.commitment ?? '0');
  const consumed = total((l) => l.consumed);
  const variance = budget.minus(consumed);
  const variancePercent = budget.isZero() ? null : variance.dividedBy(budget.abs()).toNumber();

  // A mixed group has no single account type. Direction is taken from the
  // dominant type by budget, which is what a reader of a subtotal assumes.
  const accountType = dominantAccountType(lines);
  const direction = varianceDirection(variance, accountType);

  return {
    key,
    label,
    budget: toMoneyString(budget),
    actual: toMoneyString(actual),
    commitment: toMoneyString(commitment),
    consumed: toMoneyString(consumed),
    variance: toMoneyString(variance),
    variancePercent,
    direction,
    rag: ragFor(variancePercent, direction, thresholds),
    lineCount: lines.length,
    lines: [...lines],
  };
}

function dominantAccountType(lines: readonly VarianceLine[]): AccountType {
  const totals = new Map<AccountType, Decimal>();
  for (const line of lines) {
    totals.set(
      line.accountType,
      (totals.get(line.accountType) ?? new Decimal(0)).plus(toDecimal(line.budget).abs()),
    );
  }
  let best: AccountType = 'OPEX';
  let bestValue = new Decimal(-1);
  for (const [type, value] of totals) {
    if (value.greaterThan(bestValue)) {
      best = type;
      bestValue = value;
    }
  }
  return best;
}
