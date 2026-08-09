import { describe, expect, it } from 'vitest';
import { applyStaffingRamp, buildWorkforceForecast, type WorkforceDriver } from './workforce.js';

const driver = (over: Partial<WorkforceDriver> = {}): WorkforceDriver => ({
  code: 'CS_VOICE',
  name: 'Customer service - voice',
  volumes: [100000],
  averageHandleTimeSeconds: 300,
  occupancy: 0.8,
  shrinkage: 0.3,
  hoursPerFtePerPeriod: 160,
  costPerFtePerPeriod: '5000.00',
  ...over,
});

describe('buildWorkforceForecast', () => {
  it('derives FTE from volume, AHT, occupancy and shrinkage', () => {
    // workload hours       = 100,000 x 300s / 3600 = 8,333.3333 hours
    // productive hours/FTE = 160 x (1 - 0.30) x 0.80 = 89.6 hours
    // required FTE         = 8,333.3333 / 89.6      = 93.00595...
    const result = buildWorkforceForecast(driver());
    const p = result.periods[0];

    expect(Number(p?.workloadHours)).toBeCloseTo(8333.3333, 3);
    expect(Number(p?.productiveHoursPerFte)).toBeCloseTo(89.6, 6);
    // Serialised at the 4dp money scale, so 93.005952... stores as 93.0060.
    expect(p?.requiredFte).toBe('93.0060');
    expect(Number(p?.requiredFte)).toBeCloseTo(93.005952, 3);
  });

  it('treats shrinkage and occupancy as multiplicative, not interchangeable', () => {
    // 30% shrinkage AND 80% occupancy = 56% of paid time is productive.
    // Applying only one of them would give 70% or 80% and understate the need.
    const both = buildWorkforceForecast(driver());
    const shrinkageOnly = buildWorkforceForecast(driver({ occupancy: 1 }));
    const occupancyOnly = buildWorkforceForecast(driver({ shrinkage: 0 }));

    expect(Number(both.periods[0]?.productiveHoursPerFte)).toBeCloseTo(160 * 0.7 * 0.8, 6);
    expect(Number(shrinkageOnly.periods[0]?.productiveHoursPerFte)).toBeCloseTo(160 * 0.7, 6);
    expect(Number(occupancyOnly.periods[0]?.productiveHoursPerFte)).toBeCloseTo(160 * 0.8, 6);
    expect(Number(both.periods[0]?.requiredFte)).toBeGreaterThan(
      Number(shrinkageOnly.periods[0]?.requiredFte),
    );
  });

  it('costs the staffed FTE at the fully-loaded rate', () => {
    // 93.005952... FTE x 5,000 = 465,029.76...
    const result = buildWorkforceForecast(driver());
    expect(Number(result.periods[0]?.cost)).toBeCloseTo(93.005952 * 5000, 1);
  });

  it('computes cost per contact', () => {
    // 465,029.76 / 100,000 = 4.6503 per contact
    const result = buildWorkforceForecast(driver());
    expect(Number(result.periods[0]?.costPerUnit)).toBeCloseTo(4.650298, 4);
  });

  it('rounds up to whole people when asked, because part-hires do not exist', () => {
    const fractional = buildWorkforceForecast(driver());
    const whole = buildWorkforceForecast(driver({ roundToWholeFte: true }));

    expect(whole.periods[0]?.staffedFte).toBe(94); // ceil(93.0059)
    expect(Number(whole.periods[0]?.cost)).toBeGreaterThan(Number(fractional.periods[0]?.cost));
    expect(Number(whole.periods[0]?.cost)).toBeCloseTo(94 * 5000, 4);
  });

  it('compounds volume growth from period 0', () => {
    // Period 0 is as supplied; period 1 is x1.10.
    const result = buildWorkforceForecast(
      driver({ volumes: [100000, 100000], volumeGrowthRate: '0.10' }),
    );
    expect(result.periods[0]?.volume).toBeCloseTo(100000, 4);
    expect(result.periods[1]?.volume).toBeCloseTo(110000, 4);
  });

  it('compounds cost escalation from period 0', () => {
    const result = buildWorkforceForecast(
      driver({ volumes: [100000, 100000], costEscalationRate: '0.05' }),
    );
    // Same FTE both periods, cost 5% higher in period 2.
    expect(Number(result.periods[1]?.cost) / Number(result.periods[0]?.cost)).toBeCloseTo(1.05, 9);
  });

  it('reports peak and average FTE across the horizon', () => {
    const result = buildWorkforceForecast(
      driver({ volumes: [100000, 200000, 100000], roundToWholeFte: true }),
    );
    expect(result.peakFte).toBe(187); // ceil(186.0119)
    expect(result.averageFte).toBeCloseTo((94 + 187 + 94) / 3, 3);
  });

  it('reports a blended cost per contact across the horizon', () => {
    const result = buildWorkforceForecast(driver({ volumes: [100000, 100000] }));
    expect(Number(result.blendedCostPerUnit)).toBeCloseTo(4.650298, 4);
  });

  it('returns its assumptions so the model can be defended', () => {
    const result = buildWorkforceForecast(driver());
    expect(result.assumptions.occupancy).toBe(0.8);
    expect(result.assumptions.shrinkage).toBe(0.3);
    expect(result.assumptions.productiveHoursPerFte).toBeCloseTo(89.6, 4);
  });

  it('warns about an unachievable occupancy', () => {
    const result = buildWorkforceForecast(driver({ occupancy: 0.95 }));
    expect(result.warnings.join(' ')).toMatch(/occupancy/i);
  });

  it('warns about implausibly low shrinkage', () => {
    const result = buildWorkforceForecast(driver({ shrinkage: 0.05 }));
    expect(result.warnings.join(' ')).toMatch(/shrinkage/i);
  });

  it('rejects impossible parameters', () => {
    expect(() => buildWorkforceForecast(driver({ occupancy: 0 }))).toThrow(/occupancy/);
    expect(() => buildWorkforceForecast(driver({ occupancy: 1.2 }))).toThrow(/occupancy/);
    expect(() => buildWorkforceForecast(driver({ shrinkage: 1 }))).toThrow(/shrinkage/);
    expect(() => buildWorkforceForecast(driver({ shrinkage: -0.1 }))).toThrow(/shrinkage/);
    expect(() => buildWorkforceForecast(driver({ averageHandleTimeSeconds: 0 }))).toThrow(
      /handle time/,
    );
    expect(() => buildWorkforceForecast(driver({ volumes: [] }))).toThrow(/no volumes/);
    expect(() => buildWorkforceForecast(driver({ volumes: [-5] }))).toThrow(
      /negative or non-finite/,
    );
    expect(() => buildWorkforceForecast(driver({ hoursPerFtePerPeriod: 0 }))).toThrow(
      /hours per FTE/,
    );
  });

  it('handles a zero-volume period without dividing by zero', () => {
    const result = buildWorkforceForecast(driver({ volumes: [0] }));
    expect(Number(result.periods[0]?.requiredFte)).toBe(0);
    expect(result.periods[0]?.costPerUnit).toBeNull();
  });
});

