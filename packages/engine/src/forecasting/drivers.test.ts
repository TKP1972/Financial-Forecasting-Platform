import { describe, expect, it } from 'vitest';
import {
  applyScenario,
  buildDriverBundle,
  buildDriverForecast,
  compareScenarios,
  type DriverDefinition,
} from './drivers.js';

const subscribers: DriverDefinition = {
  code: 'SUBS',
  name: 'Subscribers',
  unit: 'subscribers',
  volumes: ['1000', '1000', '1000'],
  unitRate: '25.00',
};

describe('buildDriverForecast', () => {
  it('multiplies volume by rate for each period', () => {
    const result = buildDriverForecast(subscribers);
    expect(result.periods).toHaveLength(3);
    expect(result.periods[0]?.amount).toBe('25000.0000');
    expect(result.total).toBe('75000.0000');
    expect(result.unit).toBe('subscribers');
  });

  it('applies no growth in period 0', () => {
    // The factor is (1+r)^0 = 1, so the first period is exactly as entered.
    const result = buildDriverForecast({ ...subscribers, volumeGrowthRate: '0.10' });
    expect(result.periods[0]?.volume).toBe('1000.0000');
    expect(result.periods[0]?.amount).toBe('25000.0000');
  });

  it('compounds volume growth from period 0', () => {
    // 1000 x 1.1^1 = 1100 ; 1000 x 1.1^2 = 1210
    const result = buildDriverForecast({ ...subscribers, volumeGrowthRate: '0.10' });
    expect(result.periods[1]?.volume).toBe('1100.0000');
    expect(result.periods[2]?.volume).toBe('1210.0000');
    expect(result.periods[2]?.amount).toBe('30250.0000');
  });

  it('compounds rate escalation from period 0', () => {
    // 25 x 1.04^1 = 26 ; 25 x 1.04^2 = 27.04
    const result = buildDriverForecast({ ...subscribers, rateEscalationRate: '0.04' });
    expect(result.periods[0]?.unitRate).toBe('25.000000');
    expect(result.periods[1]?.unitRate).toBe('26.000000');
    expect(result.periods[2]?.unitRate).toBe('27.040000');
    expect(result.periods[2]?.amount).toBe('27040.0000');
  });

  it('compounds growth and escalation together', () => {
    // Period 2: volume 1000 x 1.1^2 = 1210, rate 25 x 1.04^2 = 27.04
    // 1210 x 27.04 = 32,718.40
    const result = buildDriverForecast({
      ...subscribers,
      volumeGrowthRate: '0.10',
      rateEscalationRate: '0.04',
    });
    expect(result.periods[2]?.amount).toBe('32718.4000');
  });

  it('accepts a rate per period', () => {
    const result = buildDriverForecast({
      ...subscribers,
      unitRate: ['25.00', '30.00', '35.00'],
    });
    expect(result.periods[0]?.amount).toBe('25000.0000');
    expect(result.periods[1]?.amount).toBe('30000.0000');
    expect(result.periods[2]?.amount).toBe('35000.0000');
    expect(result.total).toBe('90000.0000');
  });

  it('rejects a rate schedule that does not match the period count', () => {
    expect(() => buildDriverForecast({ ...subscribers, unitRate: ['25.00', '30.00'] })).toThrow(
      /2 unit rates for 3 periods/,
    );
  });

  it('rejects a driver with no volumes', () => {
    expect(() => buildDriverForecast({ ...subscribers, volumes: [] })).toThrow(/no volumes/i);
  });

  it('defaults the unit label', () => {
    const { unit, ...withoutUnit } = subscribers;
    void unit;
    expect(buildDriverForecast(withoutUnit).unit).toBe('units');
  });
});

describe('buildDriverBundle', () => {
  const fibre: DriverDefinition = {
    code: 'FIBRE',
    name: 'Fibre premises',
    volumes: ['500', '500', '500'],
    unitRate: '40.00',
  };

  it('totals each period across drivers', () => {
    const bundle = buildDriverBundle([subscribers, fibre]);
    // 25,000 + 20,000 per period.
    expect(bundle.periodTotals).toEqual(['45000.0000', '45000.0000', '45000.0000']);
    expect(bundle.grandTotal).toBe('135000.0000');
    expect(bundle.drivers).toHaveLength(2);
  });

  it('handles drivers of differing lengths by treating absent periods as zero', () => {
    const short: DriverDefinition = {
      code: 'S',
      name: 'Short',
      volumes: ['100'],
      unitRate: '10.00',
    };
    const bundle = buildDriverBundle([subscribers, short]);
    expect(bundle.periodTotals[0]).toBe('26000.0000');
    expect(bundle.periodTotals[1]).toBe('25000.0000');
  });

  it('returns an empty bundle for no drivers', () => {
    const bundle = buildDriverBundle([]);
    expect(bundle.drivers).toHaveLength(0);
    expect(bundle.periodTotals).toHaveLength(0);
    expect(bundle.grandTotal).toBe('0.0000');
  });
});

