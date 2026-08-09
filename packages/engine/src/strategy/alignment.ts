/**
 * Strategic alignment scoring.
 *
 * Answers the question leadership actually cares about at budget review: does
 * where the money goes match what we said our priorities were?
 *
 * The output is deliberately blunt. A weighted alignment score is easy to game,
 * so it is reported next to the unweighted funding split and the gap against
 * declared target shares - three views that are hard to make agree unless the
 * budget genuinely is aligned.
 */
import {
  ALIGNMENT_WEIGHT,
  Decimal,
  add,
  toDecimal,
  toMoneyString,
  type AlignmentStrength,
  type StrategicHorizon,
} from '@ffp/shared';

export interface StrategicObjective {
  id: string;
  code: string;
  title: string;
  horizon: StrategicHorizon;
  /** Share of total budget leadership intends this objective to receive. */
  targetShare?: number;
}

export interface AlignedBudgetLine {
  id: string;
  label: string;
  amount: string;
  businessUnitId?: string;
  objectiveId?: string | null;
  alignment: AlignmentStrength;
}

export interface ObjectiveAllocation {
  objectiveId: string;
  code: string;
  title: string;
  horizon: StrategicHorizon;
  amount: string;
  /** Actual share of the total budget. */
  actualShare: number;
  targetShare: number | null;
  /** actualShare - targetShare. Negative means underfunded against intent. */
  shareGap: number | null;
  /** Money that would need to move to hit the target share. */
  fundingGap: string | null;
  lineCount: number;
}

export interface AlignmentReport {
  totalBudget: string;
  /** Budget with no objective linked at all. */
  unallocated: string;
  unallocatedShare: number;
  allocations: ObjectiveAllocation[];
  /** Spend by horizon - the core/adjacent/transformational balance. */
  byHorizon: Array<{ horizon: StrategicHorizon; amount: string; share: number }>;
  /**
   * Money-weighted alignment score in [0,1]: 1 means every pound is directly
   * tied to an objective. Weighted by {@link ALIGNMENT_WEIGHT}.
   */
  alignmentScore: number;
  /** Objectives whose funding gap exceeds the tolerance, worst first. */
  misalignments: ObjectiveAllocation[];
  observations: string[];
}

export interface AlignmentOptions {
  /** Share-gap magnitude beyond which an objective is flagged. Default 5pp. */
  toleranceShare?: number;
}

/** Score a budget against the strategic objectives it claims to serve. */
export function assessAlignment(
  lines: readonly AlignedBudgetLine[],
  objectives: readonly StrategicObjective[],
  options: AlignmentOptions = {},
): AlignmentReport {
  const tolerance = options.toleranceShare ?? 0.05;
  const observations: string[] = [];

  const total = lines.length === 0 ? new Decimal(0) : add(...lines.map((l) => l.amount));
  const objectiveById = new Map(objectives.map((o) => [o.id, o]));

  const amountByObjective = new Map<string, Decimal>();
  const countByObjective = new Map<string, number>();
  const amountByHorizon = new Map<StrategicHorizon, Decimal>();
  let unallocated = new Decimal(0);
  let weightedAligned = new Decimal(0);

  for (const line of lines) {
    const amount = toDecimal(line.amount);
    weightedAligned = weightedAligned.plus(amount.times(ALIGNMENT_WEIGHT[line.alignment]));

    const objective = line.objectiveId ? objectiveById.get(line.objectiveId) : undefined;
    if (!objective) {
      unallocated = unallocated.plus(amount);
      continue;
    }

    amountByObjective.set(
      objective.id,
      (amountByObjective.get(objective.id) ?? new Decimal(0)).plus(amount),
    );
    countByObjective.set(objective.id, (countByObjective.get(objective.id) ?? 0) + 1);
    amountByHorizon.set(
      objective.horizon,
      (amountByHorizon.get(objective.horizon) ?? new Decimal(0)).plus(amount),
    );
  }

  const shareOf = (amount: Decimal) => (total.isZero() ? 0 : amount.dividedBy(total).toNumber());

  const allocations: ObjectiveAllocation[] = objectives
    .map((objective) => {
      const amount = amountByObjective.get(objective.id) ?? new Decimal(0);
      const actualShare = shareOf(amount);
      const targetShare = objective.targetShare ?? null;
      const shareGap = targetShare === null ? null : actualShare - targetShare;

      return {
        objectiveId: objective.id,
        code: objective.code,
        title: objective.title,
        horizon: objective.horizon,
        amount: toMoneyString(amount),
        actualShare,
        targetShare,
        shareGap,
        fundingGap: shareGap === null ? null : toMoneyString(total.times(-shareGap)),
        lineCount: countByObjective.get(objective.id) ?? 0,
      };
    })
    .sort((a, b) => b.actualShare - a.actualShare);

  const byHorizon = (['H1_CORE', 'H2_ADJACENT', 'H3_TRANSFORMATIONAL'] as StrategicHorizon[]).map(
    (horizon) => {
      const amount = amountByHorizon.get(horizon) ?? new Decimal(0);
      return { horizon, amount: toMoneyString(amount), share: shareOf(amount) };
    },
  );

  const unallocatedShare = shareOf(unallocated);
  if (unallocatedShare > 0.1) {
    observations.push(
      `${(unallocatedShare * 100).toFixed(1)}% of the budget is not linked to any strategic objective. Leadership cannot assess what this funding buys.`,
    );
  }

  const transformational = byHorizon.find((h) => h.horizon === 'H3_TRANSFORMATIONAL');
  if (transformational && transformational.share < 0.05 && !total.isZero()) {
    observations.push(
      `Only ${(transformational.share * 100).toFixed(1)}% is directed at transformational work. Budgets weighted almost entirely to the core tend to under-fund the next horizon.`,
    );
  }

  const misalignments = allocations
    .filter((a) => a.shareGap !== null && Math.abs(a.shareGap) > tolerance)
    .sort((a, b) => (a.shareGap as number) - (b.shareGap as number));

  for (const item of misalignments.slice(0, 3)) {
    const gap = item.shareGap as number;
    observations.push(
      gap < 0
        ? `'${item.title}' is underfunded by ${toMoneyString(toDecimal(item.fundingGap ?? '0').abs())} against its ${((item.targetShare ?? 0) * 100).toFixed(0)}% target share.`
        : `'${item.title}' is overfunded by ${toMoneyString(toDecimal(item.fundingGap ?? '0').abs())} against its ${((item.targetShare ?? 0) * 100).toFixed(0)}% target share.`,
    );
  }

  return {
    totalBudget: toMoneyString(total),
    unallocated: toMoneyString(unallocated),
    unallocatedShare,
    allocations,
    byHorizon,
    alignmentScore: total.isZero() ? 0 : weightedAligned.dividedBy(total).toNumber(),
    misalignments,
    observations,
  };
}
