/**
 * Risk register scoring.
 *
 * Standard 5x5 probability/impact matrix, plus the two things a heat map alone
 * never tells you: the expected monetary value of each risk, and how much of the
 * total exposure a mitigation plan actually removes.
 */
import {
  Decimal,
  add,
  toDecimal,
  toMoneyString,
  type RiskCategory,
  type RiskResponse,
  type RiskSeverity,
  type RiskStatus,
  CalculationError,
} from '@ffp/shared';

export interface RiskEntry {
  id: string;
  title: string;
  category: RiskCategory;
  /** 1-5, where 5 is near-certain. */
  probability: number;
  /** 1-5, where 5 is severe. */
  impact: number;
  /** Cost if the risk materialises, in base currency. */
  financialImpact: string;
  response: RiskResponse;
  /** Post-mitigation scores. Absent means mitigation has not been assessed. */
  residualProbability?: number;
  residualImpact?: number;
  status: RiskStatus;
  ownerId?: string;
}

export interface ScoredRisk extends RiskEntry {
  inherentScore: number;
  inherentSeverity: RiskSeverity;
  residualScore: number | null;
  residualSeverity: RiskSeverity | null;
  /** probability (as a fraction) x financial impact. */
  expectedValue: string;
  residualExpectedValue: string | null;
  /** Exposure removed by mitigation. Negative means mitigation made it worse. */
  mitigationBenefit: string | null;
}

/**
 * Mapping from a 1-5 probability band to a working likelihood.
 * Midpoints of the conventional bands - "possible" is genuinely around 30%, not
 * the 60% a naive `probability / 5` would imply.
 */
export const PROBABILITY_BANDS: Record<number, number> = {
  1: 0.05,
  2: 0.15,
  3: 0.3,
  4: 0.55,
  5: 0.85,
};

export const PROBABILITY_LABELS: Record<number, string> = {
  1: 'Rare',
  2: 'Unlikely',
  3: 'Possible',
  4: 'Likely',
  5: 'Almost certain',
};

export const IMPACT_LABELS: Record<number, string> = {
  1: 'Insignificant',
  2: 'Minor',
  3: 'Moderate',
  4: 'Major',
  5: 'Catastrophic',
};

function assertBand(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw CalculationError(`${field} must be an integer from 1 to 5, got ${value}.`, {
      [field]: value,
    });
  }
}

/** Severity band from the product of probability and impact (1-25). */
export function severityFor(score: number): RiskSeverity {
  if (score <= 3) return 'LOW';
  if (score <= 7) return 'MODERATE';
  if (score <= 12) return 'HIGH';
  if (score <= 19) return 'SEVERE';
  return 'CRITICAL';
}

export function likelihoodOf(probabilityBand: number): number {
  assertBand(probabilityBand, 'probability');
  return PROBABILITY_BANDS[probabilityBand] as number;
}

/** Score one risk, inherent and residual. */
export function scoreRisk(risk: RiskEntry): ScoredRisk {
  assertBand(risk.probability, 'probability');
  assertBand(risk.impact, 'impact');

  const inherentScore = risk.probability * risk.impact;
  const impactAmount = toDecimal(risk.financialImpact);
  const expectedValue = impactAmount.times(likelihoodOf(risk.probability));

  const hasResidual = risk.residualProbability !== undefined && risk.residualImpact !== undefined;

  if (hasResidual) {
    assertBand(risk.residualProbability as number, 'residualProbability');
    assertBand(risk.residualImpact as number, 'residualImpact');
  }

  const residualScore = hasResidual
    ? (risk.residualProbability as number) * (risk.residualImpact as number)
    : null;

  // Residual impact scales the monetary consequence in proportion to the drop in
  // the impact band - mitigation usually reduces severity, not just likelihood.
  const residualExpected = hasResidual
    ? impactAmount
        .times((risk.residualImpact as number) / risk.impact)
        .times(likelihoodOf(risk.residualProbability as number))
    : null;

  return {
    ...risk,
    inherentScore,
    inherentSeverity: severityFor(inherentScore),
    residualScore,
    residualSeverity: residualScore === null ? null : severityFor(residualScore),
    expectedValue: toMoneyString(expectedValue),
    residualExpectedValue: residualExpected === null ? null : toMoneyString(residualExpected),
    mitigationBenefit:
      residualExpected === null ? null : toMoneyString(expectedValue.minus(residualExpected)),
  };
}

export interface RiskRegisterSummary {
  risks: ScoredRisk[];
  totalInherentExposure: string;
  totalResidualExposure: string;
  totalMitigationBenefit: string;
  /** Count by severity band, inherent. */
  severityCounts: Record<RiskSeverity, number>;
  byCategory: Array<{ category: RiskCategory; count: number; exposure: string }>;
  /** Risks at SEVERE or CRITICAL that are still open - the escalation list. */
  escalations: ScoredRisk[];
  /** 5x5 grid of counts, indexed [impact-1][probability-1]. */
  heatMap: number[][];
}

const CLOSED_STATUSES: ReadonlySet<RiskStatus> = new Set(['MITIGATED', 'CLOSED']);

/** Score a whole register and produce the roll-ups a risk report needs. */
export function summariseRegister(risks: readonly RiskEntry[]): RiskRegisterSummary {
  const scored = risks.map(scoreRisk);

  const severityCounts: Record<RiskSeverity, number> = {
    LOW: 0,
    MODERATE: 0,
    HIGH: 0,
    SEVERE: 0,
    CRITICAL: 0,
  };
  const heatMap = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
  const categoryMap = new Map<RiskCategory, { count: number; exposure: Decimal }>();

  for (const risk of scored) {
    severityCounts[risk.inherentSeverity] += 1;
    const row = heatMap[risk.impact - 1];
    if (row) row[risk.probability - 1] = (row[risk.probability - 1] ?? 0) + 1;

    const existing = categoryMap.get(risk.category) ?? { count: 0, exposure: new Decimal(0) };
    categoryMap.set(risk.category, {
      count: existing.count + 1,
      exposure: existing.exposure.plus(toDecimal(risk.expectedValue)),
    });
  }

  const totalInherent =
    scored.length === 0 ? new Decimal(0) : add(...scored.map((r) => r.expectedValue));
  const totalResidual =
    scored.length === 0
      ? new Decimal(0)
      : add(...scored.map((r) => r.residualExpectedValue ?? r.expectedValue));

  return {
    risks: scored,
    totalInherentExposure: toMoneyString(totalInherent),
    totalResidualExposure: toMoneyString(totalResidual),
    totalMitigationBenefit: toMoneyString(totalInherent.minus(totalResidual)),
    severityCounts,
    byCategory: [...categoryMap.entries()]
      .map(([category, v]) => ({
        category,
        count: v.count,
        exposure: toMoneyString(v.exposure),
      }))
      .sort((a, b) => toDecimal(b.exposure).comparedTo(toDecimal(a.exposure))),
    escalations: scored
      .filter(
        (r) =>
          (r.inherentSeverity === 'SEVERE' || r.inherentSeverity === 'CRITICAL') &&
          !CLOSED_STATUSES.has(r.status),
      )
      .sort((a, b) => b.inherentScore - a.inherentScore),
    heatMap,
  };
}
