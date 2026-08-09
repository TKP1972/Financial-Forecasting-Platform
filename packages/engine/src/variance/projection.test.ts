import { describe, expect, it } from 'vitest';
import {
  decomposeMix,
  decomposePriceVolume,
  projectOutturn,
  projectPortfolio,
  type ProjectionInput,
} from './projection.js';

const base = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  key: 'k',
  label: 'Line',
  accountType: 'OPEX',
  budget: '120000',
  actualToDate: '35000',
  periodsElapsed: 6,
  periodsInYear: 12,
  ...over,
});

describe('projectOutturn - RUN_RATE', () => {
  it('extends the observed pace across the remaining periods', () => {
    // 35,000 over 6 periods = 5,833.333... per period; 6 remaining => 35,000.
    // Outturn 70,000 against a 120,000 budget => +50,000 underspend.
    const result = projectOutturn(base(), 'RUN_RATE');
    expect(result.projectedRemaining).toBe('35000.0000');
    expect(result.projectedOutturn).toBe('70000.0000');
    expect(result.projectedVariance).toBe('50000.0000');
    expect(result.direction).toBe('FAVOURABLE');
    expect(result.periodsRemaining).toBe(6);
  });

  it('includes commitments in the observed pace', () => {
    // (30,000 + 6,000) / 6 = 6,000 per period; 6 remaining => 36,000.
    const result = projectOutturn(
      base({ actualToDate: '30000', commitmentToDate: '6000' }),
      'RUN_RATE',
    );
    expect(result.projectedRemaining).toBe('36000.0000');
    expect(result.projectedOutturn).toBe('72000.0000');
  });

  it('warns when the run rate rests on too little history', () => {
    const result = projectOutturn(base({ periodsElapsed: 2 }), 'RUN_RATE');
    expect(result.warnings.join(' ')).toMatch(/unstable/i);
  });

  it('does not warn once enough periods have elapsed', () => {
    expect(projectOutturn(base({ periodsElapsed: 3 }), 'RUN_RATE').warnings).toHaveLength(0);
  });

  it('reports zero remaining periods at year end', () => {
    const result = projectOutturn(base({ periodsElapsed: 12 }), 'RUN_RATE');
    expect(result.periodsRemaining).toBe(0);
    expect(result.projectedRemaining).toBe('0.0000');
    expect(result.projectedOutturn).toBe('35000.0000');
  });
});

describe('projectOutturn - BUDGET_REMAINING', () => {
  it('assumes the rest of the budget is spent as planned', () => {
    // Straight-line: 6/12 of 120,000 = 60,000 to date; 60,000 remains.
    // Outturn = 35,000 actual + 60,000 remaining budget = 95,000.
    const result = projectOutturn(base(), 'BUDGET_REMAINING');
    expect(result.budgetToDate).toBe('60000.0000');
    expect(result.projectedRemaining).toBe('60000.0000');
    expect(result.projectedOutturn).toBe('95000.0000');
  });

  it('respects an uneven phasing rather than assuming straight-line', () => {
    // Front-loaded: 20,000 x 3 then 10,000 x 9 = 150,000 total.
    // Through 3 periods, 60,000 should have been consumed - not 150,000 x 3/12 = 37,500.
    const phasing = [
      '20000',
      '20000',
      '20000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
    ];
    const result = projectOutturn(
      base({ budget: '150000', actualToDate: '55000', periodsElapsed: 3, budgetPhasing: phasing }),
      'BUDGET_REMAINING',
    );
    expect(result.budgetToDate).toBe('60000.0000');
    // Variance to date: 60,000 phased - 55,000 consumed = +5,000 under.
    expect(result.varianceToDate).toBe('5000.0000');
    // Remaining budget = 150,000 - 60,000 = 90,000.
    expect(result.projectedRemaining).toBe('90000.0000');
    expect(result.projectedOutturn).toBe('145000.0000');
  });

  it('differs from the straight-line assumption on the same data', () => {
    const phasing = [
      '20000',
      '20000',
      '20000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
      '10000',
    ];
    const phased = projectOutturn(
      base({ budget: '150000', actualToDate: '55000', periodsElapsed: 3, budgetPhasing: phasing }),
      'BUDGET_REMAINING',
    );
    const straight = projectOutturn(
      base({ budget: '150000', actualToDate: '55000', periodsElapsed: 3 }),
      'BUDGET_REMAINING',
    );
    // 150,000 x 3/12 = 37,500 straight-line vs 60,000 phased.
    expect(straight.budgetToDate).toBe('37500.0000');
    expect(phased.budgetToDate).not.toBe(straight.budgetToDate);
  });
});

