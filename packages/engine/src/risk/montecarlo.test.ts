import { describe, expect, it } from 'vitest';
import { contingencyAt, runMonteCarlo, type MonteCarloConfig } from './montecarlo.js';

const config = (over: Partial<MonteCarloConfig> = {}): MonteCarloConfig => ({
  name: 'Test simulation',
  iterations: 10000,
  seed: 20260101,
  baseValue: '1000000',
  inputs: [
    { code: 'a', label: 'Input A', distribution: 'TRIANGULAR', min: 0, mode: 50000, max: 150000 },
  ],
  ...over,
});

describe('reproducibility', () => {
  // This is a governance requirement, not a nicety: a published contingency
  // figure has to be re-derivable months later during an audit.
  it('produces identical output for the same seed', () => {
    const a = runMonteCarlo(config());
    const b = runMonteCarlo(config());

    expect(a.mean).toBe(b.mean);
    expect(a.median).toBe(b.median);
    expect(a.standardDeviation).toBe(b.standardDeviation);
    expect(a.contingency).toBe(b.contingency);
    expect(a.min).toBe(b.min);
    expect(a.max).toBe(b.max);
    expect(a.percentiles).toEqual(b.percentiles);
  });

  it('diverges for a different seed', () => {
    const a = runMonteCarlo(config({ seed: 1 }));
    const b = runMonteCarlo(config({ seed: 2 }));
    expect(a.mean).not.toBe(b.mean);
  });

  it('reports the seed it used, so the run can be repeated', () => {
    expect(runMonteCarlo(config({ seed: 4242 })).seed).toBe(4242);
  });

  it('stays reproducible with risk events folded in', () => {
    const withEvents = config({
      riskEvents: [
        {
          label: 'Outage',
          probability: 0.2,
          impactMin: 10000,
          impactMode: 40000,
          impactMax: 120000,
        },
      ],
    });
    expect(runMonteCarlo(withEvents).contingency).toBe(runMonteCarlo(withEvents).contingency);
  });
});