describe('applyStaffingRamp', () => {
  it('needs more heads than the gap when new hires are only half productive', () => {
    // Requirement 10 FTE; a new hire contributes 0.5 during ramp, so 20 must start.
    const result = applyStaffingRamp([10], {
      leadTimePeriods: 0,
      rampPeriods: 2,
      rampProductivity: 0.5,
    });
    expect(result.periods[0]?.hiredFte).toBeCloseTo(20, 4);
    expect(result.periods[0]?.effectiveFte).toBeCloseTo(10, 4);
  });

  it('brings hires to full productivity once the ramp completes', () => {
    // 20 hired in period 1 at 0.5 productivity; from period 3 they count fully,
    // so effective capacity is 20 against a requirement of 10.
    const result = applyStaffingRamp([10, 10, 10], {
      leadTimePeriods: 0,
      rampPeriods: 2,
      rampProductivity: 0.5,
    });
    expect(result.periods[2]?.effectiveFte).toBeCloseTo(20, 4);
    expect(result.periods[2]?.hiredFte).toBeCloseTo(0, 4);
  });

  it('hires nobody when there is no requirement', () => {
    const result = applyStaffingRamp([0, 0], { leadTimePeriods: 0, rampPeriods: 1 });
    expect(result.totalHired).toBe(0);
    expect(result.shortfallPeriods).toBe(0);
  });

  it('needs no uplift when there is no ramp', () => {
    const result = applyStaffingRamp([10], { leadTimePeriods: 0, rampPeriods: 0 });
    expect(result.periods[0]?.hiredFte).toBeCloseTo(10, 4);
  });

  it('warns when demand lands inside the recruitment lead time', () => {
    const result = applyStaffingRamp([10, 10], { leadTimePeriods: 2, rampPeriods: 1 });
    expect(result.warnings.join(' ')).toMatch(/could not have been recruited in time/);
  });

  it('does not warn when demand starts after the lead time', () => {
    const result = applyStaffingRamp([0, 0, 10], { leadTimePeriods: 2, rampPeriods: 1 });
    expect(result.warnings).toHaveLength(0);
  });

  it('meets a rising requirement in every period', () => {
    const result = applyStaffingRamp([10, 20, 30], {
      leadTimePeriods: 0,
      rampPeriods: 1,
      rampProductivity: 0.5,
    });
    for (const period of result.periods) {
      expect(period.effectiveFte).toBeGreaterThanOrEqual(period.requiredFte - 1e-6);
    }
    expect(result.shortfallPeriods).toBe(0);
  });

  it('rejects invalid ramp parameters', () => {
    expect(() => applyStaffingRamp([1], { leadTimePeriods: -1, rampPeriods: 1 })).toThrow(
      /Lead time/,
    );
    expect(() => applyStaffingRamp([1], { leadTimePeriods: 0, rampPeriods: 1.5 })).toThrow(
      /Ramp duration/,
    );
    expect(() =>
      applyStaffingRamp([1], { leadTimePeriods: 0, rampPeriods: 1, rampProductivity: 2 }),
    ).toThrow(/Ramp productivity/);
  });
});
