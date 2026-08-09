import { describe, expect, it } from 'vitest';
import {
  PROBABILITY_BANDS,
  likelihoodOf,
  scoreRisk,
  severityFor,
  summariseRegister,
  type RiskEntry,
} from './register.js';

const risk = (over: Partial<RiskEntry> = {}): RiskEntry => ({
  id: 'r1',
  title: 'A risk',
  category: 'FINANCIAL',
  probability: 3,
  impact: 3,
  financialImpact: '100000',
  response: 'MITIGATE',
  status: 'OPEN',
  ...over,
});

describe('severityFor', () => {
  it('bands the 1-25 score at the documented cutoffs', () => {
    expect(severityFor(1)).toBe('LOW');
    expect(severityFor(3)).toBe('LOW');
    expect(severityFor(4)).toBe('MODERATE');
    expect(severityFor(7)).toBe('MODERATE');
    expect(severityFor(8)).toBe('HIGH');
    expect(severityFor(12)).toBe('HIGH');
    expect(severityFor(13)).toBe('SEVERE');
    expect(severityFor(19)).toBe('SEVERE');
    expect(severityFor(20)).toBe('CRITICAL');
    expect(severityFor(25)).toBe('CRITICAL');
  });
});

describe('likelihoodOf', () => {
  it('uses band midpoints rather than a naive probability/5', () => {
    // A "possible" risk is around 30%, not 3/5 = 60%.
    expect(likelihoodOf(1)).toBe(0.05);
    expect(likelihoodOf(2)).toBe(0.15);
    expect(likelihoodOf(3)).toBe(0.3);
    expect(likelihoodOf(4)).toBe(0.55);
    expect(likelihoodOf(5)).toBe(0.85);
    expect(PROBABILITY_BANDS[3]).not.toBe(3 / 5);
  });

  it('rejects out-of-range bands', () => {
    expect(() => likelihoodOf(0)).toThrow(/1 to 5/);
    expect(() => likelihoodOf(6)).toThrow(/1 to 5/);
    expect(() => likelihoodOf(2.5)).toThrow(/1 to 5/);
  });
});

describe('scoreRisk', () => {
  it('computes the inherent score and expected value', () => {
    // 4 x 4 = 16 => SEVERE. Expected value = 0.55 x 200,000 = 110,000.
    const scored = scoreRisk(risk({ probability: 4, impact: 4, financialImpact: '200000' }));
    expect(scored.inherentScore).toBe(16);
    expect(scored.inherentSeverity).toBe('SEVERE');
    expect(scored.expectedValue).toBe('110000.0000');
  });

  it('scales the monetary consequence by the drop in impact band', () => {
    // Inherent: 4x4, 200,000 => EV 0.55 x 200,000 = 110,000.
    // Residual: 2x2 => impact scaled 2/4 = 100,000, likelihood 0.15 => 15,000.
    // Benefit = 110,000 - 15,000 = 95,000.
    const scored = scoreRisk(
      risk({
        probability: 4,
        impact: 4,
        financialImpact: '200000',
        residualProbability: 2,
        residualImpact: 2,
      }),
    );
    expect(scored.residualScore).toBe(4);
    expect(scored.residualSeverity).toBe('MODERATE');
    expect(scored.residualExpectedValue).toBe('15000.0000');
    expect(scored.mitigationBenefit).toBe('95000.0000');
  });

  it('leaves residual fields null when mitigation has not been assessed', () => {
    const scored = scoreRisk(risk());
    expect(scored.residualScore).toBeNull();
    expect(scored.residualSeverity).toBeNull();
    expect(scored.residualExpectedValue).toBeNull();
    expect(scored.mitigationBenefit).toBeNull();
  });

  it('rejects invalid inherent and residual bands', () => {
    expect(() => scoreRisk(risk({ probability: 0 }))).toThrow(/probability/);
    expect(() => scoreRisk(risk({ impact: 6 }))).toThrow(/impact/);
    expect(() => scoreRisk(risk({ residualProbability: 9, residualImpact: 2 }))).toThrow(
      /residualProbability/,
    );
    expect(() => scoreRisk(risk({ residualProbability: 2, residualImpact: 0 }))).toThrow(
      /residualImpact/,
    );
  });

  it('handles a zero financial impact without dividing by zero', () => {
    const scored = scoreRisk(
      risk({ financialImpact: '0', residualProbability: 1, residualImpact: 1 }),
    );
    expect(scored.expectedValue).toBe('0.0000');
    expect(scored.residualExpectedValue).toBe('0.0000');
  });
});

