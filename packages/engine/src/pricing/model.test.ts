import { describe, it, expect } from 'vitest';
import {
  buildPricingModel,
  runSensitivity,
  solvePriceToWin,
  type PricingModelInput,
} from './model.js';

// --------------------------------------------------------------------------
// The worked 1-year example
// --------------------------------------------------------------------------

/*
 * WORKED EXAMPLE - every figure below is hand-computed from these inputs.
 *
 *   labour       : 1000 hours @ 100.00, no escalation      -> directLabour = 100,000
 *   direct costs : MATERIAL 10,000 (burdened)
 *                  TRAVEL    5,000 (isPassThrough: true)
 *   burdens      : FRINGE   0.30 on [DIRECT_LABOUR]
 *                  OVERHEAD 0.20 on [DIRECT_LABOUR, FRINGE]
 *                  GA       0.10 on the STANDARD base
 *                           [DIRECT_LABOUR, FRINGE, OVERHEAD, DIRECT_NON_LABOUR,
 *                            MATERIAL_HANDLING]
 *   feeRate      : 0.08
 *
 *   FRINGE   base = 100,000                              -> 0.30 * 100,000 = 30,000
 *   OVERHEAD base = 100,000 + 30,000 = 130,000           -> 0.20 * 130,000 = 26,000
 *   GA       base = 100,000 + 30,000 + 26,000
 *                   + 0 (DIRECT_NON_LABOUR: material is *not* DIRECT_NON_LABOUR)
 *                   + 0 (MATERIAL_HANDLING pool is not configured)
 *                 = 156,000                              -> 0.10 * 156,000 = 15,600
 *
 *   NOTE: the standard GA base is a VALUE-ADDED base - it names MATERIAL_HANDLING,
 *   not MATERIAL/SUBCONTRACT. With no material-handling pool configured, the
 *   10,000 of material therefore attracts no G&A at all. See the separate test
 *   'GA on a base that explicitly includes MATERIAL' for the full-cost-input variant.
 *
 *   burdenableDirect    = 100,000 + 10,000 + 0 + 0            = 110,000
 *   totalBurden         = 30,000 + 26,000 + 15,600            =  71,600
 *   totalCost           = 110,000 + 71,600                    = 181,600
 *   fee                 = 0.08 * 181,600                      =  14,528
 *   priceBeforeDiscount = 181,600 + 14,528 + 5,000 (passthru) = 201,128
 *   discount            = 0
 *   price                                                     = 201,128
 *   totalDirect         = 110,000 + 5,000                     = 115,000
 *   wrapRate            = (100,000 + 71,600) / 100,000        = 1.7160
 *   profit              = 201,128 - 181,600 - 5,000           =  14,528
 */
