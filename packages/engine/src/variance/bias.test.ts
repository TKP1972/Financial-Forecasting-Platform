import { describe, expect, it } from 'vitest';
import { assessPlanningBias, type BiasObservation } from './bias.js';

/** Six cycles where the holder always budgets ~10% above what they use. */
function padder(subjectId = 'u1', name = 'Ada'): BiasObservation[] {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    subjectId,
    subjectName: name,
    periodLabel: `FY202${i}`,
    budget: '110000',
    actual: '100000',
  }));
}

describe('assessPlanningBias', () => {
  it('detects systematic overstatement', () => {
    // (110,000 - 100,000) / 110,000 = 0.090909 every period, always the same way.
    const report = assessPlanningBias(padder());
    const subject = report.subjects[0];

    expect(subject?.verdict).toBe('SYSTEMATIC_OVERSTATEMENT');
    expect(subject?.meanPercentageError).toBeCloseTo(10000 / 110000, 10);
    expect(subject?.directionalConsistency).toBe(1);
    expect(subject?.observationCount).toBe(6);
  });

  it('sums the money tied up by the padding', () => {
    // 10,000 over-budgeted in each of six periods.
    expect(assessPlanningBias(padder()).subjects[0]?.cumulativeImpact).toBe('60000.0000');
  });

  it('detects systematic understatement', () => {
    const optimist: BiasObservation[] = [1, 2, 3, 4].map((i) => ({
      subjectId: 'u2',
      subjectName: 'Ben',
      periodLabel: `P${i}`,
      budget: '90000',
      actual: '100000',
    }));
    const subject = assessPlanningBias(optimist).subjects[0];

    expect(subject?.verdict).toBe('SYSTEMATIC_UNDERSTATEMENT');
    expect(subject?.meanPercentageError as number).toBeLessThan(0);
    expect(subject?.explanation).toMatch(/treated as a floor/);
  });

  it('calls large but directionless error inconsistent, not bias', () => {
    // Alternating +25% and -25%: bad estimation, no bias.
    const erratic: BiasObservation[] = [
      { subjectId: 'u3', subjectName: 'Cy', periodLabel: 'P1', budget: '100000', actual: '75000' },
      { subjectId: 'u3', subjectName: 'Cy', periodLabel: 'P2', budget: '100000', actual: '125000' },
      { subjectId: 'u3', subjectName: 'Cy', periodLabel: 'P3', budget: '100000', actual: '75000' },
      { subjectId: 'u3', subjectName: 'Cy', periodLabel: 'P4', budget: '100000', actual: '125000' },
    ];
    const subject = assessPlanningBias(erratic).subjects[0];

    expect(subject?.verdict).toBe('INCONSISTENT');
    expect(subject?.meanPercentageError).toBeCloseTo(0, 10);
    expect(subject?.meanAbsolutePercentageError).toBeCloseTo(0.25, 10);
    expect(subject?.explanation).toMatch(/estimation accuracy problem, not bias/);
  });

  it('calls a small accurate error well calibrated', () => {
    const good: BiasObservation[] = [1, 2, 3, 4].map((i) => ({
      subjectId: 'u4',
      subjectName: 'Dee',
      periodLabel: `P${i}`,
      budget: '100000',
      actual: i % 2 === 0 ? '101000' : '99000',
    }));
    expect(assessPlanningBias(good).subjects[0]?.verdict).toBe('WELL_CALIBRATED');
  });

  it('withholds a verdict below the minimum observation count', () => {
    const subject = assessPlanningBias(padder().slice(0, 2)).subjects[0];
    expect(subject?.verdict).toBe('INSUFFICIENT_DATA');
    expect(subject?.explanation).toMatch(/at least 3 are needed/);
  });

  it('honours a custom minimum', () => {
    const subject = assessPlanningBias(padder().slice(0, 2), { minimumObservations: 2 })
      .subjects[0];
    expect(subject?.verdict).toBe('SYSTEMATIC_OVERSTATEMENT');
  });

  it('inverts the sign for revenue, so positive always means the plan flattered the unit', () => {
    // Budgeting revenue ABOVE actual is optimism (understatement of difficulty),
    // not padding - the opposite of the same numbers on a cost line.
    const revenue: BiasObservation[] = [1, 2, 3, 4].map((i) => ({
      subjectId: 'r1',
      subjectName: 'Revenue owner',
      periodLabel: `P${i}`,
      budget: '110000',
      actual: '100000',
      isRevenue: true,
    }));
    const subject = assessPlanningBias(revenue).subjects[0];

    expect(subject?.meanPercentageError as number).toBeLessThan(0);
    expect(subject?.verdict).toBe('SYSTEMATIC_UNDERSTATEMENT');
  });

  it('gives the same cost numbers the opposite reading', () => {
    const asCost = assessPlanningBias(padder()).subjects[0];
    const asRevenue = assessPlanningBias(padder().map((o) => ({ ...o, isRevenue: true })))
      .subjects[0];

    expect(asCost?.verdict).toBe('SYSTEMATIC_OVERSTATEMENT');
    expect(asRevenue?.verdict).toBe('SYSTEMATIC_UNDERSTATEMENT');
  });

  it('separates subjects and ranks them by cumulative impact', () => {
    const big = padder('big', 'Big').map((o) => ({ ...o, budget: '1100000', actual: '1000000' }));
    const report = assessPlanningBias([...padder('small', 'Small'), ...big]);

    expect(report.subjects).toHaveLength(2);
    expect(report.subjects[0]?.subjectId).toBe('big');
  });

  it('skips periods with a zero budget rather than dividing by zero', () => {
    const withZero: BiasObservation[] = [
      ...padder(),
      { subjectId: 'u1', subjectName: 'Ada', periodLabel: 'P7', budget: '0', actual: '5000' },
    ];
    const subject = assessPlanningBias(withZero).subjects[0];
    expect(subject?.observationCount).toBe(6);
  });

  it('reports insufficient data when no period had a budget', () => {
    const subject = assessPlanningBias([
      { subjectId: 'z', subjectName: 'Zed', periodLabel: 'P1', budget: '0', actual: '100' },
    ]).subjects[0];
    expect(subject?.verdict).toBe('INSUFFICIENT_DATA');
    expect(subject?.explanation).toMatch(/non-zero budget/);
  });

  it('flags only subjects with a systematic direction', () => {
    const erratic: BiasObservation[] = [1, 2, 3, 4].map((i) => ({
      subjectId: 'e',
      subjectName: 'Erratic',
      periodLabel: `P${i}`,
      budget: '100000',
      actual: i % 2 === 0 ? '75000' : '125000',
    }));
    const report = assessPlanningBias([...padder(), ...erratic]);

    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0]?.subjectId).toBe('u1');
  });

  it('summarises the portfolio position', () => {
    const report = assessPlanningBias(padder());
    expect(report.portfolioMeanPercentageError).toBeCloseTo(10000 / 110000, 10);
    expect(report.observations.join(' ')).toMatch(/carrying padding/);
  });

  it('says so plainly when nobody is biased', () => {
    const good: BiasObservation[] = [1, 2, 3, 4].map((i) => ({
      subjectId: 'g',
      subjectName: 'Good',
      periodLabel: `P${i}`,
      budget: '100000',
      actual: i % 2 === 0 ? '100500' : '99500',
    }));
    expect(assessPlanningBias(good).observations.join(' ')).toMatch(
      /No budget holder shows a systematic directional bias/,
    );
  });

  it('handles an empty input', () => {
    const report = assessPlanningBias([]);
    expect(report.subjects).toHaveLength(0);
    expect(report.portfolioMeanPercentageError).toBeNull();
    expect(report.totalCumulativeImpact).toBe('0.0000');
  });

  it('rejects a nonsensical minimum', () => {
    expect(() => assessPlanningBias(padder(), { minimumObservations: 0 })).toThrow(/at least 1/);
  });

  it('respects a custom materiality threshold', () => {
    // A consistent 9.09% bias is material at 5% but not at 15%.
    expect(assessPlanningBias(padder(), { materialityThreshold: 0.15 }).flagged).toHaveLength(0);
    expect(assessPlanningBias(padder(), { materialityThreshold: 0.05 }).flagged).toHaveLength(1);
  });
});
