/**
 * Unit tests for the deterministic RNG.
 *
 * Reproducibility is a governance requirement here: a published contingency
 * figure must be re-derivable from its stored seed months later. The determinism
 * tests below are therefore the most important in this file.
 */
import { describe, it, expect } from 'vitest';
import { createRng, latinHypercubeSamples } from './random.js';

const draw = (seed: number, n: number): number[] => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe('createRng - seeding', () => {
  it('throws on a negative seed', () => {
    expect(() => createRng(-1)).toThrow(RangeError);
    expect(() => createRng(-1)).toThrow(/non-negative integer/);
  });

  it('throws on a non-integer seed', () => {
    expect(() => createRng(1.5)).toThrow(RangeError);
    expect(() => createRng(Number.NaN)).toThrow(RangeError);
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('accepts zero and large integer seeds', () => {
    expect(() => createRng(0)).not.toThrow();
    expect(() => createRng(4294967295)).not.toThrow();
    expect(() => createRng(20260101)).not.toThrow();
  });

  it('reports drawCount from zero after the warm-up', () => {
    // The constructor burns 12 outputs then resets the counter.
    const rng = createRng(42);
    expect(rng.drawCount).toBe(0);
    rng.next();
    rng.next();
    expect(rng.drawCount).toBe(2);
    rng.nextInt(0, 10);
    expect(rng.drawCount).toBe(3);
  });
});

describe('determinism (governance requirement)', () => {
  it('two RNGs with the same seed produce an IDENTICAL first 20 outputs', () => {
    const a = draw(20260101, 20);
    const b = draw(20260101, 20);
    expect(a).toHaveLength(20);
    expect(a).toEqual(b);
    // Exact bit-for-bit equality, not approximate.
    for (let i = 0; i < 20; i += 1) expect(Object.is(a[i], b[i]), `index ${i}`).toBe(true);
  });

  it('the same seed reproduces the stream after an arbitrary gap', () => {
    const long = draw(7, 500);
    const again = draw(7, 500);
    expect(again).toEqual(long);
  });

  it('different seeds diverge', () => {
    const a = draw(1, 20);
    const b = draw(2, 20);
    expect(a).not.toEqual(b);
    // Not merely a different ordering - the very first value must differ.
    expect(a[0]).not.toBe(b[0]);
    // And the streams should not accidentally share many values.
    const shared = a.filter((v) => b.includes(v)).length;
    expect(shared).toBe(0);
  });

  it('seed 0 is a usable, reproducible seed', () => {
    expect(draw(0, 20)).toEqual(draw(0, 20));
    expect(draw(0, 20)).not.toEqual(draw(1, 20));
  });

  it('nextInt and nextNormal are deterministic too', () => {
    const one = createRng(99);
    const two = createRng(99);
    const a = Array.from({ length: 50 }, (_, i) => (i % 2 ? one.nextInt(1, 6) : one.nextNormal()));
    const b = Array.from({ length: 50 }, (_, i) => (i % 2 ? two.nextInt(1, 6) : two.nextNormal()));
    expect(a).toEqual(b);
  });
});

describe('next()', () => {
  it('produces values in [0, 1)', () => {
    const rng = createRng(12345);
    for (let i = 0; i < 50000; i += 1) {
      const v = rng.next();
      expect(v >= 0 && v < 1, `out of range at ${i}: ${v}`).toBe(true);
    }
  });

  it('is roughly uniform', () => {
    // 40,000 draws into 10 deciles: expected 4,000 each, sd = sqrt(40000*0.1*0.9) = 60.
    // A +/- 400 window is over 6 sigma, so this is a smoke test, not a flake.
    const rng = createRng(2468);
    const bins = new Array<number>(10).fill(0);
    for (let i = 0; i < 40000; i += 1) {
      const index = Math.min(9, Math.floor(rng.next() * 10));
      bins[index] = (bins[index] as number) + 1;
    }
    expect(bins.reduce((a, b) => a + b, 0)).toBe(40000);
    for (let i = 0; i < 10; i += 1) {
      expect(Math.abs((bins[i] as number) - 4000), `decile ${i}`).toBeLessThan(400);
    }
  });

  it('has a mean near 0.5', () => {
    const rng = createRng(31337);
    let total = 0;
    const n = 50000;
    for (let i = 0; i < n; i += 1) total += rng.next();
    // sd of the mean = (1/sqrt(12))/sqrt(50000) ~ 0.00129, so 0.01 is ~8 sigma.
    expect(total / n).toBeCloseTo(0.5, 2);
  });
});

describe('nextInt()', () => {
  it('respects inclusive bounds and covers both endpoints', () => {
    const rng = createRng(777);
    const counts = new Map<number, number>();
    for (let i = 0; i < 20000; i += 1) {
      const v = rng.nextInt(1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v >= 1 && v <= 6, `${v} outside [1,6]`).toBe(true);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    // Every face must appear, including both endpoints.
    for (const face of [1, 2, 3, 4, 5, 6]) {
      expect(counts.get(face) ?? 0, `face ${face}`).toBeGreaterThan(0);
    }
    expect(counts.get(1)).toBeGreaterThan(2000); // expected ~3333
    expect(counts.get(6)).toBeGreaterThan(2000);
  });

  it('handles a degenerate range where min === max', () => {
    const rng = createRng(5);
    for (let i = 0; i < 100; i += 1) expect(rng.nextInt(4, 4)).toBe(4);
  });

  it('handles negative ranges', () => {
    const rng = createRng(11);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.nextInt(-5, -1);
      expect(v >= -5 && v <= -1).toBe(true);
    }
  });

  it('throws when max < min', () => {
    const rng = createRng(1);
    expect(() => rng.nextInt(6, 1)).toThrow(RangeError);
    expect(() => rng.nextInt(6, 1)).toThrow(/max >= min/);
    expect(() => rng.nextInt(0, -1)).toThrow(RangeError);
  });
});

describe('nextNormal()', () => {
  it('has mean ~ 0 and stdDev ~ 1 over 20,000 draws', () => {
    const rng = createRng(20260101);
    const n = 20000;
    const values = new Array<number>(n);
    for (let i = 0; i < n; i += 1) values[i] = rng.nextNormal();

    const mu = values.reduce((a, b) => a + b, 0) / n;
    // Sample variance, Bessel-corrected.
    const variance = values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);

    // Standard error of the mean = 1/sqrt(20000) ~ 0.00707, so a 0.05 window is ~7 sigma.
    expect(Math.abs(mu)).toBeLessThan(0.05);
    // Standard error of the sd ~ 1/sqrt(2n) ~ 0.005, so 0.05 is ~10 sigma.
    expect(Math.abs(sd - 1)).toBeLessThan(0.05);
  });

  it('produces finite values with a plausible tail', () => {
    const rng = createRng(4242);
    let beyondTwoSigma = 0;
    const n = 20000;
    for (let i = 0; i < n; i += 1) {
      const v = rng.nextNormal();
      expect(Number.isFinite(v)).toBe(true);
      if (Math.abs(v) > 2) beyondTwoSigma += 1;
    }
    // P(|Z| > 2) = 4.55%, so expect ~910 of 20,000; allow a generous band.
    expect(beyondTwoSigma).toBeGreaterThan(700);
    expect(beyondTwoSigma).toBeLessThan(1150);
  });

  it('caches the second polar deviate rather than discarding it', () => {
    // The Marsaglia polar method yields two deviates per accepted pass. The
    // second call must consume the cache and take no further uniform draws.
    const rng = createRng(8);
    rng.nextNormal();
    const afterFirst = rng.drawCount;
    rng.nextNormal();
    expect(rng.drawCount).toBe(afterFirst);
  });
});

describe('latinHypercubeSamples', () => {
  it('returns exactly `count` values, all in [0, 1)', () => {
    for (const count of [1, 2, 10, 1000]) {
      const samples = latinHypercubeSamples(createRng(3), count);
      expect(samples, `count ${count}`).toHaveLength(count);
      for (const v of samples) expect(v >= 0 && v < 1, `${v} out of range`).toBe(true);
    }
  });

  it('is STRATIFIED - after sorting, sample i lies in [i/count, (i+1)/count)', () => {
    // Construction: sample_i = (i + u_i)/count with u_i in [0,1), so exactly one
    // sample lands in each of the `count` equal strata. Sorting recovers that order.
    for (const count of [10, 97, 500]) {
      const sorted = [...latinHypercubeSamples(createRng(20260101), count)].sort((a, b) => a - b);
      for (let i = 0; i < count; i += 1) {
        const v = sorted[i] as number;
        expect(v >= i / count, `count=${count} i=${i}: ${v} < ${i / count}`).toBe(true);
        expect(v < (i + 1) / count, `count=${count} i=${i}: ${v} >= ${(i + 1) / count}`).toBe(true);
      }
    }
  });

  it('is shuffled, not returned in stratum order', () => {
    const samples = latinHypercubeSamples(createRng(20260101), 500);
    const sorted = [...samples].sort((a, b) => a - b);
    expect(samples).not.toEqual(sorted);
  });

  it('is deterministic for a given seed', () => {
    const a = latinHypercubeSamples(createRng(20260101), 200);
    const b = latinHypercubeSamples(createRng(20260101), 200);
    expect(a).toEqual(b);
  });

  it('differs for a different seed', () => {
    const a = latinHypercubeSamples(createRng(1), 200);
    const b = latinHypercubeSamples(createRng(2), 200);
    expect(a).not.toEqual(b);
  });

  it('covers the unit interval far more evenly than plain sampling', () => {
    // With 100 strata the LHS mean is pinned near 0.5 by construction; the strata
    // midpoints alone average to exactly 0.5 - ((0+1+...+99)/100 + 0.5)/100 = 0.4999...
    const samples = latinHypercubeSamples(createRng(55), 1000);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Each sample is stratum_i + u_i/1000, so mean = 0.4995 + (mean of u)/1000,
    // which is bounded within [0.4995, 0.5005].
    expect(mean).toBeGreaterThanOrEqual(0.4995);
    expect(mean).toBeLessThanOrEqual(0.5005);
  });

  it('handles count = 1 (a single draw across the whole interval)', () => {
    const [only] = latinHypercubeSamples(createRng(9), 1);
    expect(only).toBeGreaterThanOrEqual(0);
    expect(only).toBeLessThan(1);
  });

  it('throws when count is below 1', () => {
    expect(() => latinHypercubeSamples(createRng(1), 0)).toThrow(RangeError);
    expect(() => latinHypercubeSamples(createRng(1), -5)).toThrow(/at least one sample/);
  });
});
