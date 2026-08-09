import { describe, it, expect } from 'vitest';
import { Decimal, BURDEN_POOLS } from '@ffp/shared';
import {
  applyBurdens,
  effectiveWrapRate,
  rateForYear,
  sumDecimals,
  validateBurdens,
  STANDARD_BURDEN_BASES,
  type BurdenDefinition,
  type DirectCostBasis,
} from './burdens.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

/**
 * The worked example used throughout this file. Every expected figure below is
 * derived by hand from these four direct-cost buckets.
 *
 *   directLabour = 1000, otherDirect = 200, material = 500, subcontract = 300
 */
const workedBasis = (): DirectCostBasis => ({
  directLabour: new Decimal(1000),
  otherDirect: new Decimal(200),
  material: new Decimal(500),
  subcontract: new Decimal(300),
  passThrough: new Decimal(9999), // deliberately large: must never enter any base
});

const workedBurdens = (): BurdenDefinition[] => [
  { pool: 'FRINGE', ratesByYear: ['0.30'] },
  { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
  { pool: 'MATERIAL_HANDLING', ratesByYear: ['0.05'] },
  { pool: 'GA', ratesByYear: ['0.10'] },
];

// --------------------------------------------------------------------------
// validateBurdens
// --------------------------------------------------------------------------

describe('validateBurdens', () => {
  it('accepts a well-formed, correctly ordered configuration', () => {
    expect(() => validateBurdens(workedBurdens())).not.toThrow();
  });

  it('accepts an empty configuration (no indirect pools is a valid, if unwise, model)', () => {
    expect(() => validateBurdens([])).not.toThrow();
  });

  it('throws when a pool is defined more than once', () => {
    const burdens: BurdenDefinition[] = [
      { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
      { pool: 'FRINGE', ratesByYear: ['0.30'] },
      { pool: 'OVERHEAD', ratesByYear: ['0.25'] },
    ];
    expect(() => validateBurdens(burdens)).toThrow(/OVERHEAD is defined more than once/);
  });

  it('throws when a pool draws on a pool that comes LATER in the application order', () => {
    // BURDEN_POOLS order is FRINGE -> OVERHEAD -> MATERIAL_HANDLING -> GA -> COM.
    // FRINGE is applied first, so OVERHEAD is not yet resolved when FRINGE runs.
    const burdens: BurdenDefinition[] = [
      { pool: 'FRINGE', ratesByYear: ['0.30'], base: ['OVERHEAD'] },
      { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
    ];
    expect(() => validateBurdens(burdens)).toThrow(
      /FRINGE draws on OVERHEAD, which is applied at the same time or later/,
    );
  });

  it('pins the documented pool order used by the ordering rule', () => {
    expect([...BURDEN_POOLS]).toEqual(['FRINGE', 'OVERHEAD', 'MATERIAL_HANDLING', 'GA', 'COM']);
  });

  it('throws when a pool draws on GA from OVERHEAD (GA is applied after OVERHEAD)', () => {
    const burdens: BurdenDefinition[] = [
      { pool: 'OVERHEAD', ratesByYear: ['0.20'], base: ['DIRECT_LABOUR', 'GA'] },
      { pool: 'GA', ratesByYear: ['0.10'] },
    ];
    expect(() => validateBurdens(burdens)).toThrow(/OVERHEAD draws on GA/);
  });

  it('throws when a pool draws on itself', () => {
    const burdens: BurdenDefinition[] = [
      { pool: 'GA', ratesByYear: ['0.10'], base: ['DIRECT_LABOUR', 'GA'] },
    ];
    expect(() => validateBurdens(burdens)).toThrow(/GA draws on GA/);
  });

  it('allows a later pool to draw on an earlier pool', () => {
    const burdens: BurdenDefinition[] = [
      { pool: 'COM', ratesByYear: ['0.01'], base: ['DIRECT_LABOUR', 'FRINGE', 'OVERHEAD', 'GA'] },
      { pool: 'FRINGE', ratesByYear: ['0.30'] },
      { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
      { pool: 'GA', ratesByYear: ['0.10'] },
    ];
    expect(() => validateBurdens(burdens)).not.toThrow();
  });

  it('throws when a pool has an empty rate schedule', () => {
    const burdens: BurdenDefinition[] = [{ pool: 'FRINGE', ratesByYear: [] }];
    expect(() => validateBurdens(burdens)).toThrow(/FRINGE has no rates/);
  });

  it('throws when any rate in the schedule is negative', () => {
    const burdens: BurdenDefinition[] = [
      { pool: 'FRINGE', ratesByYear: ['0.30', '0.31', '-0.01'] },
    ];
    expect(() => validateBurdens(burdens)).toThrow(/FRINGE has a negative rate/);
  });

  it('accepts a zero rate (a suspended pool is not the same as a negative one)', () => {
    expect(() => validateBurdens([{ pool: 'FRINGE', ratesByYear: ['0'] }])).not.toThrow();
  });

  it('carries the CALCULATION_ERROR code and details', () => {
    try {
      validateBurdens([{ pool: 'FRINGE', ratesByYear: [] }]);
      throw new Error('expected validateBurdens to throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('CALCULATION_ERROR');
      expect((error as { details: unknown }).details).toEqual({ pool: 'FRINGE' });
    }
  });
});

// --------------------------------------------------------------------------
// rateForYear
// --------------------------------------------------------------------------

describe('rateForYear', () => {
  it('applies a single-entry rate to every year', () => {
    const rates = ['0.325'];
    // One entry => 0.325 for year 0, year 1, ... year 19.
    expect(rateForYear(rates, 0).toString()).toBe('0.325');
    expect(rateForYear(rates, 1).toString()).toBe('0.325');
    expect(rateForYear(rates, 7).toString()).toBe('0.325');
    expect(rateForYear(rates, 19).toString()).toBe('0.325');
  });

  it('indexes a multi-entry schedule by year', () => {
    const rates = ['0.30', '0.32', '0.34'];
    expect(rateForYear(rates, 0).toString()).toBe('0.3');
    expect(rateForYear(rates, 1).toString()).toBe('0.32');
    expect(rateForYear(rates, 2).toString()).toBe('0.34');
  });

  it('HOLDS THE LAST RATE FLAT beyond the supplied schedule - it must not fall to zero', () => {
    const rates = ['0.30', '0.32', '0.34'];
    // Years 3, 4, 5 are past the end of a 3-entry schedule: hold 0.34, never 0.
    expect(rateForYear(rates, 3).toString()).toBe('0.34');
    expect(rateForYear(rates, 4).toString()).toBe('0.34');
    expect(rateForYear(rates, 25).toString()).toBe('0.34');
    expect(rateForYear(rates, 3).isZero()).toBe(false);
  });

  it('returns zero for an empty schedule', () => {
    expect(rateForYear([], 0).toString()).toBe('0');
  });

  it('accepts numeric and Decimal rate inputs', () => {
    expect(rateForYear([0.15, 0.16], 1).toString()).toBe('0.16');
    expect(rateForYear([new Decimal('0.075')], 3).toString()).toBe('0.075');
  });
});

// --------------------------------------------------------------------------
// applyBurdens - the cascading worked example
// --------------------------------------------------------------------------

describe('applyBurdens', () => {
  /*
   * HAND-COMPUTED WORKED EXAMPLE
   * ----------------------------
   * directLabour = 1000, otherDirect = 200, material = 500, subcontract = 300
   *
   * FRINGE            0.30 on [DIRECT_LABOUR]
   *                   base = 1000                            -> 0.30 * 1000 =  300
   * OVERHEAD          0.20 on [DIRECT_LABOUR, FRINGE]
   *                   base = 1000 + 300 = 1300               -> 0.20 * 1300 =  260
   * MATERIAL_HANDLING 0.05 on [MATERIAL, SUBCONTRACT]
   *                   base = 500 + 300 = 800                 -> 0.05 *  800 =   40
   * GA                0.10 on [DIRECT_LABOUR, FRINGE, OVERHEAD,
   *                            DIRECT_NON_LABOUR, MATERIAL_HANDLING]
   *                   base = 1000 + 300 + 260 + 200 + 40 = 1800
   *                                                          -> 0.10 * 1800 =  180
   *
   * totalBurden = 300 + 260 + 40 + 180 = 780
   */

  it('cascades each pool onto the base produced by the pools before it', () => {
    const result = applyBurdens(workedBasis(), workedBurdens(), 0);

    expect(result.applied).toHaveLength(4);

    expect(result.applied[0]).toEqual({
      pool: 'FRINGE',
      rate: '0.3',
      base: '1000.0000',
      amount: '300.0000',
      baseElements: ['DIRECT_LABOUR'],
    });
    expect(result.applied[1]).toEqual({
      pool: 'OVERHEAD',
      rate: '0.2',
      base: '1300.0000', // 1000 + 300
      amount: '260.0000', // 0.20 * 1300
      baseElements: ['DIRECT_LABOUR', 'FRINGE'],
    });
    expect(result.applied[2]).toEqual({
      pool: 'MATERIAL_HANDLING',
      rate: '0.05',
      base: '800.0000', // 500 + 300
      amount: '40.0000', // 0.05 * 800
      baseElements: ['MATERIAL', 'SUBCONTRACT'],
    });
    expect(result.applied[3]).toEqual({
      pool: 'GA',
      rate: '0.1',
      base: '1800.0000', // 1000 + 300 + 260 + 200 + 40
      amount: '180.0000', // 0.10 * 1800
      baseElements: [
        'DIRECT_LABOUR',
        'FRINGE',
        'OVERHEAD',
        'DIRECT_NON_LABOUR',
        'MATERIAL_HANDLING',
      ],
    });

    // 300 + 260 + 40 + 180 = 780
    expect(result.totalBurden.toFixed(4)).toBe('780.0000');
  });

  it('reports each pool amount in byPool', () => {
    const result = applyBurdens(workedBasis(), workedBurdens(), 0);
    expect(result.byPool['FRINGE']?.toFixed(4)).toBe('300.0000');
    expect(result.byPool['OVERHEAD']?.toFixed(4)).toBe('260.0000');
    expect(result.byPool['MATERIAL_HANDLING']?.toFixed(4)).toBe('40.0000');
    expect(result.byPool['GA']?.toFixed(4)).toBe('180.0000');
    expect(Object.keys(result.byPool).sort()).toEqual([
      'FRINGE',
      'GA',
      'MATERIAL_HANDLING',
      'OVERHEAD',
    ]);
  });

  it('applies pools IN ORDER regardless of the order they were supplied', () => {
    // Shuffled input: GA first, FRINGE last.
    const shuffled: BurdenDefinition[] = [
      { pool: 'GA', ratesByYear: ['0.10'] },
      { pool: 'MATERIAL_HANDLING', ratesByYear: ['0.05'] },
      { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
      { pool: 'FRINGE', ratesByYear: ['0.30'] },
    ];
    const shuffledResult = applyBurdens(workedBasis(), shuffled, 0);
    const orderedResult = applyBurdens(workedBasis(), workedBurdens(), 0);

    expect(shuffledResult.applied.map((a) => a.pool)).toEqual([
      'FRINGE',
      'OVERHEAD',
      'MATERIAL_HANDLING',
      'GA',
    ]);
    expect(shuffledResult.applied).toEqual(orderedResult.applied);
    expect(shuffledResult.totalBurden.toFixed(4)).toBe('780.0000');
  });

  it('never draws pass-through cost into any base', () => {
    const withPassThrough = workedBasis(); // passThrough = 9999
    const withoutPassThrough: DirectCostBasis = { ...withPassThrough, passThrough: new Decimal(0) };

    const a = applyBurdens(withPassThrough, workedBurdens(), 0);
    const b = applyBurdens(withoutPassThrough, workedBurdens(), 0);

    expect(a.applied).toEqual(b.applied);
    expect(a.totalBurden.toFixed(4)).toBe('780.0000');
  });

  it('honours a custom base in place of the standard one', () => {
    // OVERHEAD restricted to bare direct labour: 0.20 * 1000 = 200 (not 260).
    // FRINGE broadened to include material:      0.30 * (1000 + 500) = 450.
    const burdens: BurdenDefinition[] = [
      { pool: 'FRINGE', ratesByYear: ['0.30'], base: ['DIRECT_LABOUR', 'MATERIAL'] },
      { pool: 'OVERHEAD', ratesByYear: ['0.20'], base: ['DIRECT_LABOUR'] },
    ];
    const result = applyBurdens(workedBasis(), burdens, 0);

    expect(result.applied[0]?.base).toBe('1500.0000'); // 1000 + 500
    expect(result.applied[0]?.amount).toBe('450.0000'); // 0.30 * 1500
    expect(result.applied[1]?.base).toBe('1000.0000');
    expect(result.applied[1]?.amount).toBe('200.0000'); // 0.20 * 1000
    // 450 + 200 = 650
    expect(result.totalBurden.toFixed(4)).toBe('650.0000');
  });

  it('treats an unconfigured pool referenced in a base as zero', () => {
    // GA's standard base names MATERIAL_HANDLING, which is not configured here.
    // GA base = 1000 (labour) + 300 (fringe) + 0 (no overhead) + 200 (other) + 0 = 1500
    const burdens: BurdenDefinition[] = [
      { pool: 'FRINGE', ratesByYear: ['0.30'] },
      { pool: 'GA', ratesByYear: ['0.10'] },
    ];
    const result = applyBurdens(workedBasis(), burdens, 0);
    expect(result.applied[1]?.base).toBe('1500.0000');
    expect(result.applied[1]?.amount).toBe('150.0000'); // 0.10 * 1500
    // 300 + 150 = 450
    expect(result.totalBurden.toFixed(4)).toBe('450.0000');
  });

  it('uses the rate for the requested year, holding the last rate flat beyond it', () => {
    const burdens: BurdenDefinition[] = [{ pool: 'FRINGE', ratesByYear: ['0.30', '0.40'] }];
    // Year 0: 0.30 * 1000 = 300
    expect(applyBurdens(workedBasis(), burdens, 0).totalBurden.toFixed(4)).toBe('300.0000');
    // Year 1: 0.40 * 1000 = 400
    expect(applyBurdens(workedBasis(), burdens, 1).totalBurden.toFixed(4)).toBe('400.0000');
    // Year 5 (beyond the schedule): holds 0.40 => 400, NOT 0
    expect(applyBurdens(workedBasis(), burdens, 5).totalBurden.toFixed(4)).toBe('400.0000');
    expect(applyBurdens(workedBasis(), burdens, 5).applied[0]?.rate).toBe('0.4');
  });

  it('returns an empty result when no pools are configured', () => {
    const result = applyBurdens(workedBasis(), [], 0);
    expect(result.applied).toEqual([]);
    expect(result.byPool).toEqual({});
    expect(result.totalBurden.toFixed(4)).toBe('0.0000');
  });

  it('exposes the conventional standard bases', () => {
    expect(STANDARD_BURDEN_BASES.FRINGE).toEqual(['DIRECT_LABOUR']);
    expect(STANDARD_BURDEN_BASES.OVERHEAD).toEqual(['DIRECT_LABOUR', 'FRINGE']);
    expect(STANDARD_BURDEN_BASES.MATERIAL_HANDLING).toEqual(['MATERIAL', 'SUBCONTRACT']);
    expect(STANDARD_BURDEN_BASES.GA).toEqual([
      'DIRECT_LABOUR',
      'FRINGE',
      'OVERHEAD',
      'DIRECT_NON_LABOUR',
      'MATERIAL_HANDLING',
    ]);
    expect(STANDARD_BURDEN_BASES.COM).toEqual(['DIRECT_LABOUR', 'FRINGE', 'OVERHEAD']);
  });
});

// --------------------------------------------------------------------------
// effectiveWrapRate
// --------------------------------------------------------------------------

describe('effectiveWrapRate', () => {
  it('is (directLabour + burden) / directLabour', () => {
    // (1000 + 780) / 1000 = 1.78
    const wrap = effectiveWrapRate(new Decimal(1000), new Decimal(780));
    expect(wrap).not.toBeNull();
    expect((wrap as Decimal).toFixed(4)).toBe('1.7800');
  });

  it('is 1.0 when there is no burden at all', () => {
    // (2500 + 0) / 2500 = 1
    expect((effectiveWrapRate(new Decimal(2500), new Decimal(0)) as Decimal).toFixed(4)).toBe(
      '1.0000',
    );
  });

  it('handles a wrap above 2x', () => {
    // (100000 + 155000) / 100000 = 2.55
    expect(
      (effectiveWrapRate(new Decimal(100000), new Decimal(155000)) as Decimal).toFixed(4),
    ).toBe('2.5500');
  });

  it('returns null when there is no direct labour (division would be meaningless)', () => {
    expect(effectiveWrapRate(new Decimal(0), new Decimal(780))).toBeNull();
    expect(effectiveWrapRate(new Decimal(0), new Decimal(0))).toBeNull();
  });
});

// --------------------------------------------------------------------------
// sumDecimals
// --------------------------------------------------------------------------

describe('sumDecimals', () => {
  it('sums mixed money inputs exactly', () => {
    // 0.1 + 0.2 + 0.3 = 0.6 exactly, which IEEE-754 doubles cannot manage.
    expect(sumDecimals(['0.1', '0.2', '0.3']).toFixed(4)).toBe('0.6000');
    // 1000 + 200.55 + 300.45 = 1501
    expect(sumDecimals(['1000', '200.55', new Decimal('300.45')]).toFixed(4)).toBe('1501.0000');
  });

  it('returns zero for an empty collection', () => {
    expect(sumDecimals([]).toFixed(4)).toBe('0.0000');
  });
});
