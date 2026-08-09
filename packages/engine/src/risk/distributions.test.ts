/**
 * Unit tests for the probability distributions used by the Monte Carlo engine.
 *
 * Analytic means are hand-derived from the standard formulae and shown in the
 * comments; sampling is exercised at the inverse-transform boundary points where
 * the answer is exact.
 */
import { describe, it, expect } from 'vitest';
import { NON_STRATIFIABLE, createSampler, type DistributionSpec } from './distributions.js';
import { createRng, type Rng } from './random.js';

const rng: Rng = createRng(20260101);

describe('validation', () => {
  it('UNIFORM requires both min and max', () => {
    expect(() => createSampler({ code: 'U', distribution: 'UNIFORM', max: 10 })).toThrow(
      /requires both min and max/,
    );
    expect(() => createSampler({ code: 'U', distribution: 'UNIFORM', min: 0 })).toThrow(
      /requires both min and max/,
    );
    expect(() => createSampler({ code: 'U', distribution: 'UNIFORM' })).toThrow(
      /requires both min and max/,
    );
  });

  it('TRIANGULAR and PERT also require both min and max', () => {
    expect(() => createSampler({ code: 'T', distribution: 'TRIANGULAR', mode: 5 })).toThrow(
      /requires both min and max/,
    );
    expect(() => createSampler({ code: 'P', distribution: 'PERT', mode: 5 })).toThrow(
      /requires both min and max/,
    );
  });

  it('rejects max below min', () => {
    expect(() => createSampler({ code: 'U', distribution: 'UNIFORM', min: 10, max: 1 })).toThrow(
      /has max below min/,
    );
    expect(() =>
      createSampler({ code: 'T', distribution: 'TRIANGULAR', min: 10, max: 1, mode: 5 }),
    ).toThrow(/has max below min/);
  });

  it('rejects a non-finite bound', () => {
    expect(() =>
      createSampler({ code: 'U', distribution: 'UNIFORM', min: 0, max: Number.POSITIVE_INFINITY }),
    ).toThrow(/non-finite bound/);
    expect(() =>
      createSampler({ code: 'U', distribution: 'UNIFORM', min: Number.NaN, max: 10 }),
    ).toThrow(/non-finite bound/);
  });

  it('requires a mode for TRIANGULAR and PERT', () => {
    expect(() => createSampler({ code: 'T', distribution: 'TRIANGULAR', min: 0, max: 10 })).toThrow(
      /requires a most-likely value/,
    );
    expect(() => createSampler({ code: 'P', distribution: 'PERT', min: 0, max: 10 })).toThrow(
      /requires a most-likely value/,
    );
  });

  it('rejects a mode outside [min, max]', () => {
    expect(() =>
      createSampler({ code: 'T', distribution: 'TRIANGULAR', min: 0, max: 10, mode: 11 }),
    ).toThrow(/most-likely value outside/);
    expect(() =>
      createSampler({ code: 'T', distribution: 'TRIANGULAR', min: 0, max: 10, mode: -1 }),
    ).toThrow(/most-likely value outside/);
    expect(() =>
      createSampler({ code: 'P', distribution: 'PERT', min: 0, max: 10, mode: 25 }),
    ).toThrow(/most-likely value outside/);
  });

  it('accepts a mode sitting exactly on either bound', () => {
    expect(() =>
      createSampler({ code: 'T', distribution: 'TRIANGULAR', min: 0, max: 10, mode: 0 }),
    ).not.toThrow();
    expect(() =>
      createSampler({ code: 'T', distribution: 'TRIANGULAR', min: 0, max: 10, mode: 10 }),
    ).not.toThrow();
  });

  it('NORMAL and LOGNORMAL require both mean and stdDev', () => {
    expect(() => createSampler({ code: 'N', distribution: 'NORMAL', mean: 10 })).toThrow(
      /requires both mean and stdDev/,
    );
    expect(() => createSampler({ code: 'N', distribution: 'NORMAL', stdDev: 1 })).toThrow(
      /requires both mean and stdDev/,
    );
    expect(() => createSampler({ code: 'L', distribution: 'LOGNORMAL', mean: 10 })).toThrow(
      /requires both mean and stdDev/,
    );
  });

  it('rejects a negative standard deviation', () => {
    expect(() =>
      createSampler({ code: 'N', distribution: 'NORMAL', mean: 10, stdDev: -1 }),
    ).toThrow(/negative standard deviation/);
    expect(() =>
      createSampler({ code: 'L', distribution: 'LOGNORMAL', mean: 10, stdDev: -0.5 }),
    ).toThrow(/negative standard deviation/);
  });

  it('accepts a zero standard deviation (a degenerate point mass)', () => {
    const sampler = createSampler({ code: 'N', distribution: 'NORMAL', mean: 10, stdDev: 0 });
    expect(sampler.sampleFromUniform(0.3, rng)).toBe(10);
  });

  it('rejects a LOGNORMAL with a mean of zero or below', () => {
    expect(() =>
      createSampler({ code: 'L', distribution: 'LOGNORMAL', mean: 0, stdDev: 1 }),
    ).toThrow(/needs a positive mean/);
    expect(() =>
      createSampler({ code: 'L', distribution: 'LOGNORMAL', mean: -5, stdDev: 1 }),
    ).toThrow(/needs a positive mean/);
  });

  it('rejects a DISCRETE with no outcomes', () => {
    expect(() => createSampler({ code: 'D', distribution: 'DISCRETE' })).toThrow(/has no outcomes/);
    expect(() => createSampler({ code: 'D', distribution: 'DISCRETE', outcomes: [] })).toThrow(
      /has no outcomes/,
    );
  });

  it('rejects a DISCRETE whose probabilities total zero', () => {
    expect(() =>
      createSampler({
        code: 'D',
        distribution: 'DISCRETE',
        outcomes: [
          { value: 1, probability: 0 },
          { value: 2, probability: 0 },
        ],
      }),
    ).toThrow(/zero total probability/);
  });

  it('names the offending input in the message', () => {
    expect(() => createSampler({ code: 'LABOUR_RATE', distribution: 'UNIFORM' })).toThrow(
      /LABOUR_RATE/,
    );
  });

  it('carries the code and falls back to it as the label', () => {
    const unlabelled = createSampler({ code: 'X', distribution: 'UNIFORM', min: 0, max: 1 });
    expect(unlabelled.code).toBe('X');
    expect(unlabelled.label).toBe('X');
    const labelled = createSampler({
      code: 'X',
      label: 'Exchange rate',
      distribution: 'UNIFORM',
      min: 0,
      max: 1,
    });
    expect(labelled.label).toBe('Exchange rate');
  });
});

