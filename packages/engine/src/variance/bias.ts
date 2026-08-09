/**
 * Planning bias detection.
 *
 * A single variance is noise. The same person missing in the same direction for
 * six cycles running is a pattern, and it is the most actionable thing in a
 * budgeting system: sandbagging inflates the cost base and hides capacity, while
 * persistent optimism destroys the credibility of every plan built on it.
 *
 * The distinction this module draws is between *magnitude* and *consistency*.
 * Someone who misses by 30% in alternating directions has an estimation problem.
 * Someone who misses by 4% in the same direction every single time is doing it
 * on purpose, and only the second is bias.
 */
import {
  CalculationError,
  Decimal,
  add,
  toDecimal,
  toMoneyString,
  type MoneyInput,
} from '@ffp/shared';
import { mean } from '../stats.js';

export interface BiasObservation {
  /** Whoever is accountable - a budget owner, or a business unit. */
  subjectId: string;
  subjectName: string;
  /** Cycle or period this observation belongs to. One per cycle per subject. */
  periodLabel: string;
  budget: MoneyInput;
  actual: MoneyInput;
  /** Cost lines and revenue lines bias in opposite directions; default is cost. */
  isRevenue?: boolean;
}

export type BiasVerdict =
  /** Consistently budgets more than needed - padding, sandbagging. */
  | 'SYSTEMATIC_OVERSTATEMENT'
  /** Consistently budgets less than needed - optimism, under-scoping. */
  | 'SYSTEMATIC_UNDERSTATEMENT'
  /** Large errors, but no consistent direction. An accuracy problem, not bias. */
  | 'INCONSISTENT'
  /** Accurate and unbiased. */
  | 'WELL_CALIBRATED'
  /** Too few observations to judge. */
  | 'INSUFFICIENT_DATA';

export interface SubjectBias {
  subjectId: string;
  subjectName: string;
  observationCount: number;
  totalBudget: string;
  totalActual: string;
  /**
   * Mean percentage error, signed. Positive means budget exceeded actual, i.e.
   * more was asked for than was needed.
   */
  meanPercentageError: number | null;
  /** Mean absolute percentage error - accuracy irrespective of direction. */
  meanAbsolutePercentageError: number | null;
  /**
   * Fraction of observations erring in the dominant direction, in [0.5, 1].
   * 1.0 means every single period missed the same way.
   */
  directionalConsistency: number | null;
  verdict: BiasVerdict;
  /** Cumulative money tied up by the bias across the observed periods. */
  cumulativeImpact: string;
  explanation: string;
}

export interface PlanningBiasReport {
  subjects: SubjectBias[];
  /** Subjects showing a systematic direction, worst first by cumulative impact. */
  flagged: SubjectBias[];
  portfolioMeanPercentageError: number | null;
  totalCumulativeImpact: string;
  observations: string[];
}

export interface BiasOptions {
  /** Observations required before a verdict is offered. Default 3. */
  minimumObservations?: number;
  /** |mean % error| above which bias is material. Default 0.05 (5pp). */
  materialityThreshold?: number;
  /** Directional consistency above which the pattern is deliberate. Default 0.75. */
  consistencyThreshold?: number;
}

/**
 * Assess bias per subject.
 *
 * Sign convention: `percentage error = (budget - actual) / |budget|`, so a
 * positive value means "asked for more than was used". For revenue the meaning
 * inverts - budgeting revenue *above* actual is optimism, not padding - so the
 * sign is flipped for revenue observations before aggregation, leaving positive
 * consistently meaning "the plan flattered the unit".
 */
