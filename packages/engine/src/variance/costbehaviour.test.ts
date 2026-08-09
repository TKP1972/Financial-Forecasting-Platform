import { describe, expect, it } from 'vitest';
import {
  analyseContribution,
  analyseCostBehaviour,
  flexBudget,
  type CostLine,
} from './costbehaviour.js';

const lines: CostLine[] = [
  {
    key: 'a',
    label: 'Access circuits',
    amount: '400000',
    spendCategory: 'ACCESS',
    behaviour: 'VARIABLE',
  },
  {
    key: 'b',
    label: 'Site power',
    amount: '300000',
    spendCategory: 'FACILITIES',
    behaviour: 'FIXED',
  },
  {
    key: 'c',
    label: 'Field labour',
    amount: '200000',
    spendCategory: 'LABOUR',
    behaviour: 'SEMI_VARIABLE',
    variableShare: 0.6,
  },
];

describe('analyseCostBehaviour', () => {
  it('splits each line by its declared behaviour', () => {
    // a: 400,000 all variable
    // b: 300,000 all fixed
    // c: 200,000 x 0.6 = 120,000 variable, 80,000 fixed
    const summary = analyseCostBehaviour(lines);

    expect(summary.lines[0]?.variableAmount).toBe('400000.0000');
    expect(summary.lines[0]?.fixedAmount).toBe('0.0000');
    expect(summary.lines[1]?.fixedAmount).toBe('300000.0000');
    expect(summary.lines[2]?.variableAmount).toBe('120000.0000');
    expect(summary.lines[2]?.fixedAmount).toBe('80000.0000');
  });

  it('totals fixed and variable so they sum back to the whole', () => {
    // fixed 300,000 + 80,000 = 380,000 ; variable 400,000 + 120,000 = 520,000
    const summary = analyseCostBehaviour(lines);
    expect(summary.total).toBe('900000.0000');
    expect(summary.totalFixed).toBe('380000.0000');
    expect(summary.totalVariable).toBe('520000.0000');
    expect(Number(summary.totalFixed) + Number(summary.totalVariable)).toBeCloseTo(
      Number(summary.total),
      6,
    );
  });

  it('computes the fixed ratio', () => {
    // 380,000 / 900,000 = 0.42222...
    expect(analyseCostBehaviour(lines).fixedRatio).toBeCloseTo(380000 / 900000, 10);
  });

  it('falls back to the category default and marks the line as assumed', () => {
    // EQUIPMENT defaults to FIXED.
    const summary = analyseCostBehaviour([
      { key: 'x', label: 'Routers', amount: '1000', spendCategory: 'EQUIPMENT' },
    ]);
    expect(summary.lines[0]?.behaviour).toBe('FIXED');
    expect(summary.lines[0]?.assumed).toBe(true);
    expect(summary.assumedLineCount).toBe(1);
    expect(summary.observations.join(' ')).toMatch(/inferred from the spend category/);
  });

  it('assumes a half split for a semi-variable line with no declared share', () => {
    const summary = analyseCostBehaviour([
      { key: 'x', label: 'Transport', amount: '1000', spendCategory: 'TRANSPORT' },
    ]);
    expect(summary.lines[0]?.behaviour).toBe('SEMI_VARIABLE');
    expect(summary.lines[0]?.fixedAmount).toBe('500.0000');
    expect(summary.lines[0]?.assumed).toBe(true);
  });

  it('does not mark an explicitly declared split as assumed', () => {
    const summary = analyseCostBehaviour([
      {
        key: 'x',
        label: 'T',
        amount: '1000',
        spendCategory: 'TRANSPORT',
        behaviour: 'SEMI_VARIABLE',
        variableShare: 0.25,
      },
    ]);
    expect(summary.lines[0]?.assumed).toBe(false);
    expect(summary.lines[0]?.variableAmount).toBe('250.0000');
  });

  it('defaults an absent spend category to OTHER', () => {
    const summary = analyseCostBehaviour([{ key: 'x', label: 'X', amount: '100' }]);
    expect(summary.lines[0]?.spendCategory).toBe('OTHER');
    expect(summary.lines[0]?.behaviour).toBe('FIXED');
  });

  it('rejects a variable share outside [0,1]', () => {
    expect(() =>
      analyseCostBehaviour([
        { key: 'x', label: 'X', amount: '100', behaviour: 'SEMI_VARIABLE', variableShare: 60 },
      ]),
    ).toThrow(/fraction of the line, not a percentage/);
  });

  it('groups by category, largest first', () => {
    const summary = analyseCostBehaviour(lines);
    expect(summary.byCategory[0]?.category).toBe('ACCESS');
    expect(summary.byCategory[0]?.amount).toBe('400000.0000');
  });

  it('reports all three behaviours even when unused', () => {
    const summary = analyseCostBehaviour([
      { key: 'x', label: 'X', amount: '100', behaviour: 'FIXED' },
    ]);
    expect(summary.byBehaviour).toHaveLength(3);
    expect(summary.byBehaviour.find((b) => b.behaviour === 'VARIABLE')?.amount).toBe('0.0000');
  });

  it('flags a heavily fixed cost base', () => {
    const summary = analyseCostBehaviour([
      { key: 'f', label: 'F', amount: '900', behaviour: 'FIXED' },
      { key: 'v', label: 'V', amount: '100', behaviour: 'VARIABLE' },
    ]);
    expect(summary.observations.join(' ')).toMatch(/fixed.*structural decisions/i);
  });

  it('flags a heavily variable cost base', () => {
    const summary = analyseCostBehaviour([
      { key: 'f', label: 'F', amount: '100', behaviour: 'FIXED' },
      { key: 'v', label: 'V', amount: '900', behaviour: 'VARIABLE' },
    ]);
    expect(summary.observations.join(' ')).toMatch(/scale gains will be limited/i);
  });

  it('handles an empty set without dividing by zero', () => {
    const summary = analyseCostBehaviour([]);
    expect(summary.total).toBe('0.0000');
    expect(summary.fixedRatio).toBeNull();
  });
});