describe('projectOutturn - REFORECAST', () => {
  it('uses the submitted reforecast', () => {
    const result = projectOutturn(base({ reforecastRemaining: '48000' }), 'REFORECAST');
    expect(result.projectedRemaining).toBe('48000.0000');
    expect(result.projectedOutturn).toBe('83000.0000');
  });

  it('refuses to guess when no reforecast was supplied', () => {
    expect(() => projectOutturn(base(), 'REFORECAST')).toThrow(/no reforecast/i);
  });
});

describe('projectOutturn - validation', () => {
  it('rejects a non-positive or non-integer elapsed count', () => {
    expect(() => projectOutturn(base({ periodsElapsed: 0 }))).toThrow(/positive integer/i);
    expect(() => projectOutturn(base({ periodsElapsed: 2.5 }))).toThrow(/positive integer/i);
  });

  it('rejects more elapsed periods than exist in the year', () => {
    expect(() => projectOutturn(base({ periodsElapsed: 13, periodsInYear: 12 }))).toThrow();
  });

  it('flips direction for revenue', () => {
    // Revenue tracking below plan projects an unfavourable outturn.
    const result = projectOutturn(base({ accountType: 'REVENUE' }), 'RUN_RATE');
    expect(result.projectedVariance).toBe('50000.0000');
    expect(result.direction).toBe('UNFAVOURABLE');
  });

  it('returns a null percentage on a zero budget', () => {
    expect(projectOutturn(base({ budget: '0' })).projectedVariancePercent).toBeNull();
  });
});

describe('projectPortfolio', () => {
  it('totals the projected lines', () => {
    const result = projectPortfolio(
      [
        base({ key: 'a', budget: '120000', actualToDate: '35000' }),
        base({ key: 'b', budget: '60000', actualToDate: '40000' }),
      ],
      'RUN_RATE',
    );
    // a: 70,000 outturn. b: 40,000/6 x 6 = 40,000 remaining => 80,000 outturn.
    expect(result.totals.budget).toBe('180000.0000');
    expect(result.totals.projectedOutturn).toBe('150000.0000');
    expect(result.totals.projectedVariance).toBe('30000.0000');
    expect(result.totals.projectedVariancePercent).toBeCloseTo(30000 / 180000, 10);
  });

  it('handles an empty portfolio', () => {
    const result = projectPortfolio([], 'RUN_RATE');
    expect(result.lines).toHaveLength(0);
    expect(result.totals.projectedVariancePercent).toBeNull();
  });
});