export function assessPlanningBias(
  observations: readonly BiasObservation[],
  options: BiasOptions = {},
): PlanningBiasReport {
  const minimumObservations = options.minimumObservations ?? 3;
  const materiality = options.materialityThreshold ?? 0.05;
  const consistencyThreshold = options.consistencyThreshold ?? 0.75;

  if (minimumObservations < 1) {
    throw CalculationError('minimumObservations must be at least 1.');
  }

  const bySubject = new Map<string, BiasObservation[]>();
  for (const observation of observations) {
    const existing = bySubject.get(observation.subjectId);
    if (existing) existing.push(observation);
    else bySubject.set(observation.subjectId, [observation]);
  }

  const subjects: SubjectBias[] = [];

  for (const [subjectId, group] of bySubject) {
    const name = group[0]?.subjectName ?? subjectId;

    const errors: number[] = [];
    let cumulativeImpact = new Decimal(0);

    for (const observation of group) {
      const budget = toDecimal(observation.budget);
      const actual = toDecimal(observation.actual);
      if (budget.isZero()) continue; // No baseline to be biased against.

      const raw = budget.minus(actual).dividedBy(budget.abs()).toNumber();
      // Flip revenue so positive always reads as "the plan flattered the unit".
      errors.push(observation.isRevenue ? -raw : raw);
      cumulativeImpact = cumulativeImpact.plus(
        observation.isRevenue ? actual.minus(budget) : budget.minus(actual),
      );
    }

    const totalBudget = group.length === 0 ? new Decimal(0) : add(...group.map((o) => o.budget));
    const totalActual = group.length === 0 ? new Decimal(0) : add(...group.map((o) => o.actual));

    if (errors.length === 0) {
      subjects.push({
        subjectId,
        subjectName: name,
        observationCount: 0,
        totalBudget: toMoneyString(totalBudget),
        totalActual: toMoneyString(totalActual),
        meanPercentageError: null,
        meanAbsolutePercentageError: null,
        directionalConsistency: null,
        verdict: 'INSUFFICIENT_DATA',
        cumulativeImpact: toMoneyString(0),
        explanation: 'No period had a non-zero budget to measure against.',
      });
      continue;
    }

    const mpe = mean(errors);
    const mape = mean(errors.map(Math.abs));

    const positive = errors.filter((e) => e > 0).length;
    const negative = errors.filter((e) => e < 0).length;
    const directional = Math.max(positive, negative) / errors.length;

    const { verdict, explanation } = judge({
      count: errors.length,
      mpe,
      mape,
      directional,
      minimumObservations,
      materiality,
      consistencyThreshold,
      name,
    });

    subjects.push({
      subjectId,
      subjectName: name,
      observationCount: errors.length,
      totalBudget: toMoneyString(totalBudget),
      totalActual: toMoneyString(totalActual),
      meanPercentageError: mpe,
      meanAbsolutePercentageError: mape,
      directionalConsistency: directional,
      verdict,
      cumulativeImpact: toMoneyString(cumulativeImpact),
      explanation,
    });
  }

  subjects.sort(
    (a, b) => Math.abs(Number(b.cumulativeImpact)) - Math.abs(Number(a.cumulativeImpact)),
  );

  const flagged = subjects.filter(
    (s) => s.verdict === 'SYSTEMATIC_OVERSTATEMENT' || s.verdict === 'SYSTEMATIC_UNDERSTATEMENT',
  );

  const withError = subjects.filter((s) => s.meanPercentageError !== null);
  const portfolioMpe =
    withError.length === 0 ? null : mean(withError.map((s) => s.meanPercentageError as number));

  const totalCumulativeImpact =
    subjects.length === 0 ? new Decimal(0) : add(...subjects.map((s) => s.cumulativeImpact));

  const reportObservations: string[] = [];

  if (flagged.length > 0) {
    reportObservations.push(
      `${flagged.length} of ${subjects.length} budget holders show a systematic directional bias rather than random estimation error.`,
    );
  }
  if (portfolioMpe !== null && Math.abs(portfolioMpe) > materiality) {
    reportObservations.push(
      portfolioMpe > 0
        ? `The portfolio budgets ${(portfolioMpe * 100).toFixed(1)}% above outturn on average. Consolidated plans are carrying padding, and capacity is being reserved that is not used.`
        : `The portfolio budgets ${(Math.abs(portfolioMpe) * 100).toFixed(1)}% below outturn on average. Plans are systematically optimistic and overspend is being built in at submission.`,
    );
  }
  if (flagged.length === 0 && subjects.length > 0) {
    reportObservations.push(
      'No budget holder shows a systematic directional bias. Variances look like estimation error rather than deliberate padding or optimism.',
    );
  }

  return {
    subjects,
    flagged,
    portfolioMeanPercentageError: portfolioMpe,
    totalCumulativeImpact: toMoneyString(totalCumulativeImpact),
    observations: reportObservations,
  };
}

function judge(input: {
  count: number;
  mpe: number;
  mape: number;
  directional: number;
  minimumObservations: number;
  materiality: number;
  consistencyThreshold: number;
  name: string;
}): { verdict: BiasVerdict; explanation: string } {
  const {
    count,
    mpe,
    mape,
    directional,
    minimumObservations,
    materiality,
    consistencyThreshold,
    name,
  } = input;

  if (count < minimumObservations) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      explanation: `Only ${count} comparable period(s); at least ${minimumObservations} are needed before calling a pattern.`,
    };
  }

  const material = Math.abs(mpe) > materiality;
  const consistent = directional >= consistencyThreshold;

  if (material && consistent) {
    const pct = (Math.abs(mpe) * 100).toFixed(1);
    const times = `${Math.round(directional * count)} of ${count} periods`;
    return mpe > 0
      ? {
          verdict: 'SYSTEMATIC_OVERSTATEMENT',
          explanation: `${name} budgeted above outturn in ${times}, by ${pct}% on average. That is consistent enough to be padding rather than estimation error; the reserved capacity is unavailable to the rest of the business.`,
        }
      : {
          verdict: 'SYSTEMATIC_UNDERSTATEMENT',
          explanation: `${name} budgeted below outturn in ${times}, by ${pct}% on average. Plans from this holder should be treated as a floor, and the overspend is effectively committed at submission.`,
        };
  }

  if (mape > materiality * 2) {
    return {
      verdict: 'INCONSISTENT',
      explanation: `${name} misses by ${(mape * 100).toFixed(1)}% on average but in no consistent direction. This is an estimation accuracy problem, not bias - better drivers would help more than challenge.`,
    };
  }

  return {
    verdict: 'WELL_CALIBRATED',
    explanation: `${name} is within ${(mape * 100).toFixed(1)}% on average with no directional pattern. Treat these submissions as reliable.`,
  };
}