describe('analyseContribution', () => {
  it('computes contribution, margin and operating profit', () => {
    // revenue 1,000,000 ; variable 520,000 ; fixed 380,000
    // contribution      = 480,000  -> margin 0.48
    // operating profit  = 100,000  -> margin 0.10
    const result = analyseContribution('1000000', lines);

    expect(result.contribution).toBe('480000.0000');
    expect(result.contributionMargin).toBeCloseTo(0.48, 10);
    expect(result.operatingProfit).toBe('100000.0000');
    expect(result.operatingMargin).toBeCloseTo(0.1, 10);
  });

  it('computes break-even revenue from fixed cost and contribution margin', () => {
    // 380,000 / 0.48 = 791,666.6667
    const result = analyseContribution('1000000', lines);
    expect(Number(result.breakEvenRevenue)).toBeCloseTo(791666.6667, 3);
  });

  it('computes the margin of safety', () => {
    // (1,000,000 - 791,666.67) / 1,000,000 = 0.2083
    const result = analyseContribution('1000000', lines);
    expect(result.marginOfSafety).toBeCloseTo(0.2083333, 5);
  });

  it('computes operating leverage', () => {
    // contribution 480,000 / operating profit 100,000 = 4.8x
    const result = analyseContribution('1000000', lines);
    expect(result.operatingLeverage).toBeCloseTo(4.8, 9);
    expect(result.observations.join(' ')).toMatch(/Operating leverage is 4.8x/);
  });

  it('has no break-even when contribution margin is not positive', () => {
    // Variable cost exceeds revenue, so no volume ever covers the fixed base.
    const result = analyseContribution('100', [
      { key: 'v', label: 'V', amount: '150', behaviour: 'VARIABLE' },
      { key: 'f', label: 'F', amount: '50', behaviour: 'FIXED' },
    ]);
    expect(result.contributionMargin).toBeCloseTo(-0.5, 10);
    expect(result.breakEvenRevenue).toBeNull();
    expect(result.marginOfSafety).toBeNull();
    expect(result.observations.join(' ')).toMatch(/no break-even volume/i);
  });

  it('flags revenue below break-even', () => {
    // At revenue 700,000: contribution = 700,000 - 520,000 = 180,000, so the
    // margin is 0.2571 and break-even rises to 380,000 / 0.2571 = 1,477,778.
    // Revenue is well under that, so the operation is loss-making.
    const result = analyseContribution('700000', lines);
    expect(result.operatingProfit).toBe('-200000.0000');
    expect(result.marginOfSafety as number).toBeLessThan(0);
    expect(result.observations.join(' ')).toMatch(/loss-making/i);
  });

  it('flags a thin margin of safety', () => {
    // Solving 1 - fixed/(revenue - variable) = 0.05 with fixed 380,000 and
    // variable 520,000 gives revenue = 920,000.
    //   contribution = 400,000 -> margin 0.434783
    //   break-even   = 380,000 / 0.434783 = 874,000
    //   margin of safety = (920,000 - 874,000) / 920,000 = 0.05
    const result = analyseContribution('920000', lines);
    expect(Number(result.breakEvenRevenue)).toBeCloseTo(874000, 2);
    expect(result.marginOfSafety).toBeCloseTo(0.05, 9);
    expect(result.observations.join(' ')).toMatch(/above break-even/i);
  });

  it('returns null margins on zero revenue', () => {
    const result = analyseContribution('0', lines);
    expect(result.contributionMargin).toBeNull();
    expect(result.operatingMargin).toBeNull();
    expect(result.marginOfSafety).toBeNull();
  });
});

describe('flexBudget', () => {
  it('flexes only the variable element to actual volume', () => {
    // Volume ran 20% above plan.
    //   fixed 380,000 unchanged
    //   variable 520,000 x 1.2 = 624,000
    //   flexed total = 1,004,000 against an original 900,000
    const result = flexBudget(lines, 1000, 1200);

    expect(result.volumeRatio).toBeCloseTo(1.2, 10);
    expect(result.originalBudget).toBe('900000.0000');
    expect(result.flexedBudget).toBe('1004000.0000');
    expect(result.flexAdjustment).toBe('104000.0000');
  });

  it('leaves a purely fixed budget untouched by volume', () => {
    const result = flexBudget(
      [{ key: 'f', label: 'F', amount: '1000', behaviour: 'FIXED' }],
      100,
      200,
    );
    expect(result.flexedBudget).toBe('1000.0000');
    expect(result.flexAdjustment).toBe('0.0000');
  });

  it('scales a purely variable budget in proportion', () => {
    const result = flexBudget(
      [{ key: 'v', label: 'V', amount: '1000', behaviour: 'VARIABLE' }],
      100,
      150,
    );
    expect(result.flexedBudget).toBe('1500.0000');
  });

  it('flexes downward when volume falls short', () => {
    const result = flexBudget(lines, 1000, 800);
    // variable 520,000 x 0.8 = 416,000 ; + 380,000 fixed = 796,000
    expect(result.flexedBudget).toBe('796000.0000');
    expect(Number(result.flexAdjustment)).toBeLessThan(0);
  });

  it('rejects a zero budgeted volume', () => {
    expect(() => flexBudget(lines, 0, 100)).toThrow(/zero budgeted volume/);
  });

  it('returns a per-line breakdown', () => {
    const result = flexBudget(lines, 1000, 1200);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[1]?.flexed).toBe('300000.0000'); // fixed line unchanged
  });
});
