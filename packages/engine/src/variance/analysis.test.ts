import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  analyseVarianceLine,
  buildVarianceReport,
  ragFor,
  varianceDirection,
  type VarianceInput,
} from './analysis.js';
import { Decimal } from '@ffp/shared';

const line = (over: Partial<VarianceInput> = {}): VarianceInput => ({
  key: 'k1',
  label: 'Test line',
  accountType: 'OPEX',
  budget: '100000.0000',
  actual: '90000.0000',
  ...over,
});

describe('varianceDirection', () => {
  // variance = budget - consumed, so positive means "spent/earned less than plan".
  it('treats underspend on cost as favourable', () => {
    expect(varianceDirection(new Decimal(5000), 'OPEX')).toBe('FAVOURABLE');
    expect(varianceDirection(new Decimal(5000), 'COGS')).toBe('FAVOURABLE');
    expect(varianceDirection(new Decimal(5000), 'CAPEX')).toBe('FAVOURABLE');
  });

  it('treats overspend on cost as unfavourable', () => {
    expect(varianceDirection(new Decimal(-5000), 'OPEX')).toBe('UNFAVOURABLE');
  });

  // The sign flips entirely for revenue: earning less than plan is bad.
  it('treats under-delivery of revenue as unfavourable', () => {
    expect(varianceDirection(new Decimal(5000), 'REVENUE')).toBe('UNFAVOURABLE');
  });

  it('treats over-delivery of revenue as favourable', () => {
    expect(varianceDirection(new Decimal(-5000), 'REVENUE')).toBe('FAVOURABLE');
  });

  it('is neutral at exactly zero', () => {
    expect(varianceDirection(new Decimal(0), 'OPEX')).toBe('NEUTRAL');
    expect(varianceDirection(new Decimal(0), 'REVENUE')).toBe('NEUTRAL');
  });
});

describe('ragFor', () => {
  const thresholds = { amber: 0.05, red: 0.1 };

  it('never flags a favourable variance, however large', () => {
    expect(ragFor(0.9, 'FAVOURABLE', thresholds)).toBe('GREEN');
    expect(ragFor(-0.9, 'FAVOURABLE', thresholds)).toBe('GREEN');
  });

  it('is green for a neutral variance', () => {
    expect(ragFor(0, 'NEUTRAL', thresholds)).toBe('GREEN');
  });

  it('bands unfavourable variances on absolute magnitude', () => {
    expect(ragFor(-0.04, 'UNFAVOURABLE', thresholds)).toBe('GREEN');
    expect(ragFor(-0.05, 'UNFAVOURABLE', thresholds)).toBe('AMBER');
    expect(ragFor(-0.09, 'UNFAVOURABLE', thresholds)).toBe('AMBER');
    expect(ragFor(-0.1, 'UNFAVOURABLE', thresholds)).toBe('RED');
    expect(ragFor(-0.5, 'UNFAVOURABLE', thresholds)).toBe('RED');
  });

  it('is green when the percentage is undefined', () => {
    expect(ragFor(null, 'UNFAVOURABLE', thresholds)).toBe('GREEN');
  });
});

describe('analyseVarianceLine', () => {
  it('counts commitments as consumed', () => {
    // 60,000 spent + 30,000 committed = 90,000 consumed against a 100,000 budget.
    const result = analyseVarianceLine(
      line({ budget: '100000', actual: '60000', commitment: '30000' }),
    );
    expect(result.consumed).toBe('90000.0000');
    expect(result.variance).toBe('10000.0000');
    expect(result.remaining).toBe('10000.0000');
    expect(result.utilisation).toBeCloseTo(0.9, 10);
  });

  it('excludes commitments when asked to', () => {
    const result = analyseVarianceLine(
      line({ budget: '100000', actual: '60000', commitment: '30000' }),
      DEFAULT_THRESHOLDS,
      { includeCommitments: false },
    );
    expect(result.consumed).toBe('60000.0000');
    expect(result.remaining).toBe('40000.0000');
  });

  it('computes variance percentage against the absolute budget', () => {
    // (100000 - 112000) / 100000 = -0.12
    const result = analyseVarianceLine(line({ budget: '100000', actual: '112000' }));
    expect(result.variancePercent).toBeCloseTo(-0.12, 10);
    expect(result.direction).toBe('UNFAVOURABLE');
  });

  it('returns null percentage and utilisation on a zero budget', () => {
    const result = analyseVarianceLine(line({ budget: '0', actual: '500' }));
    expect(result.variancePercent).toBeNull();
    expect(result.utilisation).toBeNull();
    // Still directionally meaningful: money spent against no budget is unfavourable.
    expect(result.direction).toBe('UNFAVOURABLE');
  });

  it('suppresses the flag below the materiality floor', () => {
    // 40 budget overspent by 30 is 75% - alarming as a ratio, trivial as money.
    const result = analyseVarianceLine(line({ budget: '40', actual: '70' }), {
      amber: 0.05,
      red: 0.1,
      materialityFloor: '1000',
    });
    expect(result.direction).toBe('UNFAVOURABLE');
    expect(result.variancePercent).toBeCloseTo(-0.75, 10);
    expect(result.rag).toBe('GREEN');
  });

  it('flags the same ratio once it is material', () => {
    const result = analyseVarianceLine(line({ budget: '40000', actual: '70000' }), {
      amber: 0.05,
      red: 0.1,
      materialityFloor: '1000',
    });
    expect(result.rag).toBe('RED');
  });

  it('reports forecast variance when a forecast is supplied', () => {
    const result = analyseVarianceLine(
      line({ budget: '100000', actual: '50000', forecast: '108000' }),
    );
    // budget - forecast = -8000, i.e. an expected overspend.
    expect(result.forecastVariance).toBe('-8000.0000');
    expect(result.forecastVariancePercent).toBeCloseTo(-0.08, 10);
  });

  it('leaves forecast fields null when no forecast exists', () => {
    const result = analyseVarianceLine(line());
    expect(result.forecastVariance).toBeNull();
    expect(result.forecastVariancePercent).toBeNull();
  });
});