describe('decomposePriceVolume', () => {
  it('splits a variance into volume, price and joint components that sum exactly', () => {
    // Budget 100 units @ 10 = 1,000. Actual 120 units @ 11 = 1,320. Total +320.
    //   volume = (120 - 100) x 10       = 200
    //   price  = (11 - 10)  x 100       = 100
    //   joint  = (120-100) x (11-10)    =  20
    const result = decomposePriceVolume({
      label: 'Field hours',
      budgetVolume: '100',
      budgetPrice: '10',
      actualVolume: '120',
      actualPrice: '11',
    });

    expect(result.budgetAmount).toBe('1000.0000');
    expect(result.actualAmount).toBe('1320.0000');
    expect(result.totalVariance).toBe('320.0000');
    expect(result.volumeVariance).toBe('200.0000');
    expect(result.priceVariance).toBe('100.0000');
    expect(result.jointVariance).toBe('20.0000');

    const parts =
      Number(result.volumeVariance) + Number(result.priceVariance) + Number(result.jointVariance);
    expect(parts).toBeCloseTo(Number(result.totalVariance), 8);
  });

  it('keeps the identity when both effects move in opposite directions', () => {
    // 200 @ 50 = 10,000 budget; 180 @ 55 = 9,900 actual. Total -100.
    //   volume = -20 x 50 = -1,000 ; price = 5 x 200 = 1,000 ; joint = -20 x 5 = -100
    const result = decomposePriceVolume({
      label: 'Circuits',
      budgetVolume: '200',
      budgetPrice: '50',
      actualVolume: '180',
      actualPrice: '55',
    });
    expect(result.totalVariance).toBe('-100.0000');
    expect(result.volumeVariance).toBe('-1000.0000');
    expect(result.priceVariance).toBe('1000.0000');
    expect(result.jointVariance).toBe('-100.0000');
  });

  it('reports a pure price variance when volume is unchanged', () => {
    const result = decomposePriceVolume({
      label: 'Licences',
      budgetVolume: '100',
      budgetPrice: '10',
      actualVolume: '100',
      actualPrice: '12',
    });
    expect(result.volumeVariance).toBe('0.0000');
    expect(result.jointVariance).toBe('0.0000');
    expect(result.priceVariance).toBe('200.0000');
  });
});

describe('decomposeMix', () => {
  it('is undefined when total budget volume is zero', () => {
    expect(() =>
      decomposeMix([
        { label: 'a', budgetVolume: '0', budgetPrice: '10', actualVolume: '5', actualPrice: '10' },
      ]),
    ).toThrow(/zero/i);
  });

  it('returns zeros for an empty portfolio', () => {
    const result = decomposeMix([]);
    expect(result.lines).toHaveLength(0);
    expect(result.totalMixVariance).toBe('0.0000');
  });

  it('reports no mix variance when the shape is unchanged', () => {
    // Both lines grow by exactly 20%, so the mix is identical - all the movement
    // is quantity, none of it mix.
    const result = decomposeMix([
      {
        label: 'cheap',
        budgetVolume: '100',
        budgetPrice: '10',
        actualVolume: '120',
        actualPrice: '10',
      },
      {
        label: 'dear',
        budgetVolume: '100',
        budgetPrice: '30',
        actualVolume: '120',
        actualPrice: '30',
      },
    ]);
    expect(Number(result.totalMixVariance)).toBeCloseTo(0, 6);
    // Total volume rose 200 -> 240 at the blended rate of 20: +40 x 20 = 800.
    expect(Number(result.totalQuantityVariance)).toBeCloseTo(800, 6);
  });

  it('isolates a shift toward the more expensive line as mix', () => {
    // Total volume constant at 200, but shifted 20 units from cheap to dear.
    const result = decomposeMix([
      {
        label: 'cheap',
        budgetVolume: '100',
        budgetPrice: '10',
        actualVolume: '80',
        actualPrice: '10',
      },
      {
        label: 'dear',
        budgetVolume: '100',
        budgetPrice: '30',
        actualVolume: '120',
        actualPrice: '30',
      },
    ]);
    // Quantity effect is nil because the total did not change.
    expect(Number(result.totalQuantityVariance)).toBeCloseTo(0, 6);
    // Mix: cheap -20 x 10 = -200 ; dear +20 x 30 = +600 ; net +400.
    expect(result.lines[0]?.mixVariance).toBe('-200.0000');
    expect(result.lines[1]?.mixVariance).toBe('600.0000');
    expect(Number(result.totalMixVariance)).toBeCloseTo(400, 6);
  });
});