const workedModel = (): PricingModelInput => ({
  name: 'Worked Example',
  contractType: 'FIRM_FIXED_PRICE',
  years: 1,
  labour: [{ labourCategory: 'ENGINEER', hoursByYear: [1000], baseRate: '100.00' }],
  directCosts: [
    { description: 'Widgets', category: 'MATERIAL', amountByYear: ['10000'] },
    { description: 'Travel', category: 'TRAVEL', amountByYear: ['5000'], isPassThrough: true },
  ],
  burdens: [
    { pool: 'FRINGE', ratesByYear: ['0.30'] },
    { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
    { pool: 'GA', ratesByYear: ['0.10'] },
  ],
  feeRate: '0.08',
});

describe('buildPricingModel - full worked single-year model', () => {
  it('produces exactly the hand-computed year result', () => {
    const result = buildPricingModel(workedModel());
    expect(result.years).toHaveLength(1);
    const year = result.years[0]!;

    expect(year.year).toBe(1);
    expect(year.labourHours).toBe(1000);
    expect(year.directLabour).toBe('100000.0000'); // 1000 h * 100.00
    expect(year.material).toBe('10000.0000');
    expect(year.subcontract).toBe('0.0000');
    expect(year.otherDirect).toBe('0.0000');
    expect(year.passThrough).toBe('5000.0000');
    expect(year.totalDirect).toBe('115000.0000'); // 110,000 burdenable + 5,000 passthru
    expect(year.totalBurden).toBe('71600.0000'); // 30,000 + 26,000 + 15,600
    expect(year.totalCost).toBe('181600.0000'); // 110,000 + 71,600
    expect(year.fee).toBe('14528.0000'); // 0.08 * 181,600
    expect(year.priceBeforeDiscount).toBe('201128.0000'); // 181,600 + 14,528 + 5,000
    expect(year.discount).toBe('0.0000');
    expect(year.price).toBe('201128.0000');
    expect(year.wrapRate).toBe('1.7160'); // 171,600 / 100,000
    expect(year.profit).toBe('14528.0000'); // price - totalCost - passThrough
  });

  it('produces the hand-computed burden audit trail', () => {
    const year = buildPricingModel(workedModel()).years[0]!;

    expect(year.burdens).toEqual([
      {
        pool: 'FRINGE',
        rate: '0.3',
        base: '100000.0000',
        amount: '30000.0000',
        baseElements: ['DIRECT_LABOUR'],
      },
      {
        pool: 'OVERHEAD',
        rate: '0.2',
        base: '130000.0000', // 100,000 + 30,000
        amount: '26000.0000', // 0.20 * 130,000
        baseElements: ['DIRECT_LABOUR', 'FRINGE'],
      },
      {
        pool: 'GA',
        rate: '0.1',
        base: '156000.0000', // 100,000 + 30,000 + 26,000 + 0 + 0
        amount: '15600.0000', // 0.10 * 156,000
        baseElements: [
          'DIRECT_LABOUR',
          'FRINGE',
          'OVERHEAD',
          'DIRECT_NON_LABOUR',
          'MATERIAL_HANDLING',
        ],
      },
    ]);
  });

  it('produces exactly the hand-computed totals', () => {
    const totals = buildPricingModel(workedModel()).totals;

    expect(totals).toEqual({
      labourHours: 1000,
      directLabour: '100000.0000',
      material: '10000.0000',
      subcontract: '0.0000',
      otherDirect: '0.0000',
      passThrough: '5000.0000',
      totalDirect: '115000.0000',
      totalBurden: '71600.0000',
      totalCost: '181600.0000',
      fee: '14528.0000',
      discount: '0.0000',
      price: '201128.0000',
      profit: '14528.0000',
    });
  });

  it('produces the hand-computed margin, effective fee rate and appraisal measures', () => {
    const result = buildPricingModel(workedModel());

    /*
     * revenue = price               = 201,128
     * cost    = totalCost + passthru = 181,600 + 5,000 = 186,600
     * profit  = 201,128 - 186,600   =  14,528
     * grossMargin = 14,528 / 201,128 = 1816 / 25,141 = 0.0722326080 9...
     * markup      = 14,528 / 186,600 = 1816 / 23,325 = 0.0778563772 7...
     */
    expect(result.margin.revenue).toBe('201128.0000');
    expect(result.margin.cost).toBe('186600.0000');
    expect(result.margin.grossProfit).toBe('14528.0000');
    expect(result.margin.grossMargin as number).toBeCloseTo(0.07223260809, 10);
    expect(result.margin.markup as number).toBeCloseTo(0.07785637727, 10);

    // profit / totalCost = 14,528 / 181,600 = 0.08 exactly (no discount applied)
    expect(result.effectiveFeeRate).toBe('0.080000');

    // The profit stream is a single period-0 flow, so NPV is undiscounted.
    expect(result.npv).toBe('14528.0000');
    // A single cash flow cannot have an IRR.
    expect(result.irr).toBeNull();
    // An all-positive profit stream never dips below zero, so there is nothing to pay back.
    expect(result.payback).toEqual({ periods: null, discountedPeriods: null });
  });

  it('produces the hand-computed breakdown rows', () => {
    const result = buildPricingModel(workedModel());

    expect(result.byLabourCategory).toHaveLength(1);
    expect(result.byLabourCategory[0]!.key).toBe('ENGINEER');
    expect(result.byLabourCategory[0]!.label).toBe('ENGINEER');
    expect(result.byLabourCategory[0]!.amount).toBe('100000.0000');
    // 100,000 / 201,128 = 12,500 / 25,141 = 0.4971958156...
    expect(result.byLabourCategory[0]!.share as number).toBeCloseTo(0.4971958156, 9);

    // Sorted by amount descending: MATERIAL 10,000 then TRAVEL 5,000.
    expect(result.byCostCategory.map((r) => [r.key, r.amount])).toEqual([
      ['MATERIAL', '10000.0000'],
      ['TRAVEL', '5000.0000'],
    ]);
    // 10,000 / 201,128 = 0.04971958156 ; 5,000 / 201,128 = 0.02485979078
    expect(result.byCostCategory[0]!.share as number).toBeCloseTo(0.04971958156, 10);
    expect(result.byCostCategory[1]!.share as number).toBeCloseTo(0.02485979078, 10);

    // Sorted by amount descending: FRINGE 30,000, OVERHEAD 26,000, GA 15,600.
    expect(result.byBurdenPool.map((r) => [r.key, r.amount])).toEqual([
      ['FRINGE', '30000.0000'],
      ['OVERHEAD', '26000.0000'],
      ['GA', '15600.0000'],
    ]);
  });

  it('echoes the model identity and emits no warnings for a well-formed model', () => {
    const result = buildPricingModel({ ...workedModel(), assumptions: ['FY26 rates'] });
    expect(result.name).toBe('Worked Example');
    expect(result.contractType).toBe('FIRM_FIXED_PRICE');
    expect(result.currency).toBe('USD');
    expect(result.assumptions).toEqual(['FY26 rates']);
    expect(result.warnings).toEqual([]);
  });

  it('honours an explicit currency', () => {
    expect(buildPricingModel({ ...workedModel(), currency: 'ZAR' }).currency).toBe('ZAR');
  });
});

// --------------------------------------------------------------------------
// Pass-through treatment
// --------------------------------------------------------------------------

describe('pass-through costs', () => {
  it('are excluded from the burden base and from the fee base, and added to price at cost', () => {
    const withPassThrough = buildPricingModel(workedModel());
    const withoutPassThrough = buildPricingModel({
      ...workedModel(),
      directCosts: [{ description: 'Widgets', category: 'MATERIAL', amountByYear: ['10000'] }],
    });

    // Burdens are byte-for-byte identical: the 5,000 never touched a base.
    expect(withPassThrough.years[0]!.burdens).toEqual(withoutPassThrough.years[0]!.burdens);
    expect(withPassThrough.totals.totalBurden).toBe('71600.0000');
    expect(withoutPassThrough.totals.totalBurden).toBe('71600.0000');

    // Fee base is unchanged too: 0.08 * 181,600 = 14,528 in both models.
    expect(withPassThrough.totals.totalCost).toBe('181600.0000');
    expect(withoutPassThrough.totals.totalCost).toBe('181600.0000');
    expect(withPassThrough.totals.fee).toBe('14528.0000');
    expect(withoutPassThrough.totals.fee).toBe('14528.0000');

    // Price differs by exactly the pass-through amount: 201,128 - 196,128 = 5,000.
    expect(withoutPassThrough.totals.price).toBe('196128.0000'); // 181,600 + 14,528
    expect(withPassThrough.totals.price).toBe('201128.0000');
  });

  it('contribute nothing to profit - billed at cost', () => {
    // Profit is identical with and without the pass-through line: 14,528 either way.
    expect(buildPricingModel(workedModel()).totals.profit).toBe('14528.0000');
    expect(
      buildPricingModel({
        ...workedModel(),
        directCosts: [{ description: 'Widgets', category: 'MATERIAL', amountByYear: ['10000'] }],
      }).totals.profit,
    ).toBe('14528.0000');
  });

  it('a pass-through-only model prices at cost with zero profit', () => {
    const result = buildPricingModel({
      name: 'Reimbursables only',
      contractType: 'TIME_AND_MATERIALS',
      years: 1,
      directCosts: [
        { description: 'Travel', category: 'TRAVEL', amountByYear: ['5000'], isPassThrough: true },
      ],
      feeRate: '0.15',
    });

    const year = result.years[0]!;
    expect(year.passThrough).toBe('5000.0000');
    expect(year.totalCost).toBe('0.0000'); // nothing burdenable
    expect(year.fee).toBe('0.0000'); // 0.15 * 0 = 0
    expect(year.price).toBe('5000.0000'); // 0 + 0 + 5,000
    expect(year.profit).toBe('0.0000'); // 5,000 - 0 - 5,000
    expect(year.wrapRate).toBeNull(); // no direct labour
    expect(result.effectiveFeeRate).toBeNull(); // total cost is zero
    expect(result.margin.grossMargin).toBe(0); // (5,000 - 5,000) / 5,000
  });
});

// --------------------------------------------------------------------------
// A full-cost-input G&A base
// --------------------------------------------------------------------------

describe('GA on a base that explicitly includes MATERIAL', () => {
  it('picks up the material in the G&A base when the base is overridden', () => {
    /*
     * Same worked model, but G&A runs on a total-cost-input base:
     *   [DIRECT_LABOUR, FRINGE, OVERHEAD, DIRECT_NON_LABOUR, MATERIAL, MATERIAL_HANDLING]
     *   base = 100,000 + 30,000 + 26,000 + 0 + 10,000 + 0 = 166,000
     *   GA   = 0.10 * 166,000 = 16,600
     *   totalBurden         = 30,000 + 26,000 + 16,600 =  72,600
     *   totalCost           = 110,000 + 72,600         = 182,600
     *   fee                 = 0.08 * 182,600           =  14,608
     *   priceBeforeDiscount = 182,600 + 14,608 + 5,000 = 202,208
     */
    const result = buildPricingModel({
      ...workedModel(),
      burdens: [
        { pool: 'FRINGE', ratesByYear: ['0.30'] },
        { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
        {
          pool: 'GA',
          ratesByYear: ['0.10'],
          base: [
            'DIRECT_LABOUR',
            'FRINGE',
            'OVERHEAD',
            'DIRECT_NON_LABOUR',
            'MATERIAL',
            'MATERIAL_HANDLING',
          ],
        },
      ],
    });

    const year = result.years[0]!;
    expect(year.burdens[2]!.base).toBe('166000.0000');
    expect(year.burdens[2]!.amount).toBe('16600.0000');
    expect(year.totalBurden).toBe('72600.0000');
    expect(year.totalCost).toBe('182600.0000');
    expect(year.fee).toBe('14608.0000');
    expect(year.priceBeforeDiscount).toBe('202208.0000');
    expect(year.price).toBe('202208.0000');
    expect(year.profit).toBe('14608.0000'); // 202,208 - 182,600 - 5,000
  });
});

// --------------------------------------------------------------------------
// Escalation
// --------------------------------------------------------------------------

describe('multi-year escalation', () => {
  it('applies no escalation in year 1 and compounds from year 2', () => {
    /*
     * escalationFactor(r, yearIndex) = (1 + r) ^ yearIndex, so year index 0 gets
     * a factor of exactly 1.
     *
     * 1000 hours per year @ 100.00 base rate, 3% escalation:
     *   year 1 (index 0): 100 * 1.03^0 = 100.00   -> 1000 * 100.00 = 100,000
     *   year 2 (index 1): 100 * 1.03^1 = 103.00   -> 1000 * 103.00 = 103,000
     *   year 3 (index 2): 100 * 1.03^2 = 106.09   -> 1000 * 106.09 = 106,090
     *   total                                                       = 309,090
     */
    const result = buildPricingModel({
      name: 'Escalation',
      contractType: 'MANAGED_SERVICE',
      years: 3,
      labour: [
        {
          labourCategory: 'ENGINEER',
          hoursByYear: [1000, 1000, 1000],
          baseRate: '100.00',
          escalationRate: '0.03',
        },
      ],
    });

    expect(result.years.map((y) => y.year)).toEqual([1, 2, 3]);
    expect(result.years.map((y) => y.directLabour)).toEqual([
      '100000.0000',
      '103000.0000',
      '106090.0000',
    ]);
    expect(result.totals.directLabour).toBe('309090.0000');
    expect(result.totals.labourHours).toBe(3000);
  });

  it('escalates direct costs on the same year-index convention', () => {
    /*
     * 10,000 per year at 5% escalation:
     *   year 1: 10,000 * 1.05^0 = 10,000
     *   year 2: 10,000 * 1.05^1 = 10,500
     *   year 3: 10,000 * 1.05^2 = 11,025
     */
    const result = buildPricingModel({
      name: 'Direct escalation',
      contractType: 'MANAGED_SERVICE',
      years: 3,
      directCosts: [
        {
          description: 'Licences',
          category: 'SOFTWARE',
          amountByYear: ['10000', '10000', '10000'],
          escalationRate: '0.05',
        },
      ],
    });

    expect(result.years.map((y) => y.otherDirect)).toEqual([
      '10000.0000',
      '10500.0000',
      '11025.0000',
    ]);
    // 10,000 + 10,500 + 11,025 = 31,525
    expect(result.totals.otherDirect).toBe('31525.0000');
  });
});

// --------------------------------------------------------------------------
// Schedule-length edge behaviour (deliberately asymmetric)
// --------------------------------------------------------------------------

describe('short schedules', () => {
  it('holds the last DIRECT COST value flat but DEFAULTS LABOUR HOURS TO ZERO', () => {
    /*
     * Term: 3 years.
     *   labour hoursByYear = [1000]           -> 1000, 0, 0        (defaults to zero)
     *   direct amountByYear = ['1000','2000'] -> 1000, 2000, 2000  (holds last flat)
     *
     * These two behaviours differ deliberately, so both are pinned here.
     *
     * year 1: directLabour = 1000 * 100 = 100,000 ; otherDirect = 1,000
     * year 2: directLabour = 0                    ; otherDirect = 2,000
     * year 3: directLabour = 0                    ; otherDirect = 2,000 (held flat)
     */
    const result = buildPricingModel({
      name: 'Short schedules',
      contractType: 'FIRM_FIXED_PRICE',
      years: 3,
      labour: [{ labourCategory: 'ENGINEER', hoursByYear: [1000], baseRate: '100' }],
      directCosts: [
        { description: 'Facilities', category: 'FACILITIES', amountByYear: ['1000', '2000'] },
      ],
    });

    expect(result.years.map((y) => y.labourHours)).toEqual([1000, 0, 0]);
    expect(result.years.map((y) => y.directLabour)).toEqual(['100000.0000', '0.0000', '0.0000']);
    expect(result.years.map((y) => y.otherDirect)).toEqual(['1000.0000', '2000.0000', '2000.0000']);
    // 100,000 total labour ; 1,000 + 2,000 + 2,000 = 5,000 other direct
    expect(result.totals.directLabour).toBe('100000.0000');
    expect(result.totals.otherDirect).toBe('5000.0000');

    // No direct labour in years 2 and 3, so no wrap rate can be quoted.
    expect(result.years[0]!.wrapRate).toBe('1.0000'); // no burdens configured
    expect(result.years[1]!.wrapRate).toBeNull();
    expect(result.years[2]!.wrapRate).toBeNull();
  });

  it('holds a single-entry direct cost schedule flat across the whole term', () => {
    const result = buildPricingModel({
      name: 'Flat direct',
      contractType: 'SUBSCRIPTION',
      years: 4,
      directCosts: [{ description: 'Hosting', category: 'SOFTWARE', amountByYear: ['2500'] }],
    });
    expect(result.years.map((y) => y.otherDirect)).toEqual([
      '2500.0000',
      '2500.0000',
      '2500.0000',
      '2500.0000',
    ]);
    // 2,500 * 4 = 10,000
    expect(result.totals.otherDirect).toBe('10000.0000');
  });
});

// --------------------------------------------------------------------------
// Discount
// --------------------------------------------------------------------------

describe('discountRate', () => {
  it('is applied to the whole price, pass-through included', () => {
    /*
     * Worked model plus a 5% concession:
     *   priceBeforeDiscount = 201,128
     *   discount            = 0.05 * 201,128 =  10,056.40
     *   price               = 201,128 - 10,056.40 = 191,071.60
     *   profit              = 191,071.60 - 181,600 - 5,000 = 4,471.60
     */
    const result = buildPricingModel({ ...workedModel(), discountRate: '0.05' });
    const year = result.years[0]!;

    expect(year.priceBeforeDiscount).toBe('201128.0000');
    expect(year.discount).toBe('10056.4000');
    expect(year.price).toBe('191071.6000');
    expect(year.profit).toBe('4471.6000');
    expect(result.totals.discount).toBe('10056.4000');
    expect(result.totals.price).toBe('191071.6000');
    // profit / totalCost = 4,471.60 / 181,600 = 0.024623...
    // 4471.6 / 181600 = 0.0246233480176211...
    expect(result.effectiveFeeRate).toBe('0.024623');
  });

  it('throws at a discount of 100% or more', () => {
    expect(() => buildPricingModel({ ...workedModel(), discountRate: '1' })).toThrow(
      /discount of 100% or more cannot be priced/,
    );
    expect(() => buildPricingModel({ ...workedModel(), discountRate: '1.5' })).toThrow(
      /discount of 100% or more cannot be priced/,
    );
  });

  it('accepts a discount just under 100%', () => {
    // 0.99 discount: price = 201,128 * 0.01 = 2,011.28
    const result = buildPricingModel({ ...workedModel(), discountRate: '0.99' });
    expect(result.totals.price).toBe('2011.2800');
  });
});

// --------------------------------------------------------------------------
// Input validation
// --------------------------------------------------------------------------

describe('input validation', () => {
  it('throws when the term is shorter than one year', () => {
    expect(() => buildPricingModel({ ...workedModel(), years: 0 })).toThrow(
      /Contract term must be between 1 and 20 years/,
    );
    expect(() => buildPricingModel({ ...workedModel(), years: -3 })).toThrow(
      /Contract term must be between 1 and 20 years/,
    );
    // 0.9 truncates to 0
    expect(() => buildPricingModel({ ...workedModel(), years: 0.9 })).toThrow(
      /Contract term must be between 1 and 20 years/,
    );
  });

  it('throws when the term exceeds twenty years', () => {
    expect(() => buildPricingModel({ ...workedModel(), years: 21 })).toThrow(
      /Contract term must be between 1 and 20 years/,
    );
  });

  it('accepts the boundary terms of 1 and 20 years', () => {
    expect(buildPricingModel({ ...workedModel(), years: 1 }).years).toHaveLength(1);
    expect(buildPricingModel({ ...workedModel(), years: 20 }).years).toHaveLength(20);
  });

  it('throws when there are neither labour nor direct cost lines', () => {
    expect(() =>
      buildPricingModel({
        name: 'Empty',
        contractType: 'FIRM_FIXED_PRICE',
        years: 1,
      }),
    ).toThrow(/needs at least one labour or direct cost line/);

    expect(() =>
      buildPricingModel({
        name: 'Empty',
        contractType: 'FIRM_FIXED_PRICE',
        years: 1,
        labour: [],
        directCosts: [],
      }),
    ).toThrow(/needs at least one labour or direct cost line/);
  });

  it('propagates burden validation errors', () => {
    expect(() =>
      buildPricingModel({
        ...workedModel(),
        burdens: [
          { pool: 'FRINGE', ratesByYear: ['0.30'], base: ['OVERHEAD'] },
          { pool: 'OVERHEAD', ratesByYear: ['0.20'] },
        ],
      }),
    ).toThrow(/FRINGE draws on OVERHEAD/);
  });
});

// --------------------------------------------------------------------------
// Warnings
// --------------------------------------------------------------------------

describe('warnings', () => {
  it('warns when no indirect cost pools are configured', () => {
    const result = buildPricingModel({ ...workedModel(), burdens: [] });
    expect(result.warnings).toContain(
      'No indirect cost pools are configured. This price recovers direct cost only and will understate the true cost of delivery.',
    );
    // Without burdens: totalCost = 110,000 ; fee = 0.08 * 110,000 = 8,800
    expect(result.totals.totalCost).toBe('110000.0000');
    expect(result.totals.fee).toBe('8800.0000');
  });

  it('warns when a labour schedule is longer than the contract term', () => {
    const result = buildPricingModel({
      ...workedModel(),
      years: 2,
      labour: [{ labourCategory: 'ENGINEER', hoursByYear: [1000, 1000, 1000], baseRate: '100' }],
    });
    expect(result.warnings).toContain(
      "Labour line 'ENGINEER' supplies 3 years of hours for a 2-year term; the excess is ignored.",
    );
    // Only the first two years are priced: 100,000 + 100,000 = 200,000
    expect(result.totals.directLabour).toBe('200000.0000');
  });

  it('warns when the fee rate is negative', () => {
    const result = buildPricingModel({ ...workedModel(), feeRate: '-0.05' });
    expect(result.warnings).toContain(
      'Fee rate is negative: this model prices below cost before any discount.',
    );
    // fee = -0.05 * 181,600 = -9,080
    expect(result.totals.fee).toBe('-9080.0000');
    // price = 181,600 - 9,080 + 5,000 = 177,520
    expect(result.totals.price).toBe('177520.0000');
  });

  it('warns when labour lines were supplied but produced no cost', () => {
    const result = buildPricingModel({
      name: 'Zero hours',
      contractType: 'FIRM_FIXED_PRICE',
      years: 1,
      labour: [{ labourCategory: 'ENGINEER', hoursByYear: [0], baseRate: '100' }],
      directCosts: [{ description: 'Kit', category: 'EQUIPMENT', amountByYear: ['1000'] }],
    });
    expect(result.warnings).toContain(
      'Labour lines were supplied but produced no cost. Check the hours schedule.',
    );
    expect(result.totals.directLabour).toBe('0.0000');
  });

  it('emits no warnings when nothing is wrong', () => {
    expect(buildPricingModel(workedModel()).warnings).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// solvePriceToWin
// --------------------------------------------------------------------------

describe('solvePriceToWin', () => {
  it('solves for a target gross margin', () => {
    /*
     * With no discount:
     *   price   = totalCost * (1 + f) + passThrough
     *   cost    = totalCost + passThrough
     *   margin  = totalCost * f / (totalCost * (1 + f) + passThrough)
     *
     * totalCost = 181,600 ; passThrough = 5,000 ; target margin 0.25:
     *   181,600 f = 0.25 * (181,600 + 181,600 f + 5,000)
     *   181,600 f = 46,650 + 45,400 f
     *   136,200 f = 46,650
     *           f = 46,650 / 136,200 = 311 / 908 = 0.342511013215859...
     */
    const solved = solvePriceToWin(workedModel(), { kind: 'MARGIN', value: '0.25' });

    expect(solved.converged).toBe(true);
    expect(solved.feeRate).toBe('0.342511');
    expect(solved.achieved.margin.grossMargin as number).toBeCloseTo(0.25, 6);
    expect(Math.abs((solved.achieved.margin.grossMargin as number) - 0.25)).toBeLessThan(1e-6);
    expect(solved.iterations).toBeGreaterThan(0);
  });

  it('the solved margin model foots: price, cost and profit are consistent', () => {
    const solved = solvePriceToWin(workedModel(), { kind: 'MARGIN', value: '0.25' });
    const totals = solved.achieved.totals;
    // cost = totalCost + passThrough = 181,600 + 5,000 = 186,600
    expect(totals.totalCost).toBe('181600.0000');
    expect(totals.passThrough).toBe('5000.0000');
    // price = 186,600 / (1 - 0.25) = 248,800
    expect(Number(totals.price)).toBeCloseTo(248800, 2);
    // profit = price - 186,600 = 62,200
    expect(Number(totals.profit)).toBeCloseTo(62200, 2);
  });

  it('solves for a target total price to within a cent', () => {
    /*
     * price = 181,600 * (1 + f) + 5,000 = 190,000
     *   181,600 * (1 + f) = 185,000
     *   f = 3,400 / 181,600 = 17 / 908 = 0.018722466960352...
     */
    const solved = solvePriceToWin(workedModel(), { kind: 'PRICE', value: '190000' });

    expect(solved.feeRate).toBe('0.018722');
    expect(Math.abs(Number(solved.achieved.totals.price) - 190000)).toBeLessThan(0.01);
  });

  it('reports converged:false rather than fabricating an answer when the target cannot be bracketed', () => {
    /*
     * The fee-rate search range is [-0.5, 5]. The reachable price band is:
     *   f = -0.5 : 181,600 * 0.5 + 5,000 =    95,800
     *   f =  5   : 181,600 * 6   + 5,000 = 1,094,600
     * A 10,000,000 target lies outside it, so both endpoints have the same sign
     * and there is no bracket. The solver returns the closer endpoint (f = 5,
     * residual 1,094,600 - 10,000,000 = -8,905,400) and flags non-convergence.
     */
    const solved = solvePriceToWin(workedModel(), { kind: 'PRICE', value: '10000000' });

    expect(solved.converged).toBe(false);
    expect(solved.iterations).toBe(0);
    expect(solved.feeRate).toBe('5.000000');
    expect(solved.achieved.totals.price).toBe('1094600.0000');
    expect(solved.residual).toBe('-8905400.000000');
  });

  it('reports converged:false for an unreachable margin target', () => {
    // A 99% gross margin is not reachable with a fee rate capped at 5 on this cost base:
    //   f = 5 -> price = 1,094,600 ; cost = 186,600 ; margin = 0.82953... < 0.99
    const solved = solvePriceToWin(workedModel(), { kind: 'MARGIN', value: '0.99' });
    expect(solved.converged).toBe(false);
    expect(solved.iterations).toBe(0);
    expect(solved.feeRate).toBe('5.000000');
    // (1,094,600 - 186,600) / 1,094,600 = 908,000 / 1,094,600 = 0.8295267...
    expect(solved.achieved.margin.grossMargin as number).toBeCloseTo(0.8295267677, 9);
  });

  it('honours a caller-supplied search range', () => {
    // The true answer (0.3425...) lies outside [0, 0.1], so no bracket exists.
    const solved = solvePriceToWin(
      workedModel(),
      { kind: 'MARGIN', value: '0.25' },
      {
        lower: 0,
        upper: 0.1,
      },
    );
    expect(solved.converged).toBe(false);
  });

  /*
   * SUSPECTED BUG - model.ts:396
   *
   *   const evaluate = (feeRate: number) => buildPricingModel({ ...model, feeRate: String(feeRate) });
   *
   * `String(n)` renders any |n| < 1e-6 in exponential notation ('6.4e-10'), and
   * toDecimal() rejects that with `Not a valid decimal string`. Bisection over
   * [-0.5, 5] drives the midpoint through arbitrarily small magnitudes whenever
   * the root sits at (or near) zero, so solving for a zero margin - a perfectly
   * ordinary "price at cost" request - blows up with a TypeError instead of
   * returning fee = 0.
   *
   * Correct behaviour is asserted here; the test is expected to fail until the
   * call site serialises with toRateString()/Decimal instead of String().
   */
  it.fails('solves a zero-margin (price-at-cost) target', () => {
    const solved = solvePriceToWin(workedModel(), { kind: 'MARGIN', value: '0' });
    expect(solved.converged).toBe(true);
    expect(Number(solved.feeRate)).toBeCloseTo(0, 6);
  });

  /*
   * SUSPECTED BUG - model.ts:398-406 / 420
   *
   * When the model has zero revenue the MARGIN objective returns -Infinity. The
   * no-bracket branch is entered correctly, but it then calls
   * `toMoneyString(objective(achieved), 6)` on that same -Infinity, and
   * toDecimal() throws `Non-finite number: -Infinity`. The documented intent
   * ("report the closest endpoint rather than a fabricated answer") is never
   * reached.
   */
  it.fails('reports non-convergence rather than throwing on a zero-revenue model', () => {
    const zeroRevenue: PricingModelInput = {
      name: 'Zero revenue',
      contractType: 'FIRM_FIXED_PRICE',
      years: 1,
      labour: [{ labourCategory: 'ENGINEER', hoursByYear: [0], baseRate: '100' }],
    };
    const solved = solvePriceToWin(zeroRevenue, { kind: 'MARGIN', value: '0.25' });
    expect(solved.converged).toBe(false);
  });
});

// --------------------------------------------------------------------------
// runSensitivity
// --------------------------------------------------------------------------

/*
 * SENSITIVITY BASE - hand-computed.
 *
 *   1000 hours @ 100.00, FRINGE 0.30 on direct labour, fee 0.10, 1 year.
 *
 *   directLabour = 100,000
 *   FRINGE       = 0.30 * 100,000 = 30,000
 *   totalCost    = 100,000 + 30,000 = 130,000
 *   fee          = 0.10 * 130,000  =  13,000
 *   price        = 143,000
 *   margin       = 13,000 / 143,000 = 1/11 = 0.0909090909...
 */
const sensitivityBase = (): PricingModelInput => ({
  name: 'Sensitivity base',
  contractType: 'COST_PLUS_FIXED_FEE',
  years: 1,
  labour: [{ labourCategory: 'ENGINEER', hoursByYear: [1000], baseRate: '100' }],
  burdens: [{ pool: 'FRINGE', ratesByYear: ['0.30'] }],
  feeRate: '0.10',
});

describe('runSensitivity', () => {
  it('reports the unmodified base alongside the cases', () => {
    const { base } = runSensitivity(sensitivityBase(), []);
    expect(base.totals.totalCost).toBe('130000.0000');
    expect(base.totals.price).toBe('143000.0000');
    expect(base.margin.grossMargin as number).toBeCloseTo(0.09090909090909091, 12);
  });

  it('labourRateFactor 1.10 raises cost and price', () => {
    /*
     * baseRate 100 * 1.10 = 110
     *   directLabour = 1000 * 110      = 110,000
     *   FRINGE       = 0.30 * 110,000  =  33,000
     *   totalCost    = 143,000
     *   fee          = 0.10 * 143,000  =  14,300
     *   price        = 157,300
     *   priceDelta   = 157,300 - 143,000 = 14,300
     *   margin       = 14,300 / 157,300 = 1/11 -> marginDelta = 0 (uniform scaling)
     */
    const { rows } = runSensitivity(sensitivityBase(), [
      { label: 'Rates +10%', labourRateFactor: 1.1 },
    ]);
    const row = rows[0]!;

    expect(row.label).toBe('Rates +10%');
    expect(row.cost).toBe('143000.0000');
    expect(row.price).toBe('157300.0000');
    expect(row.priceDelta).toBe('14300.0000');
    expect(row.margin as number).toBeCloseTo(0.09090909090909091, 12);
    expect(row.marginDelta as number).toBeCloseTo(0, 12);
  });

  it('hoursFactor scales the volume', () => {
    /*
     * hours 1000 * 0.5 = 500
     *   directLabour = 50,000 ; FRINGE = 15,000 ; totalCost = 65,000
     *   fee = 6,500 ; price = 71,500 ; priceDelta = 71,500 - 143,000 = -71,500
     */
    const { rows } = runSensitivity(sensitivityBase(), [{ label: 'Half', hoursFactor: 0.5 }]);
    expect(rows[0]!.cost).toBe('65000.0000');
    expect(rows[0]!.price).toBe('71500.0000');
    expect(rows[0]!.priceDelta).toBe('-71500.0000');
  });

  it('burdenRateShift is ADDITIVE in percentage points', () => {
    /*
     * FRINGE 0.30 + 0.05 = 0.35 (not 0.30 * 1.05)
     *   FRINGE    = 0.35 * 100,000 = 35,000
     *   totalCost = 135,000
     *   fee       = 13,500
     *   price     = 148,500 ; priceDelta = 5,500
     */
    const { rows } = runSensitivity(sensitivityBase(), [
      { label: 'Fringe +5pp', burdenRateShift: 0.05 },
    ]);
    expect(rows[0]!.cost).toBe('135000.0000');
    expect(rows[0]!.price).toBe('148500.0000');
    expect(rows[0]!.priceDelta).toBe('5500.0000');
  });

  it('burdenRateShift CLAMPS AT ZERO - rates never go negative', () => {
    /*
     * FRINGE 0.30 - 0.95 = -0.65, clamped to 0.
     *   FRINGE    = 0
     *   totalCost = 100,000        (NOT 100,000 - 65,000 = 35,000)
     *   fee       = 0.10 * 100,000 = 10,000
     *   price     = 110,000 ; priceDelta = 110,000 - 143,000 = -33,000
     */
    const { rows } = runSensitivity(sensitivityBase(), [
      { label: 'Fringe collapse', burdenRateShift: -0.95 },
    ]);
    expect(rows[0]!.cost).toBe('100000.0000');
    expect(rows[0]!.price).toBe('110000.0000');
    expect(rows[0]!.priceDelta).toBe('-33000.0000');
    // A negative rate would have produced 35,000 of cost and a 38,500 price.
    expect(rows[0]!.cost).not.toBe('35000.0000');
  });

  it('a replacement fee rate moves the margin', () => {
    /*
     * feeRate 0.15 on an unchanged 130,000 cost base:
     *   fee   = 19,500 ; price = 149,500 ; priceDelta = 6,500
     *   margin = 19,500 / 149,500 = 3/23 = 0.1304347826086957...
     *   marginDelta = 3/23 - 1/11 = (33 - 23)/253 = 10/253 = 0.0395256916996047...
     */
    const { rows } = runSensitivity(sensitivityBase(), [{ label: 'Fee 15%', feeRate: '0.15' }]);
    expect(rows[0]!.cost).toBe('130000.0000');
    expect(rows[0]!.price).toBe('149500.0000');
    expect(rows[0]!.priceDelta).toBe('6500.0000');
    expect(rows[0]!.margin as number).toBeCloseTo(0.13043478260869565, 12);
    expect(rows[0]!.marginDelta as number).toBeCloseTo(0.03952569169960474, 12);
  });

  it('combines adjustments within a single case', () => {
    /*
     * Rates +10% AND fringe +5pp:
     *   directLabour = 110,000
     *   FRINGE       = 0.35 * 110,000 = 38,500
     *   totalCost    = 148,500
     *   fee          = 14,850
     *   price        = 163,350 ; priceDelta = 163,350 - 143,000 = 20,350
     */
    const { rows } = runSensitivity(sensitivityBase(), [
      { label: 'Both', labourRateFactor: 1.1, burdenRateShift: 0.05 },
    ]);
    expect(rows[0]!.cost).toBe('148500.0000');
    expect(rows[0]!.price).toBe('163350.0000');
    expect(rows[0]!.priceDelta).toBe('20350.0000');
  });

  it('leaves the model untouched when a case specifies nothing', () => {
    const { rows } = runSensitivity(sensitivityBase(), [{ label: 'No change' }]);
    expect(rows[0]!.cost).toBe('130000.0000');
    expect(rows[0]!.price).toBe('143000.0000');
    expect(rows[0]!.priceDelta).toBe('0.0000');
    expect(rows[0]!.marginDelta as number).toBeCloseTo(0, 15);
  });

  it('runs every supplied case, in order', () => {
    const { rows } = runSensitivity(sensitivityBase(), [
      { label: 'A', labourRateFactor: 1.1 },
      { label: 'B', hoursFactor: 0.5 },
      { label: 'C', burdenRateShift: 0.05 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['A', 'B', 'C']);
    expect(rows.map((r) => r.price)).toEqual(['157300.0000', '71500.0000', '148500.0000']);
  });
});