describe('buildVarianceReport', () => {
  const inputs: VarianceInput[] = [
    {
      key: 'a',
      label: 'Salaries',
      accountType: 'OPEX',
      accountId: 'acc-1',
      businessUnitId: 'bu-1',
      costCategory: 'DIRECT_LABOUR',
      periodKey: 'FY2026-P01',
      budget: '100000',
      actual: '95000',
    },
    {
      key: 'b',
      label: 'Site power',
      accountType: 'OPEX',
      accountId: 'acc-2',
      businessUnitId: 'bu-1',
      costCategory: 'FACILITIES',
      periodKey: 'FY2026-P01',
      budget: '50000',
      actual: '62000',
    },
    {
      key: 'c',
      label: 'Salaries',
      accountType: 'OPEX',
      accountId: 'acc-1',
      businessUnitId: 'bu-2',
      costCategory: 'DIRECT_LABOUR',
      periodKey: 'FY2026-P02',
      budget: '80000',
      actual: '78000',
    },
  ];

  it('totals foot exactly to the sum of the lines', () => {
    const report = buildVarianceReport(inputs);
    // 100000 + 50000 + 80000 = 230000 ; 95000 + 62000 + 78000 = 235000
    expect(report.totals.budget).toBe('230000.0000');
    expect(report.totals.actual).toBe('235000.0000');
    expect(report.totals.variance).toBe('-5000.0000');
  });

  it('groups by account', () => {
    const report = buildVarianceReport(inputs, { groupBy: 'ACCOUNT' });
    expect(report.groups).toHaveLength(2);
    const salaries = report.groups.find((g) => g.key === 'acc-1');
    // Both salary lines: 100000 + 80000 budget, 95000 + 78000 actual.
    expect(salaries?.budget).toBe('180000.0000');
    expect(salaries?.actual).toBe('173000.0000');
    expect(salaries?.lineCount).toBe(2);
  });

  it('groups by business unit', () => {
    const report = buildVarianceReport(inputs, { groupBy: 'BUSINESS_UNIT' });
    expect(report.groups).toHaveLength(2);
    expect(report.groups.find((g) => g.key === 'bu-1')?.budget).toBe('150000.0000');
  });

  it('groups by cost category and by period', () => {
    expect(buildVarianceReport(inputs, { groupBy: 'COST_CATEGORY' }).groups).toHaveLength(2);
    expect(buildVarianceReport(inputs, { groupBy: 'PERIOD' }).groups).toHaveLength(2);
  });

  it('collapses to a single group when grouping is NONE', () => {
    const report = buildVarianceReport(inputs, { groupBy: 'NONE' });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.budget).toBe('230000.0000');
  });

  it('lists only non-green unfavourable lines as exceptions, worst first', () => {
    const report = buildVarianceReport(inputs);
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]?.label).toBe('Site power');
    expect(report.exceptions[0]?.direction).toBe('UNFAVOURABLE');
  });

  it('sorts exceptions by variance ascending, so the worst overspend leads', () => {
    const report = buildVarianceReport([
      ...inputs,
      {
        key: 'd',
        label: 'Marketing',
        accountType: 'OPEX',
        accountId: 'acc-3',
        budget: '30000',
        actual: '60000',
      },
    ]);
    expect(report.exceptions[0]?.label).toBe('Marketing');
    expect(Number(report.exceptions[0]?.variance)).toBeLessThan(
      Number(report.exceptions[1]?.variance),
    );
  });

  it('takes group direction from the dominant account type by budget', () => {
    // Revenue dominates by absolute budget, so under-delivery reads unfavourable
    // even though the smaller OPEX line is underspent.
    const mixed: VarianceInput[] = [
      { key: 'r', label: 'Revenue', accountType: 'REVENUE', budget: '1000000', actual: '900000' },
      { key: 'o', label: 'Opex', accountType: 'OPEX', budget: '10000', actual: '9000' },
    ];
    const report = buildVarianceReport(mixed, { groupBy: 'NONE' });
    // budget 1,010,000 - consumed 909,000 = +101,000, i.e. under plan overall.
    expect(report.groups[0]?.variance).toBe('101000.0000');
    expect(report.groups[0]?.direction).toBe('UNFAVOURABLE');
  });

  it('handles an empty input set without dividing by zero', () => {
    const report = buildVarianceReport([]);
    expect(report.lines).toHaveLength(0);
    expect(report.totals.budget).toBe('0.0000');
    expect(report.totals.variancePercent).toBeNull();
    expect(report.exceptions).toHaveLength(0);
  });

  it('carries the thresholds it applied back in the result', () => {
    const report = buildVarianceReport(inputs, {
      thresholds: { amber: 0.02, red: 0.04, materialityFloor: '0' },
    });
    expect(report.thresholds.amber).toBe(0.02);
    expect(report.thresholds.red).toBe(0.04);
  });
});
