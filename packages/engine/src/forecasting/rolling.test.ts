import { describe, expect, it } from 'vitest';
import {
  assessForecastAccuracy,
  buildRollingForecast,
  multiYearPeriodKeys,
  summariseByFiscalYear,
  type RollingPoint,
} from './rolling.js';
import type { HistoricalPoint } from './types.js';

/** Monthly actuals on the fiscal axis, starting at FY2025-P01. */
function actuals(values: readonly number[], startYear = 2025): HistoricalPoint[] {
  return values.map((value, i) => {
    const year = startYear + Math.floor(i / 12);
    const index = (i % 12) + 1;
    return { periodKey: `FY${year}-P${String(index).padStart(2, '0')}`, value };
  });
}

/** 18 flat-ish months so a forecast has something stable to work from. */
const flat = actuals(Array.from({ length: 18 }, () => 1000));

describe('buildRollingForecast', () => {
  it('splits the series into closed actuals and a forecast forward', () => {
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 6,
      method: 'NAIVE',
    });

    const actualPoints = result.points.filter((p) => p.basis === 'ACTUAL');
    const forecastPoints = result.points.filter((p) => p.basis === 'FORECAST');

    expect(actualPoints).toHaveLength(18);
    expect(forecastPoints).toHaveLength(6);
    expect(actualPoints.at(-1)?.periodKey).toBe('FY2026-P06');
    expect(forecastPoints[0]?.periodKey).toBe('FY2026-P07');
  });

  it('anchors on the last closed period, not the last supplied actual', () => {
    // Actuals run to FY2026-P06, but only P03 is closed.
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P03',
      horizonPeriods: 3,
      method: 'NAIVE',
    });

    expect(result.points.filter((p) => p.basis === 'ACTUAL').at(-1)?.periodKey).toBe('FY2026-P03');
    expect(result.warnings.join(' ')).toMatch(/after the anchor .* have been ignored|not closed/i);
  });

  it('computes full-year outturn as actuals to date plus the forecast remainder', () => {
    // Anchor at P06 of FY2026: six actuals of 1000 = 6000 to date.
    // A naive forecast carries 1000 forward for the remaining six periods.
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 6,
      method: 'NAIVE',
    });

    expect(result.actualToDate).toBe('6000.0000');
    expect(result.forecastRemainder).toBe('6000.0000');
    expect(result.fullYearOutturn).toBe('12000.0000');
  });

  it('counts only the anchor fiscal year in the outturn', () => {
    // A 12-period horizon from P06 reaches six periods into FY2027; those must
    // land in beyondYearEnd, not inflate this year's outturn.
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 12,
      method: 'NAIVE',
    });

    expect(result.forecastRemainder).toBe('6000.0000');
    expect(result.beyondYearEnd).toBe('6000.0000');
    expect(result.fullYearOutturn).toBe('12000.0000');
  });

  it('warns when the horizon stops short of the year end', () => {
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 2,
      method: 'NAIVE',
    });
    expect(result.warnings.join(' ')).toMatch(/stops short of the fiscal year end/);
  });

  it('compares the outturn to an approved baseline', () => {
    // Baseline of 1100 x 12 = 13,200 against a 12,000 outturn: 1,200 under.
    const baseline = Array.from({ length: 12 }, (_, i) => ({
      periodKey: `FY2026-P${String(i + 1).padStart(2, '0')}`,
      amount: '1100',
    }));

    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 6,
      method: 'NAIVE',
      baseline,
    });

    expect(result.baselineTotal).toBe('13200.0000');
    expect(result.varianceToBaseline).toBe('1200.0000');
    expect(result.variancePercent).toBeCloseTo(1200 / 13200, 9);
  });

  it('attaches the per-period baseline and variance to each point', () => {
    const baseline = [{ periodKey: 'FY2026-P01', amount: '1200' }];
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 6,
      method: 'NAIVE',
      baseline,
    });

    const p1 = result.points.find((p) => p.periodKey === 'FY2026-P01');
    expect(p1?.baseline).toBe('1200.0000');
    expect(p1?.variance).toBe('200.0000'); // 1200 planned - 1000 actual
    expect(result.points.find((p) => p.periodKey === 'FY2026-P02')?.baseline).toBeNull();
  });

  it('excludes a baseline outside the anchor fiscal year from the total', () => {
    const baseline = [
      { periodKey: 'FY2026-P01', amount: '1000' },
      { periodKey: 'FY2027-P01', amount: '9999' },
    ];
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 6,
      method: 'NAIVE',
      baseline,
    });
    expect(result.baselineTotal).toBe('1000.0000');
  });

  it('puts a prediction interval on forecast points only', () => {
    const varied = actuals([
      980, 1020, 990, 1030, 1005, 995, 1010, 1000, 1015, 985, 1025, 1000, 1008, 992,
    ]);
    const result = buildRollingForecast({
      actuals: varied,
      anchorPeriodKey: 'FY2026-P02',
      horizonPeriods: 4,
      method: 'SIMPLE_EXPONENTIAL_SMOOTHING',
    });

    for (const point of result.points) {
      if (point.basis === 'ACTUAL') {
        expect(point.lower).toBeNull();
        expect(point.upper).toBeNull();
      } else {
        expect(Number(point.lower)).toBeLessThan(Number(point.value));
        expect(Number(point.upper)).toBeGreaterThan(Number(point.value));
      }
    }
  });

  it('selects a method automatically when asked', () => {
    const result = buildRollingForecast({
      actuals: flat,
      anchorPeriodKey: 'FY2026-P06',
      horizonPeriods: 6,
      method: 'AUTO',
    });
    expect(result.method).toBeTruthy();
    expect(result.points.filter((p) => p.basis === 'FORECAST')).toHaveLength(6);
  });

  it('rejects an invalid anchor, horizon or empty actuals', () => {
    expect(() =>
      buildRollingForecast({ actuals: flat, anchorPeriodKey: 'nope', horizonPeriods: 3 }),
    ).toThrow(/not a valid period key/);

    expect(() =>
      buildRollingForecast({ actuals: flat, anchorPeriodKey: 'FY2026-P06', horizonPeriods: 0 }),
    ).toThrow(/positive whole number/);

    expect(() =>
      buildRollingForecast({ actuals: [], anchorPeriodKey: 'FY2026-P06', horizonPeriods: 3 }),
    ).toThrow(/needs actuals up to the anchor/);
  });

  it('refuses to anchor on a period with no actual', () => {
    expect(() =>
      buildRollingForecast({
        actuals: flat,
        anchorPeriodKey: 'FY2026-P11',
        horizonPeriods: 3,
      }),
    ).toThrow(/No actual was supplied for the anchor period/);
  });
});