describe('applyScenario', () => {
  it('scales every driver when no target is named', () => {
    const result = applyScenario([subscribers], {
      name: 'Uplift',
      adjustments: [{ factor: '1.10' }],
    });
    expect(result.grandTotal).toBe('82500.0000');
    expect(result.deltaFromBase).toBe('7500.0000');
    expect(result.deltaPercent).toBeCloseTo(0.1, 10);
  });

  it('composes multiple adjustments multiplicatively', () => {
    // Two +10% adjustments give +21%, not +20%: 75,000 x 1.1 x 1.1 = 90,750.
    const result = applyScenario([subscribers], {
      name: 'Stacked',
      adjustments: [{ factor: '1.10' }, { factor: '1.10' }],
    });
    expect(result.grandTotal).toBe('90750.0000');
    expect(result.deltaPercent).toBeCloseTo(0.21, 10);
  });

  it('only adjusts the named driver', () => {
    const fibre: DriverDefinition = {
      code: 'FIBRE',
      name: 'Fibre',
      volumes: ['500', '500', '500'],
      unitRate: '40.00',
    };
    const result = applyScenario([subscribers, fibre], {
      name: 'Subs only',
      adjustments: [{ targetCode: 'SUBS', factor: '1.20' }],
    });
    // Subs 75,000 x 1.2 = 90,000 ; fibre unchanged at 60,000.
    expect(result.grandTotal).toBe('150000.0000');
  });

  it('applies an adjustment only from the stated period onward', () => {
    // Periods 1 and 2 stay at 25,000; period 3 becomes 30,000.
    const result = applyScenario([subscribers], {
      name: 'Late uplift',
      adjustments: [{ factor: '1.20', appliesFromPeriod: 3 }],
    });
    expect(result.periodTotals).toEqual(['25000.0000', '25000.0000', '30000.0000']);
    expect(result.grandTotal).toBe('80000.0000');
  });

  it('treats period 1 as the default start', () => {
    const explicit = applyScenario([subscribers], {
      name: 'a',
      adjustments: [{ factor: '1.15', appliesFromPeriod: 1 }],
    });
    const implicit = applyScenario([subscribers], {
      name: 'b',
      adjustments: [{ factor: '1.15' }],
    });
    expect(explicit.grandTotal).toBe(implicit.grandTotal);
  });

  it('handles a downside factor', () => {
    const result = applyScenario([subscribers], {
      name: 'Downside',
      adjustments: [{ factor: '0.85' }],
    });
    expect(result.grandTotal).toBe('63750.0000');
    expect(result.deltaPercent).toBeCloseTo(-0.15, 10);
  });

  it('carries the scenario metadata through', () => {
    const result = applyScenario([subscribers], {
      name: 'Best case',
      type: 'BEST',
      probability: 0.25,
      adjustments: [],
    });
    expect(result.name).toBe('Best case');
    expect(result.type).toBe('BEST');
    expect(result.probability).toBe(0.25);
    expect(result.deltaFromBase).toBe('0.0000');
  });

  it('defaults the type to CUSTOM', () => {
    expect(applyScenario([subscribers], { name: 'x', adjustments: [] }).type).toBe('CUSTOM');
  });
});

describe('compareScenarios', () => {
  it('computes a probability-weighted expected value', () => {
    // 0.25 x 90,000 + 0.50 x 75,000 + 0.25 x 60,000 = 22,500 + 37,500 + 15,000 = 75,000
    const comparison = compareScenarios(
      [subscribers],
      [
        { name: 'Best', type: 'BEST', probability: 0.25, adjustments: [{ factor: '1.20' }] },
        { name: 'Base', type: 'BASE', probability: 0.5, adjustments: [{ factor: '1.00' }] },
        { name: 'Worst', type: 'WORST', probability: 0.25, adjustments: [{ factor: '0.80' }] },
      ],
    );
    expect(comparison.probabilityCoverage).toBeCloseTo(1, 10);
    expect(comparison.expectedValue).toBe('75000.0000');
  });

  it('normalises when the probabilities do not sum to one', () => {
    // Weights 0.3 and 0.3 sum to 0.6; the expected value must be normalised by
    // that coverage rather than being silently scaled down.
    const comparison = compareScenarios(
      [subscribers],
      [
        { name: 'A', probability: 0.3, adjustments: [{ factor: '1.00' }] },
        { name: 'B', probability: 0.3, adjustments: [{ factor: '2.00' }] },
      ],
    );
    expect(comparison.probabilityCoverage).toBeCloseTo(0.6, 10);
    // (0.3 x 75,000 + 0.3 x 150,000) / 0.6 = 112,500
    expect(comparison.expectedValue).toBe('112500.0000');
  });

  it('withholds an expected value when any scenario lacks a probability', () => {
    const comparison = compareScenarios(
      [subscribers],
      [
        { name: 'A', probability: 0.5, adjustments: [] },
        { name: 'B', adjustments: [{ factor: '1.20' }] },
      ],
    );
    expect(comparison.expectedValue).toBeNull();
  });

  it('returns the unadjusted base alongside the scenarios', () => {
    const comparison = compareScenarios(
      [subscribers],
      [{ name: 'A', adjustments: [{ factor: '1.50' }] }],
    );
    expect(comparison.base.grandTotal).toBe('75000.0000');
    expect(comparison.scenarios[0]?.grandTotal).toBe('112500.0000');
  });

  it('handles no scenarios at all', () => {
    const comparison = compareScenarios([subscribers], []);
    expect(comparison.scenarios).toHaveLength(0);
    expect(comparison.expectedValue).toBeNull();
    expect(comparison.probabilityCoverage).toBe(0);
  });
});