describe('summariseRegister', () => {
  const register: RiskEntry[] = [
    risk({
      id: 'a',
      title: 'Energy',
      category: 'MARKET',
      probability: 4,
      impact: 4,
      financialImpact: '200000',
      residualProbability: 3,
      residualImpact: 3,
    }),
    risk({
      id: 'b',
      title: 'Permits',
      category: 'REGULATORY',
      probability: 4,
      impact: 3,
      financialImpact: '100000',
    }),
    risk({
      id: 'c',
      title: 'Outage',
      category: 'OPERATIONAL',
      probability: 2,
      impact: 5,
      financialImpact: '500000',
    }),
    risk({
      id: 'd',
      title: 'Minor',
      category: 'FINANCIAL',
      probability: 1,
      impact: 2,
      financialImpact: '5000',
    }),
    risk({
      id: 'e',
      title: 'Closed severe',
      category: 'TECHNICAL',
      probability: 5,
      impact: 5,
      financialImpact: '900000',
      status: 'MITIGATED',
    }),
  ];

  it('counts severities across the register', () => {
    const summary = summariseRegister(register);
    // a: 16 SEVERE, b: 12 HIGH, c: 10 HIGH, d: 2 LOW, e: 25 CRITICAL
    expect(summary.severityCounts.SEVERE).toBe(1);
    expect(summary.severityCounts.HIGH).toBe(2);
    expect(summary.severityCounts.LOW).toBe(1);
    expect(summary.severityCounts.CRITICAL).toBe(1);
    expect(summary.severityCounts.MODERATE).toBe(0);
  });

  it('indexes the heat map as [impact-1][probability-1]', () => {
    const summary = summariseRegister([risk({ probability: 2, impact: 5 })]);
    expect(summary.heatMap).toHaveLength(5);
    expect(summary.heatMap[4]?.[1]).toBe(1);
    expect(summary.heatMap[1]?.[4]).toBe(0);
  });

  it('totals inherent exposure', () => {
    const summary = summariseRegister(register);
    // 0.55x200000 + 0.55x100000 + 0.15x500000 + 0.05x5000 + 0.85x900000
    // = 110000 + 55000 + 75000 + 250 + 765000 = 1,005,250
    expect(summary.totalInherentExposure).toBe('1005250.0000');
  });

  it('shows mitigation reducing total exposure', () => {
    const summary = summariseRegister(register);
    expect(Number(summary.totalResidualExposure)).toBeLessThan(
      Number(summary.totalInherentExposure),
    );
    expect(Number(summary.totalMitigationBenefit)).toBeGreaterThan(0);
  });

  it('escalates severe and critical risks that are still live', () => {
    const summary = summariseRegister(register);
    const ids = summary.escalations.map((r) => r.id);
    // 'a' is SEVERE and OPEN; 'e' is CRITICAL but MITIGATED, so it is excluded.
    expect(ids).toContain('a');
    expect(ids).not.toContain('e');
    expect(ids).not.toContain('b');
  });

  it('sorts escalations by inherent score, worst first', () => {
    const summary = summariseRegister([
      risk({ id: 'lo', probability: 4, impact: 4 }),
      risk({ id: 'hi', probability: 5, impact: 5 }),
    ]);
    expect(summary.escalations[0]?.id).toBe('hi');
  });

  it('groups by category, largest exposure first', () => {
    const summary = summariseRegister(register);
    expect(summary.byCategory[0]?.category).toBe('TECHNICAL');
    for (let i = 1; i < summary.byCategory.length; i += 1) {
      expect(Number(summary.byCategory[i - 1]?.exposure)).toBeGreaterThanOrEqual(
        Number(summary.byCategory[i]?.exposure),
      );
    }
  });

  it('handles an empty register', () => {
    const summary = summariseRegister([]);
    expect(summary.risks).toHaveLength(0);
    expect(summary.totalInherentExposure).toBe('0.0000');
    expect(summary.totalMitigationBenefit).toBe('0.0000');
    expect(summary.escalations).toHaveLength(0);
    expect(summary.heatMap.flat().every((c) => c === 0)).toBe(true);
  });
});