describe('UNIFORM', () => {
  const spec: DistributionSpec = { code: 'U', distribution: 'UNIFORM', min: 10, max: 20 };
  const sampler = createSampler(spec);

  it('inverse transform: u = 0 gives min', () => {
    // min + 0*(max-min) = 10
    expect(sampler.sampleFromUniform(0, rng)).toBe(10);
  });

  it('inverse transform: u = 1 gives max', () => {
    // 10 + 1*(20-10) = 20
    expect(sampler.sampleFromUniform(1, rng)).toBe(20);
  });

  it('inverse transform: u = 0.5 gives the midpoint', () => {
    // 10 + 0.5*10 = 15
    expect(sampler.sampleFromUniform(0.5, rng)).toBe(15);
  });

  it('is linear in u', () => {
    // 10 + 0.25*10 = 12.5 ; 10 + 0.75*10 = 17.5
    expect(sampler.sampleFromUniform(0.25, rng)).toBe(12.5);
    expect(sampler.sampleFromUniform(0.75, rng)).toBe(17.5);
  });

  it('theoreticalMean is (min + max)/2', () => {
    // (10 + 20)/2 = 15
    expect(sampler.theoreticalMean).toBe(15);
  });

  it('handles a degenerate min === max', () => {
    const point = createSampler({ code: 'U0', distribution: 'UNIFORM', min: 7, max: 7 });
    expect(point.sampleFromUniform(0, rng)).toBe(7);
    expect(point.sampleFromUniform(1, rng)).toBe(7);
    expect(point.theoreticalMean).toBe(7);
  });
});