describe('assessForecastAccuracy', () => {
  const priorPoints: Array<{ periodKey: string; basis: 'ACTUAL' | 'FORECAST'; value: string }> = [
    { periodKey: 'FY2026-P01', basis: 'ACTUAL', value: '1000' },
    { periodKey: 'FY2026-P02', basis: 'FORECAST', value: '1000' },
    { periodKey: 'FY2026-P03', basis: 'FORECAST', value: '1000' },
  ];

  it('scores forecast points against what actually happened', () => {
    const review = assessForecastAccuracy(priorPoints, [
      { periodKey: 'FY2026-P02', value: 1020 },
      { periodKey: 'FY2026-P03', value: 980 },
    ]);

    expect(review.periodsCompared).toBe(2);
    expect(review.comparisons[0]?.error).toBe('20.0000'); // 1020 actual - 1000 forecast
    expect(review.comparisons[1]?.error).toBe('-20.0000');
  });

  it('ignores actual points, which would flatter the score', () => {
    // P01 was recorded, not forecast, so comparing it would be meaningless.
    const review = assessForecastAccuracy(priorPoints, [
      { periodKey: 'FY2026-P01', value: 1000 },
      { periodKey: 'FY2026-P02', value: 1500 },
    ]);
    expect(review.periodsCompared).toBe(1);
    expect(review.comparisons[0]?.periodKey).toBe('FY2026-P02');
  });

  it('calls a tight forecast accurate', () => {
    const review = assessForecastAccuracy(priorPoints, [
      { periodKey: 'FY2026-P02', value: 1010 },
      { periodKey: 'FY2026-P03', value: 995 },
    ]);
    expect(review.verdict).toBe('ACCURATE');
  });

  it('calls a wide forecast poor', () => {
    const review = assessForecastAccuracy(priorPoints, [
      { periodKey: 'FY2026-P02', value: 1500 },
      { periodKey: 'FY2026-P03', value: 600 },
    ]);
    expect(review.verdict).toBe('POOR');
  });

  it('names the direction when the forecast was consistently optimistic', () => {
    // Actuals above forecast: the forecast was too low.
    const review = assessForecastAccuracy(priorPoints, [
      { periodKey: 'FY2026-P02', value: 1200 },
      { periodKey: 'FY2026-P03', value: 1200 },
    ]);
    expect(review.explanation).toMatch(/optimistic/);
  });

  it('names the direction when the forecast was consistently conservative', () => {
    const review = assessForecastAccuracy(priorPoints, [
      { periodKey: 'FY2026-P02', value: 800 },
      { periodKey: 'FY2026-P03', value: 800 },
    ]);
    expect(review.explanation).toMatch(/conservative/);
  });

  it('reports insufficient data when nothing has closed yet', () => {
    const review = assessForecastAccuracy(priorPoints, []);
    expect(review.verdict).toBe('INSUFFICIENT_DATA');
    expect(review.explanation).toMatch(/expected on the first roll/);
  });

  it('honours custom accuracy bands', () => {
    const actualsIn = [
      { periodKey: 'FY2026-P02', value: 1080 },
      { periodKey: 'FY2026-P03', value: 1080 },
    ];
    expect(assessForecastAccuracy(priorPoints, actualsIn, { accurateWithin: 0.2 }).verdict).toBe(
      'ACCURATE',
    );
    expect(
      assessForecastAccuracy(priorPoints, actualsIn, {
        accurateWithin: 0.01,
        acceptableWithin: 0.02,
      }).verdict,
    ).toBe('POOR');
  });
});