describe('validation', () => {
  it('rejects iteration counts outside the supported range', () => {
    expect(() => runMonteCarlo(config({ iterations: 99 }))).toThrow(/between 100 and/i);
    expect(() => runMonteCarlo(config({ iterations: 1_000_001 }))).toThrow(/between 100 and/i);
  });

  it('warns when the iteration count is too low for a publishable tail', () => {
    const result = runMonteCarlo(config({ iterations: 1000 }));
    expect(result.warnings.join(' ')).toMatch(/noisy tail/i);
  });

  it('does not warn at a sufficient iteration count', () => {
    const result = runMonteCarlo(config({ iterations: 10000, useLatinHypercube: false }));
    expect(result.warnings.join(' ')).not.toMatch(/noisy tail/i);
  });

  it('refuses to run with nothing uncertain', () => {
    expect(() => runMonteCarlo(config({ inputs: [], riskEvents: [] }))).toThrow(
      /at least one uncertain input/i,
    );
  });

  it('rejects a risk event probability outside [0,1]', () => {
    expect(() =>
      runMonteCarlo(
        config({
          riskEvents: [
            { label: 'Bad', probability: 1.5, impactMin: 0, impactMode: 1, impactMax: 2 },
          ],
        }),
      ),
    ).toThrow(/probability outside/i);
  });

  it('rejects an inconsistent three-point estimate', () => {
    expect(() =>
      runMonteCarlo(
        config({
          riskEvents: [
            { label: 'Bad', probability: 0.5, impactMin: 100, impactMode: 10, impactMax: 200 },
          ],
        }),
      ),
    ).toThrow(/inconsistent three-point/i);
  });

  it('warns that some distributions are not stratified', () => {
    const result = runMonteCarlo(
      config({
        inputs: [{ code: 'n', label: 'Normal', distribution: 'NORMAL', mean: 1000, stdDev: 100 }],
        useLatinHypercube: true,
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/not stratified/i);
  });
});

describe('statistical behaviour', () => {
  it('recovers the mean of a uniform input', () => {
    // UNIFORM(0,100) on a zero base has an expected mean of 50.
    const result = runMonteCarlo(
      config({
        baseValue: '0',
        iterations: 50000,
        inputs: [{ code: 'u', label: 'U', distribution: 'UNIFORM', min: 0, max: 100 }],
      }),
    );
    expect(Number(result.mean)).toBeGreaterThan(48);
    expect(Number(result.mean)).toBeLessThan(52);
    expect(Number(result.median)).toBeGreaterThan(48);
    expect(Number(result.median)).toBeLessThan(52);
  });

  it('is degenerate for a certain discrete outcome', () => {
    const result = runMonteCarlo(
      config({
        baseValue: '1000',
        inputs: [
          {
            code: 'd',
            label: 'Certain',
            distribution: 'DISCRETE',
            outcomes: [{ value: 250, probability: 1 }],
          },
        ],
      }),
    );
    expect(result.mean).toBe('1250.0000');
    expect(result.standardDeviation).toBe('0.0000');
    expect(result.min).toBe('1250.0000');
    expect(result.max).toBe('1250.0000');
  });

  it('keeps percentiles monotonically non-decreasing', () => {
    const result = runMonteCarlo(config({ confidenceLevels: [0.05, 0.1, 0.5, 0.8, 0.9, 0.95] }));
    for (let i = 1; i < result.percentiles.length; i += 1) {
      expect(Number(result.percentiles[i]?.value)).toBeGreaterThanOrEqual(
        Number(result.percentiles[i - 1]?.value),
      );
    }
  });

  it('labels percentiles conventionally', () => {
    const result = runMonteCarlo(config({ confidenceLevels: [0.5, 0.8] }));
    expect(result.percentiles.map((p) => p.label)).toEqual(['P50', 'P80']);
  });

  it('bounds every outcome by the input range', () => {
    // base 1,000,000 + TRIANGULAR(0, 50k, 150k) can never leave [1.0m, 1.15m].
    const result = runMonteCarlo(config());
    expect(Number(result.min)).toBeGreaterThanOrEqual(1_000_000);
    expect(Number(result.max)).toBeLessThanOrEqual(1_150_000);
  });
});

describe('contingency', () => {
  it('is the gap between P80 and the deterministic estimate', () => {
    const result = runMonteCarlo(config());
    const p80 = result.percentiles.find((p) => p.level === 0.8);
    const expected = Number(p80?.value) - Number(result.deterministicEstimate);
    expect(Number(result.contingency)).toBeCloseTo(expected, 3);
  });

  it('uses the analytic mean for the deterministic estimate', () => {
    // Triangular mean = (0 + 50,000 + 150,000)/3 = 66,666.67 on top of 1,000,000.
    const result = runMonteCarlo(config());
    expect(Number(result.deterministicEstimate)).toBeCloseTo(1_066_666.6667, 3);
  });

  it('recomputes contingency at another confidence level', () => {
    const result = runMonteCarlo(config({ confidenceLevels: [0.5, 0.8, 0.9] }));
    const at90 = contingencyAt(result, 0.9);
    expect(Number(at90)).toBeGreaterThan(Number(result.contingency));
  });

  it('refuses a level that was not computed', () => {
    const result = runMonteCarlo(config({ confidenceLevels: [0.5, 0.8] }));
    expect(() => contingencyAt(result, 0.99)).toThrow(/was not computed/i);
  });

  it('reports the chance of landing at or below the deterministic estimate', () => {
    const result = runMonteCarlo(config());
    expect(result.probabilityOfUnderrun).toBeGreaterThan(0);
    expect(result.probabilityOfUnderrun).toBeLessThan(1);
  });
});

describe('histogram', () => {
  it('accounts for every iteration', () => {
    const result = runMonteCarlo(config({ iterations: 10000 }));
    const total = result.histogram.reduce((acc, bin) => acc + bin.count, 0);
    expect(total).toBe(10000);
  });

  it('has frequencies summing to one', () => {
    const result = runMonteCarlo(config());
    const total = result.histogram.reduce((acc, bin) => acc + bin.frequency, 0);
    expect(total).toBeCloseTo(1, 8);
  });

  it('collapses to a single bin for a degenerate distribution', () => {
    const result = runMonteCarlo(
      config({
        inputs: [
          {
            code: 'd',
            label: 'Fixed',
            distribution: 'DISCRETE',
            outcomes: [{ value: 100, probability: 1 }],
          },
        ],
      }),
    );
    expect(result.histogram).toHaveLength(1);
    expect(result.histogram[0]?.frequency).toBe(1);
  });
});

describe('sensitivity', () => {
  it('ranks a dominant driver above a near-constant one', () => {
    const result = runMonteCarlo(
      config({
        baseValue: '0',
        iterations: 20000,
        inputs: [
          { code: 'big', label: 'Big driver', distribution: 'UNIFORM', min: 0, max: 1_000_000 },
          { code: 'small', label: 'Small driver', distribution: 'UNIFORM', min: 0, max: 100 },
        ],
      }),
    );
    expect(result.sensitivity[0]?.code).toBe('big');
    expect(result.sensitivity[0]?.contribution).toBeGreaterThan(
      result.sensitivity[1]?.contribution as number,
    );
    expect(result.sensitivity[0]?.correlation).toBeGreaterThan(0.8);
  });

  it('normalises contributions to sum to one', () => {
    const result = runMonteCarlo(
      config({
        inputs: [
          { code: 'a', label: 'A', distribution: 'UNIFORM', min: 0, max: 100 },
          { code: 'b', label: 'B', distribution: 'UNIFORM', min: 0, max: 200 },
          { code: 'c', label: 'C', distribution: 'TRIANGULAR', min: 0, mode: 50, max: 300 },
        ],
      }),
    );
    const total = result.sensitivity.reduce((acc, s) => acc + s.contribution, 0);
    expect(total).toBeCloseTo(1, 8);
  });

  it('includes risk events alongside continuous inputs', () => {
    const result = runMonteCarlo(
      config({
        riskEvents: [
          {
            label: 'Outage',
            probability: 0.3,
            impactMin: 0,
            impactMode: 100000,
            impactMax: 400000,
          },
        ],
      }),
    );
    expect(result.sensitivity).toHaveLength(2);
    expect(result.sensitivity.map((s) => s.label)).toContain('Outage');
  });
});

describe('risk events', () => {
  it('adds nothing when the event cannot occur', () => {
    const withZero = runMonteCarlo(
      config({
        riskEvents: [
          { label: 'Never', probability: 0, impactMin: 0, impactMode: 500000, impactMax: 900000 },
        ],
      }),
    );
    const without = runMonteCarlo(config());
    expect(withZero.mean).toBe(without.mean);
  });

  it('shifts the distribution upward when the event is certain', () => {
    const certain = runMonteCarlo(
      config({
        riskEvents: [
          {
            label: 'Always',
            probability: 1,
            impactMin: 100000,
            impactMode: 100000,
            impactMax: 100000,
          },
        ],
      }),
    );
    const without = runMonteCarlo(config());
    expect(Number(certain.mean) - Number(without.mean)).toBeCloseTo(100000, 0);
  });
});

describe('metadata', () => {
  it('echoes the configuration back for the audit record', () => {
    const result = runMonteCarlo(config({ name: 'Bid contingency', iterations: 12000, seed: 7 }));
    expect(result.name).toBe('Bid contingency');
    expect(result.iterations).toBe(12000);
    expect(result.seed).toBe(7);
    expect(result.baseValue).toBe('1000000.0000');
    expect(result.usedLatinHypercube).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