describe('TRIANGULAR', () => {
  // min 0, mode 30, max 60. span = 60, split = (30-0)/60 = 0.5.
  const sampler = createSampler({
    code: 'T',
    distribution: 'TRIANGULAR',
    min: 0,
    mode: 30,
    max: 60,
  });

  it('theoreticalMean is (min + mode + max)/3', () => {
    // (0 + 30 + 60)/3 = 30
    expect(sampler.theoreticalMean).toBe(30);
  });

  it('theoreticalMean for a skewed triangle', () => {
    // (10 + 12 + 50)/3 = 72/3 = 24
    const skewed = createSampler({
      code: 'T2',
      distribution: 'TRIANGULAR',
      min: 10,
      mode: 12,
      max: 50,
    });
    expect(skewed.theoreticalMean).toBe(24);
  });

  it('u = 0 gives min', () => {
    // Lower branch: min + sqrt(0 * span * (mode-min)) = 0
    expect(sampler.sampleFromUniform(0, rng)).toBe(0);
  });

  it('u = 1 gives max', () => {
    // Upper branch: max - sqrt(0 * span * (max-mode)) = 60
    expect(sampler.sampleFromUniform(1, rng)).toBe(60);
  });

  it('u approaching 1 approaches max', () => {
    // 60 - sqrt(1e-8 * 60 * 30) = 60 - sqrt(1.8e-5) ~ 59.9958
    const v = sampler.sampleFromUniform(1 - 1e-8, rng);
    expect(v).toBeGreaterThan(59.99);
    expect(v).toBeLessThan(60);
  });

  it('u = split returns the mode exactly', () => {
    // At u = 0.5 the upper branch gives 60 - sqrt(0.5 * 60 * 30) = 60 - sqrt(900) = 30
    expect(sampler.sampleFromUniform(0.5, rng)).toBe(30);
  });

  it('is monotonically increasing in u', () => {
    let previous = -Infinity;
    for (let u = 0; u <= 1.000001; u += 0.01) {
      const v = sampler.sampleFromUniform(Math.min(u, 1), rng);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it('stays within [min, max] across the whole unit interval', () => {
    for (let u = 0; u <= 1; u += 0.005) {
      const v = sampler.sampleFromUniform(u, rng);
      expect(v >= 0 && v <= 60, `u=${u} -> ${v}`).toBe(true);
    }
  });

  it('degenerate min === max returns min', () => {
    const point = createSampler({
      code: 'T0',
      distribution: 'TRIANGULAR',
      min: 50,
      mode: 50,
      max: 50,
    });
    expect(point.sampleFromUniform(0, rng)).toBe(50);
    expect(point.sampleFromUniform(0.5, rng)).toBe(50);
    expect(point.sampleFromUniform(1, rng)).toBe(50);
    // (50 + 50 + 50)/3 = 50
    expect(point.theoreticalMean).toBe(50);
  });

  it('empirically converges on the theoretical mean', () => {
    const local = createRng(4242);
    let total = 0;
    const n = 40000;
    for (let i = 0; i < n; i += 1) total += sampler.sampleFromUniform(local.next(), local);
    // Triangular(0,30,60) has mean 30 and sd = sqrt((0^2+30^2+60^2 - 0*30 - 0*60 - 30*60)/18)
    //   = sqrt((0+900+3600-0-0-1800)/18) = sqrt(2700/18) = sqrt(150) ~ 12.25
    // Standard error over 40,000 draws ~ 0.061, so 0.5 is ~8 sigma.
    expect(Math.abs(total / n - 30)).toBeLessThan(0.5);
  });
});

describe('PERT', () => {
  it('theoreticalMean is exactly (min + 4*mode + max)/6', () => {
    // (10 + 4*20 + 60)/6 = (10 + 80 + 60)/6 = 150/6 = 25
    const sampler = createSampler({
      code: 'P',
      distribution: 'PERT',
      min: 10,
      mode: 20,
      max: 60,
    });
    expect(sampler.theoreticalMean).toBe(25);
  });

  it('theoreticalMean for a symmetric three-point estimate equals the mode', () => {
    // (0 + 4*1 + 2)/6 = 6/6 = 1
    expect(
      createSampler({ code: 'P2', distribution: 'PERT', min: 0, mode: 1, max: 2 }).theoreticalMean,
    ).toBe(1);
    // (100 + 4*150 + 200)/6 = 900/6 = 150
    expect(
      createSampler({ code: 'P3', distribution: 'PERT', min: 100, mode: 150, max: 200 })
        .theoreticalMean,
    ).toBe(150);
  });

  it('weights the mode four times more heavily than the extremes', () => {
    // A PERT mean is pulled toward the mode relative to the triangular mean.
    // Triangular(10,20,60) mean = 30; PERT(10,20,60) mean = 25.
    const pert = createSampler({ code: 'P', distribution: 'PERT', min: 10, mode: 20, max: 60 });
    const tri = createSampler({
      code: 'T',
      distribution: 'TRIANGULAR',
      min: 10,
      mode: 20,
      max: 60,
    });
    expect(pert.theoreticalMean).toBeLessThan(tri.theoreticalMean);
    expect(tri.theoreticalMean).toBe(30);
  });

  it('samples strictly inside [min, max]', () => {
    const sampler = createSampler({
      code: 'P',
      distribution: 'PERT',
      min: 10,
      mode: 20,
      max: 60,
    });
    const local = createRng(31337);
    for (let i = 0; i < 5000; i += 1) {
      const v = sampler.sampleFromUniform(local.next(), local);
      expect(v >= 10 && v <= 60, `${v} outside [10,60]`).toBe(true);
    }
  });

  it('samples converge on the theoretical mean', () => {
    const sampler = createSampler({
      code: 'P',
      distribution: 'PERT',
      min: 10,
      mode: 20,
      max: 60,
    });
    const local = createRng(777);
    let total = 0;
    const n = 20000;
    for (let i = 0; i < n; i += 1) total += sampler.sampleFromUniform(local.next(), local);
    // PERT(10,20,60) has mean 25 and sd = sqrt((mean-min)(max-mean)/7)
    //   = sqrt(15 * 35 / 7) = sqrt(75) ~ 8.66; SE over 20,000 ~ 0.061.
    expect(Math.abs(total / n - 25)).toBeLessThan(0.5);
  });

  it('degenerate min === max collapses to a point mass', () => {
    const point = createSampler({ code: 'P0', distribution: 'PERT', min: 5, mode: 5, max: 5 });
    expect(point.theoreticalMean).toBe(5);
    expect(point.sampleFromUniform(0.5, rng)).toBe(5);
  });

  // KNOWN BUG - see report. When the mode is the midpoint of [min, max] the PERT
  // mean equals the mode, so `mode - mean` is 0 and the alpha expression evaluates
  // to 0/0 = NaN. The `|| 1` fallback then silently produces Beta(1,1) - a UNIFORM
  // distribution - for every symmetric three-point estimate. The mean survives but
  // the spread is badly overstated, which inflates every published P80.
  it.fails('a SYMMETRIC PERT should be peaked, not uniform (KNOWN BUG)', () => {
    // PERT(100, 150, 200): mean = (100 + 4*150 + 200)/6 = 900/6 = 150.
    // Beta-PERT variance = (mean-min)(max-mean)/(lambda+3) = 50*50/7 = 357.14,
    // so sd ~ 18.9.  A Uniform(100,200) would instead have sd = 100/sqrt(12) ~ 28.9.
    const sampler = createSampler({
      code: 'PSYM',
      distribution: 'PERT',
      min: 100,
      mode: 150,
      max: 200,
    });
    const local = createRng(20260101);
    const n = 40000;
    const values = Array.from({ length: n }, () => sampler.sampleFromUniform(local.next(), local));
    const mu = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (n - 1));
    expect(Math.abs(mu - 150)).toBeLessThan(1);
    // Must be materially tighter than the uniform it currently degenerates into.
    expect(sd).toBeLessThan(22);
  });
});

describe('NORMAL', () => {
  const sampler = createSampler({ code: 'N', distribution: 'NORMAL', mean: 100, stdDev: 15 });

  it('theoreticalMean is the supplied mean', () => {
    expect(sampler.theoreticalMean).toBe(100);
  });

  it('draws from the generator, ignoring the supplied uniform', () => {
    // The uniform argument is unused: two calls with the SAME u give different
    // values because the sampler consumes the RNG directly.
    const local = createRng(1);
    const a = sampler.sampleFromUniform(0.5, local);
    const b = sampler.sampleFromUniform(0.5, local);
    expect(a).not.toBe(b);
  });

  it('is centred and scaled correctly', () => {
    const local = createRng(2026);
    const n = 20000;
    const values = Array.from({ length: n }, () => sampler.sampleFromUniform(0, local));
    const mu = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (n - 1));
    // SE of the mean = 15/sqrt(20000) ~ 0.106, so a 0.75 window is ~7 sigma.
    expect(Math.abs(mu - 100)).toBeLessThan(0.75);
    expect(Math.abs(sd - 15)).toBeLessThan(0.75);
  });
});

describe('LOGNORMAL', () => {
  const sampler = createSampler({ code: 'L', distribution: 'LOGNORMAL', mean: 100, stdDev: 30 });

  it('reports the arithmetic mean the user supplied', () => {
    expect(sampler.theoreticalMean).toBe(100);
  });

  it('is strictly positive', () => {
    const local = createRng(13);
    for (let i = 0; i < 5000; i += 1) {
      expect(sampler.sampleFromUniform(0.5, local)).toBeGreaterThan(0);
    }
  });

  it('reproduces the requested arithmetic mean and sd', () => {
    // Moment matching: sigma^2 = ln(1 + 30^2/100^2) = ln(1.09); mu = ln(100) - sigma^2/2.
    // Those parameters are chosen precisely so E[X] = 100 and sd(X) = 30.
    const local = createRng(20260707);
    const n = 40000;
    const values = Array.from({ length: n }, () => sampler.sampleFromUniform(0, local));
    const mu = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (n - 1));
    expect(Math.abs(mu - 100)).toBeLessThan(1.5);
    expect(Math.abs(sd - 30)).toBeLessThan(2.5);
  });
});