describe('summariseByFiscalYear', () => {
  function point(periodKey: string, basis: 'ACTUAL' | 'FORECAST', value: string): RollingPoint {
    return { periodKey, basis, value, lower: null, upper: null, baseline: null, variance: null };
  }

  it('collapses periods into fiscal years', () => {
    const points = [
      point('FY2026-P01', 'ACTUAL', '100'),
      point('FY2026-P02', 'ACTUAL', '100'),
      point('FY2026-P03', 'FORECAST', '150'),
      point('FY2027-P01', 'FORECAST', '200'),
    ];
    const summary = summariseByFiscalYear(points);

    expect(summary).toHaveLength(2);
    expect(summary[0]?.fiscalYear).toBe(2026);
    expect(summary[0]?.actual).toBe('200.0000');
    expect(summary[0]?.forecast).toBe('150.0000');
    expect(summary[0]?.total).toBe('350.0000');
    expect(summary[1]?.total).toBe('200.0000');
  });

  it('computes year-on-year growth, with none for the first year', () => {
    const points = [
      point('FY2026-P01', 'ACTUAL', '1000'),
      point('FY2027-P01', 'FORECAST', '1100'),
      point('FY2028-P01', 'FORECAST', '1265'),
    ];
    const summary = summariseByFiscalYear(points);

    expect(summary[0]?.growthOnPriorYear).toBeNull();
    expect(summary[1]?.growthOnPriorYear).toBeCloseTo(0.1, 9);
    expect(summary[2]?.growthOnPriorYear).toBeCloseTo(0.15, 9);
  });

  it('rolls a baseline up per year and reports the variance', () => {
    const points = [point('FY2026-P01', 'ACTUAL', '100'), point('FY2026-P02', 'FORECAST', '100')];
    const summary = summariseByFiscalYear(points, [
      { periodKey: 'FY2026-P01', amount: '120' },
      { periodKey: 'FY2026-P02', amount: '120' },
    ]);

    expect(summary[0]?.baseline).toBe('240.0000');
    expect(summary[0]?.variance).toBe('40.0000');
  });

  it('leaves baseline null when none was supplied', () => {
    const summary = summariseByFiscalYear([point('FY2026-P01', 'ACTUAL', '100')]);
    expect(summary[0]?.baseline).toBeNull();
    expect(summary[0]?.variance).toBeNull();
  });

  it('orders years ascending regardless of input order', () => {
    const summary = summariseByFiscalYear([
      point('FY2028-P01', 'FORECAST', '1'),
      point('FY2026-P01', 'ACTUAL', '1'),
      point('FY2027-P01', 'FORECAST', '1'),
    ]);
    expect(summary.map((s) => s.fiscalYear)).toEqual([2026, 2027, 2028]);
  });

  it('handles an empty series', () => {
    expect(summariseByFiscalYear([])).toHaveLength(0);
  });
});

describe('multiYearPeriodKeys', () => {
  it('spans the requested number of fiscal years', () => {
    const keys = multiYearPeriodKeys(2026, 3, 'MONTH');
    expect(keys).toHaveLength(36);
    expect(keys[0]).toBe('FY2026-P01');
    expect(keys[11]).toBe('FY2026-P12');
    expect(keys[12]).toBe('FY2027-P01');
    expect(keys[35]).toBe('FY2028-P12');
  });

  it('works on a quarterly axis', () => {
    const keys = multiYearPeriodKeys(2026, 2, 'QUARTER');
    expect(keys).toHaveLength(8);
    expect(keys[0]).toBe('FY2026-Q1');
    expect(keys[4]).toBe('FY2027-Q1');
  });

  it('rejects a non-positive year count', () => {
    expect(() => multiYearPeriodKeys(2026, 0)).toThrow(/positive whole number/);
    expect(() => multiYearPeriodKeys(2026, 1.5)).toThrow(/positive whole number/);
  });
});
