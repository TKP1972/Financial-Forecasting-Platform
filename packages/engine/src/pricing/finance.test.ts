import { describe, it, expect } from 'vitest';
import { toMoneyString, type Decimal } from '@ffp/shared';
import {
  breakEvenVolume,
  contributionMarginRatio,
  expectedValue,
  internalRateOfReturn,
  marginSummary,
  netPresentValue,
  paybackPeriod,
} from './finance.js';

// --------------------------------------------------------------------------
// netPresentValue
// --------------------------------------------------------------------------

describe('netPresentValue', () => {
  it('leaves period 0 UNDISCOUNTED', () => {
    // A single flow at period 0 is worth its face value at any discount rate.
    expect(toMoneyString(netPresentValue(['1000'], '0.25'))).toBe('1000.0000');
    expect(toMoneyString(netPresentValue(['1000'], '0.99'))).toBe('1000.0000');
    // Period 1 IS discounted: 1000 / 1.25 = 800
    expect(toMoneyString(netPresentValue(['0', '1000'], '0.25'))).toBe('800.0000');
  });

  it('discounts a classic four-period flow correctly', () => {
    /*
     * [-1000, 500, 500, 500] at 10%
     *
     *   period 0: -1000 / 1.1^0 = -1000
     *   period 1:   500 / 1.1   =  454.545454545454545454545...
     *   period 2:   500 / 1.21  =  413.223140495867768595041...
     *   period 3:   500 / 1.331 =  375.657400450788880540946...
     *
     * Exactly: 500 * (1/1.1 + 1/1.21 + 1/1.331)
     *        = 500 * (1.21 + 1.1 + 1) / 1.331
     *        = 500 * 3.31 / 1.331
     *        = 1655 / 1.331 = 1655000 / 1331
     *        = 1243 + 567/1331
     *        = 1243.425995492...       (567/1331 = 0.4259954924...)
     *
     * NPV = 1243.425995492... - 1000 = 243.425995492...  -> 243.4260 at 4dp
     */
    expect(toMoneyString(netPresentValue(['-1000', '500', '500', '500'], '0.10'))).toBe('243.4260');
  });

  it('returns the plain sum at a zero discount rate', () => {
    // -1000 + 500 + 500 + 500 = 500
    expect(toMoneyString(netPresentValue(['-1000', '500', '500', '500'], '0'))).toBe('500.0000');
  });

  it('handles a negative (but > -100%) discount rate', () => {
    // [0, 100] at -50%: 100 / 0.5 = 200
    expect(toMoneyString(netPresentValue(['0', '100'], '-0.5'))).toBe('200.0000');
  });

  it('returns zero for an empty flow', () => {
    expect(toMoneyString(netPresentValue([], '0.10'))).toBe('0.0000');
  });

  it('throws when the discount rate is -100% or worse', () => {
    expect(() => netPresentValue(['-1000', '500'], '-1')).toThrow(
      /Discount rate must exceed -100%/,
    );
    expect(() => netPresentValue(['-1000', '500'], '-1.5')).toThrow(
      /Discount rate must exceed -100%/,
    );
  });

  it('does NOT throw just below -100%', () => {
    expect(() => netPresentValue(['-1000', '500'], '-0.9999')).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// internalRateOfReturn
// --------------------------------------------------------------------------

describe('internalRateOfReturn', () => {
  it('solves the two-period case to the closed-form answer', () => {
    /*
     * [-1000, 600, 600].  Let x = 1/(1+r):
     *   600x + 600x^2 = 1000  =>  3x^2 + 3x - 5 = 0
     *   x = (-3 + sqrt(69)) / 6
     *   1 + r = 6 / (sqrt(69) - 3) = 6(sqrt(69)+3)/60 = (sqrt(69)+3)/10
     *   sqrt(69) = 8.306623862918075...
     *   1 + r = 1.1306623862918075   =>  r = 0.1306623862918075
     */
    const irr = internalRateOfReturn(['-1000', '600', '600']);
    expect(irr).not.toBeNull();
    expect(irr as number).toBeCloseTo(0.1306623862918075, 8);
  });

  it('cross-checks: NPV at the returned IRR is ~0', () => {
    const flows = ['-1000', '600', '600'];
    const irr = internalRateOfReturn(flows) as number;
    // Bisection stops once the bracket is narrower than 1e-9; with dNPV/dr ~= -1300
    // near the root that bounds the residual NPV at well under a hundredth of a cent.
    expect(netPresentValue(flows, irr).abs().lessThan('0.00001')).toBe(true);
  });

  it('solves a simple single-repayment case exactly', () => {
    // [-1000, 100]: 100/(1+r) = 1000 => 1+r = 0.1 => r = -0.9
    const irr = internalRateOfReturn(['-1000', '100']);
    expect(irr as number).toBeCloseTo(-0.9, 8);
  });

  it('solves a break-even flow to a 0% IRR', () => {
    // [-300, 100, 100, 100]: sum is zero, so NPV is zero at r = 0.
    const irr = internalRateOfReturn(['-300', '100', '100', '100']);
    expect(irr as number).toBeCloseTo(0, 8);
  });

  it('returns null when every flow is positive (no sign change)', () => {
    expect(internalRateOfReturn(['100', '200', '300'])).toBeNull();
  });

  it('returns null when every flow is negative (no sign change)', () => {
    expect(internalRateOfReturn(['-100', '-200', '-300'])).toBeNull();
  });

  it('returns null when zeros are the only "other" sign', () => {
    expect(internalRateOfReturn(['0', '0', '100'])).toBeNull();
    expect(internalRateOfReturn(['0', '0', '-100'])).toBeNull();
  });

  it('returns null for fewer than two cash flows', () => {
    expect(internalRateOfReturn([])).toBeNull();
    expect(internalRateOfReturn(['-1000'])).toBeNull();
    expect(internalRateOfReturn(['1000'])).toBeNull();
  });

  it('returns null rather than guessing when the search range is not bracketed', () => {
    /*
     * [-100, 250, -150] has two roots (r = 0 and r = 0.5) and NPV is negative at
     * BOTH ends of the search range, so bisection cannot bracket a sign change:
     *   x = 1/(1+r):  -100 + 250x - 150x^2 = 0  =>  3x^2 - 5x + 2 = 0  =>  x = 1 or 2/3
     * At r = -0.9999 (x = 10000): -100 + 2,500,000 - 15,000,000,000 < 0
     * At r = 10     (x = 1/11):   -100 + 22.7272... - 1.2396... < 0
     */
    expect(internalRateOfReturn(['-100', '250', '-150'])).toBeNull();
  });

  it('respects a caller-supplied search range', () => {
    // Restricting the range so the root at ~0.13066 falls outside it yields null.
    expect(internalRateOfReturn(['-1000', '600', '600'], { lower: 0.5, upper: 2 })).toBeNull();
  });
});

// --------------------------------------------------------------------------
// paybackPeriod
// --------------------------------------------------------------------------

describe('paybackPeriod', () => {
  it('interpolates linearly inside the crossing period', () => {
    /*
     * [-1000, 400, 400, 400, 400], undiscounted.
     *   cumulative after period 0: -1000
     *   cumulative after period 1:  -600
     *   cumulative after period 2:  -200
     *   period 3 brings +400, so break-even occurs 200/400 = 0.5 of the way in
     *   payback = 2 + 0.5 = 2.5 periods
     */
    const result = paybackPeriod(['-1000', '400', '400', '400', '400'], '0');
    expect(result.periods).toBe(2.5);
    expect(result.discountedPeriods).toBe(2.5); // a zero rate leaves flows untouched
  });

  it('returns an exact integer when break-even lands on a period boundary', () => {
    // [-1000, 600, 400]: cumulative after period 2 is exactly 0
    //   fraction = 400/400 = 1  =>  payback = (2 - 1) + 1 = 2
    expect(paybackPeriod(['-1000', '600', '400'], '0').periods).toBe(2);
  });

  it('discounted payback is LATER than undiscounted at a positive discount rate', () => {
    /*
     * [-1000, 400, 400, 400, 400] at 10%.
     *   discounted flows: -1000,
     *                     400/1.1    = 363.636363636...
     *                     400/1.21   = 330.578512396...
     *                     400/1.331  = 300.525920360...
     *                     400/1.4641 = 273.205382145...
     *   cumulative after period 3 = 1000 - 400*(3.31/1.331)
     *                             = (1331 - 1324)/1.331 = 7/1.331 = 5.259203606...  (still short)
     *   fraction into period 4 = (7/1.331) / (400/1.4641)
     *                          = 7 * 1.4641 / (1.331 * 400)
     *                          = 7 * 1.1 / 400 = 7.7/400 = 0.01925   (exact)
     *   discounted payback = (4 - 1) + 0.01925 = 3.01925
     */
    const result = paybackPeriod(['-1000', '400', '400', '400', '400'], '0.10');
    expect(result.periods).toBe(2.5);
    expect(result.discountedPeriods).not.toBeNull();
    expect(result.discountedPeriods as number).toBeCloseTo(3.01925, 9);
    expect(result.discountedPeriods as number).toBeGreaterThan(result.periods as number);
  });

  it('returns null when the investment never pays back', () => {
    // -1000 + 100 + 100 = -800: cumulative never reaches zero.
    const result = paybackPeriod(['-1000', '100', '100'], '0.10');
    expect(result.periods).toBeNull();
    expect(result.discountedPeriods).toBeNull();
  });

  it('interpolates a sub-period payback and pushes it out to a whole period once discounted', () => {
    /*
     * [-1000, 1100] at 10%: undiscounted pays back at period 1 exactly
     *   (fraction = 1000/1100 = 0.909090..., payback = 0 + 0.909090... = 0.90909...)
     * Discounted, period-1 flow is 1100/1.1 = 1000 exactly, so payback = 0 + 1 = 1.
     */
    const result = paybackPeriod(['-1000', '1100'], '0.10');
    expect(result.periods as number).toBeCloseTo(0.9090909090909091, 12);
    expect(result.discountedPeriods).toBe(1);
  });

  it('returns null when the flow never goes negative (nothing to pay back)', () => {
    // Cumulative is never below zero, so the crossing condition never fires.
    const result = paybackPeriod(['500', '500'], '0.10');
    expect(result.periods).toBeNull();
    expect(result.discountedPeriods).toBeNull();
  });

  it('defaults to a zero discount rate', () => {
    const result = paybackPeriod(['-1000', '400', '400', '400', '400']);
    expect(result.periods).toBe(2.5);
    expect(result.discountedPeriods).toBe(2.5);
  });
});

// --------------------------------------------------------------------------
// marginSummary
// --------------------------------------------------------------------------

describe('marginSummary', () => {
  it('reports margin and mark-up as the DIFFERENT numbers they are', () => {
    /*
     * revenue 130, cost 100 => gross profit 30
     *   grossMargin = 30 / 130 = 3/13 = 0.230769230769230769...
     *   markup      = 30 / 100 = 0.30
     */
    const summary = marginSummary('130', '100');
    expect(summary.revenue).toBe('130.0000');
    expect(summary.cost).toBe('100.0000');
    expect(summary.grossProfit).toBe('30.0000');
    expect(summary.grossMargin as number).toBeCloseTo(0.23076923076923078, 12);
    expect(summary.markup).toBe(0.3);
    expect(summary.grossMargin).not.toBe(summary.markup);
  });

  it('reports a loss as a negative profit, margin and mark-up', () => {
    // revenue 80, cost 100 => profit -20; margin -20/80 = -0.25; markup -20/100 = -0.2
    const summary = marginSummary('80', '100');
    expect(summary.grossProfit).toBe('-20.0000');
    expect(summary.grossMargin).toBe(-0.25);
    expect(summary.markup).toBe(-0.2);
  });

  it('returns a null margin when revenue is zero', () => {
    // revenue 0, cost 100 => profit -100; margin undefined; markup -100/100 = -1
    const summary = marginSummary('0', '100');
    expect(summary.grossMargin).toBeNull();
    expect(summary.markup).toBe(-1);
    expect(summary.grossProfit).toBe('-100.0000');
  });

  it('returns a null mark-up when cost is zero', () => {
    // revenue 100, cost 0 => profit 100; margin 100/100 = 1; markup undefined
    const summary = marginSummary('100', '0');
    expect(summary.markup).toBeNull();
    expect(summary.grossMargin).toBe(1);
    expect(summary.grossProfit).toBe('100.0000');
  });

  it('returns both null when revenue and cost are both zero', () => {
    const summary = marginSummary('0', '0');
    expect(summary.grossMargin).toBeNull();
    expect(summary.markup).toBeNull();
    expect(summary.grossProfit).toBe('0.0000');
  });

  it('rounds serialised amounts to 4dp', () => {
    // 100.12345 rounds half-even to 100.1234 (the digit before the 5 is even... 4 -> 100.1234)
    const summary = marginSummary('100.12345', '0.00005');
    expect(summary.revenue).toBe('100.1234');
    expect(summary.cost).toBe('0.0000');
  });
});

// --------------------------------------------------------------------------
// breakEvenVolume
// --------------------------------------------------------------------------

describe('breakEvenVolume', () => {
  it('is fixed cost divided by unit contribution', () => {
    // contribution = 25 - 15 = 10; 10000 / 10 = 1000 units
    const volume = breakEvenVolume('10000', '25', '15');
    expect(volume).not.toBeNull();
    expect((volume as Decimal).toFixed(4)).toBe('1000.0000');
  });

  it('handles a fractional contribution', () => {
    // contribution = 19.99 - 12.49 = 7.50; 45000 / 7.5 = 6000 units
    expect((breakEvenVolume('45000', '19.99', '12.49') as Decimal).toFixed(4)).toBe('6000.0000');
  });

  it('returns zero volume for zero fixed cost', () => {
    expect((breakEvenVolume('0', '25', '15') as Decimal).toFixed(4)).toBe('0.0000');
  });

  it('returns null when contribution is exactly zero', () => {
    expect(breakEvenVolume('10000', '15', '15')).toBeNull();
  });

  it('returns null when contribution is negative (price below variable cost)', () => {
    expect(breakEvenVolume('10000', '10', '15')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// contributionMarginRatio
// --------------------------------------------------------------------------

describe('contributionMarginRatio', () => {
  it('is (price - variable cost) / price', () => {
    // (25 - 15) / 25 = 10/25 = 0.4
    expect(contributionMarginRatio('25', '15')).toBe(0.4);
  });

  it('is 1 when there is no variable cost', () => {
    expect(contributionMarginRatio('25', '0')).toBe(1);
  });

  it('goes negative when variable cost exceeds price', () => {
    // (10 - 15) / 10 = -0.5
    expect(contributionMarginRatio('10', '15')).toBe(-0.5);
  });

  it('returns null when price is zero', () => {
    expect(contributionMarginRatio('0', '15')).toBeNull();
    expect(contributionMarginRatio('0', '0')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// expectedValue
// --------------------------------------------------------------------------

describe('expectedValue', () => {
  it('weights profit by win probability and nets off bid cost', () => {
    /*
     * price 1,000,000 at a 10% margin => profit 100,000
     *   expectedProfit  = 100,000 * 0.35 - 20,000 = 35,000 - 20,000 = 15,000
     *   expectedRevenue = 1,000,000 * 0.35 = 350,000
     *   breakEvenProbability = 20,000 / 100,000 = 0.20
     */
    const result = expectedValue('1000000', '0.10', 0.35, '20000');
    expect(result.expectedProfit).toBe('15000.0000');
    expect(result.expectedRevenue).toBe('350000.0000');
    expect(result.breakEvenProbability).toBe(0.2);
  });

  it('defaults bid cost to zero', () => {
    // profit 100,000 * 0.5 = 50,000; breakEvenProbability = 0/100,000 = 0
    const result = expectedValue('1000000', '0.10', 0.5);
    expect(result.expectedProfit).toBe('50000.0000');
    expect(result.expectedRevenue).toBe('500000.0000');
    expect(result.breakEvenProbability).toBe(0);
  });

  it('accepts the boundary probabilities 0 and 1', () => {
    // p = 0: expectedProfit = 0 - 20,000 = -20,000; expectedRevenue = 0
    const lost = expectedValue('1000000', '0.10', 0, '20000');
    expect(lost.expectedProfit).toBe('-20000.0000');
    expect(lost.expectedRevenue).toBe('0.0000');

    // p = 1: expectedProfit = 100,000 - 20,000 = 80,000; expectedRevenue = 1,000,000
    const won = expectedValue('1000000', '0.10', 1, '20000');
    expect(won.expectedProfit).toBe('80000.0000');
    expect(won.expectedRevenue).toBe('1000000.0000');
  });

  it('throws when the probability of win is outside [0, 1]', () => {
    expect(() => expectedValue('1000000', '0.10', -0.1)).toThrow(
      /Probability of win must lie between 0 and 1/,
    );
    expect(() => expectedValue('1000000', '0.10', 1.1)).toThrow(
      /Probability of win must lie between 0 and 1/,
    );
  });

  it('returns a null break-even probability when the pursuit carries no profit', () => {
    // margin 0 => profit 0 => no probability makes it worthwhile
    const result = expectedValue('1000000', '0', 0.35, '20000');
    expect(result.breakEvenProbability).toBeNull();
    expect(result.expectedProfit).toBe('-20000.0000'); // 0 * 0.35 - 20,000
    expect(result.expectedRevenue).toBe('350000.0000');
  });

  it('break-even probability is bidCost / profit', () => {
    // profit = 500,000 * 0.20 = 100,000; bidCost 45,000 => 0.45
    expect(expectedValue('500000', '0.20', 0.6, '45000').breakEvenProbability).toBe(0.45);
    // profit = 500,000 * 0.20 = 100,000; bidCost 125,000 => 1.25 (unwinnable on value)
    expect(expectedValue('500000', '0.20', 0.6, '125000').breakEvenProbability).toBe(1.25);
  });
});