describe('DISCRETE', () => {
  it('normalises probabilities that do not sum to 1', () => {
    // Weights [0.5, 0.5, 0.5] total 1.5, so each outcome carries 1/3.
    // theoreticalMean = (10 + 20 + 30)/3 = 20
    const sampler = createSampler({
      code: 'D',
      distribution: 'DISCRETE',
      outcomes: [
        { value: 10, probability: 0.5 },
        { value: 20, probability: 0.5 },
        { value: 30, probability: 0.5 },
      ],
    });
    expect(sampler.theoreticalMean).toBeCloseTo(20, 10);
  });

  it('normalises unequal weights that do not sum to 1', () => {
    // Weights [2, 3, 5] total 10 -> 0.2 / 0.3 / 0.5.
    // mean = 100*0.2 + 200*0.3 + 400*0.5 = 20 + 60 + 200 = 280
    const sampler = createSampler({
      code: 'D',
      distribution: 'DISCRETE',
      outcomes: [
        { value: 100, probability: 2 },
        { value: 200, probability: 3 },
        { value: 400, probability: 5 },
      ],
    });
    expect(sampler.theoreticalMean).toBeCloseTo(280, 10);
  });

  it('selects by inverse CDF at the boundary values of u', () => {
    // Weights [0.25, 0.25, 0.5] already total 1, so the cumulative thresholds
    // are 0.25, 0.50 and 1.00. Selection is `u <= threshold`.
    const sampler = createSampler({
      code: 'D',
      distribution: 'DISCRETE',
      outcomes: [
        { value: 1, probability: 0.25 },
        { value: 2, probability: 0.25 },
        { value: 3, probability: 0.5 },
      ],
    });
    expect(sampler.sampleFromUniform(0, rng)).toBe(1);
    expect(sampler.sampleFromUniform(0.25, rng)).toBe(1); // on the boundary, inclusive
    expect(sampler.sampleFromUniform(0.2500001, rng)).toBe(2);
    expect(sampler.sampleFromUniform(0.5, rng)).toBe(2); // on the boundary, inclusive
    expect(sampler.sampleFromUniform(0.5000001, rng)).toBe(3);
    expect(sampler.sampleFromUniform(1, rng)).toBe(3);
    // mean = 1*0.25 + 2*0.25 + 3*0.5 = 0.25 + 0.5 + 1.5 = 2.25
    expect(sampler.theoreticalMean).toBeCloseTo(2.25, 10);
  });

  it('falls back to the last outcome when floating-point cumulation stops short of 1', () => {
    // 1/3 + 1/3 + 1/3 accumulates to 0.9999999999999999, so u = 1 falls through
    // the loop and must still return a valid outcome rather than undefined.
    const sampler = createSampler({
      code: 'D',
      distribution: 'DISCRETE',
      outcomes: [
        { value: 10, probability: 1 },
        { value: 20, probability: 1 },
        { value: 30, probability: 1 },
      ],
    });
    expect(sampler.sampleFromUniform(1, rng)).toBe(30);
    expect(sampler.sampleFromUniform(0.999999999999999, rng)).toBe(30);
  });

  it('handles a single certain outcome', () => {
    const sampler = createSampler({
      code: 'D',
      distribution: 'DISCRETE',
      outcomes: [{ value: 500, probability: 1 }],
    });
    expect(sampler.theoreticalMean).toBe(500);
    for (const u of [0, 0.3, 0.5, 1]) expect(sampler.sampleFromUniform(u, rng)).toBe(500);
  });

  it('only ever returns declared outcome values', () => {
    const sampler = createSampler({
      code: 'D',
      distribution: 'DISCRETE',
      outcomes: [
        { value: -50, probability: 0.1 },
        { value: 0, probability: 0.6 },
        { value: 250, probability: 0.3 },
      ],
    });
    const local = createRng(64);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i += 1) seen.add(sampler.sampleFromUniform(local.next(), local));
    expect([...seen].sort((a, b) => a - b)).toEqual([-50, 0, 250]);
    // mean = -50*0.1 + 0*0.6 + 250*0.3 = -5 + 0 + 75 = 70
    expect(sampler.theoreticalMean).toBeCloseTo(70, 10);
  });
});

describe('NON_STRATIFIABLE', () => {
  it('contains exactly PERT, NORMAL and LOGNORMAL', () => {
    expect(NON_STRATIFIABLE.has('PERT')).toBe(true);
    expect(NON_STRATIFIABLE.has('NORMAL')).toBe(true);
    expect(NON_STRATIFIABLE.has('LOGNORMAL')).toBe(true);
    expect(NON_STRATIFIABLE.size).toBe(3);
  });

  it('excludes the closed-form inverse-transform distributions', () => {
    expect(NON_STRATIFIABLE.has('UNIFORM')).toBe(false);
    expect(NON_STRATIFIABLE.has('TRIANGULAR')).toBe(false);
    expect(NON_STRATIFIABLE.has('DISCRETE')).toBe(false);
  });

  it('matches which samplers actually ignore the supplied uniform', () => {
    // Stratifiable samplers must be pure functions of u; non-stratifiable ones
    // consume the RNG and so cannot be driven by a Latin Hypercube column.
    const stratifiable: DistributionSpec[] = [
      { code: 'a', distribution: 'UNIFORM', min: 0, max: 1 },
      { code: 'b', distribution: 'TRIANGULAR', min: 0, mode: 0.5, max: 1 },
      {
        code: 'c',
        distribution: 'DISCRETE',
        outcomes: [
          { value: 1, probability: 1 },
          { value: 2, probability: 1 },
        ],
      },
    ];
    for (const spec of stratifiable) {
      const sampler = createSampler(spec);
      const local = createRng(3);
      expect(sampler.sampleFromUniform(0.42, local), spec.code).toBe(
        sampler.sampleFromUniform(0.42, local),
      );
      expect(NON_STRATIFIABLE.has(spec.distribution), spec.code).toBe(false);
    }
  });
});
