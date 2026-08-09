/**
 * Deterministic pseudo-random number generation.
 *
 * Reproducibility is a governance requirement, not a convenience. A contingency
 * figure that came out of a simulation has to be re-derivable months later during
 * an audit, so `Math.random` is unusable here: every simulation is driven by an
 * explicit seed stored alongside its result.
 *
 * sfc32 is used because it is small, fast, has a long period, and passes PractRand
 * - and because it is pure 32-bit integer arithmetic, so it produces identical
 * streams on every platform the platform might run on.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  nextInt(min: number, max: number): number;
  /** Standard normal deviate. */
  nextNormal(): number;
  /** Total draws taken - handy for asserting determinism in tests. */
  readonly drawCount: number;
}

/**
 * SplitMix32, used to expand a single seed into decorrelated state words.
 * Seeding all four sfc32 words from the same value gives poor early output.
 */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RangeError(`Seed must be a non-negative integer, got ${seed}`);
  }

  const mix = splitmix32(seed);
  let a = mix();
  let b = mix();
  let c = mix();
  let d = mix();

  let draws = 0;
  let spareNormal: number | null = null;

  const next = (): number => {
    draws += 1;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const result = (t + d) | 0;
    c = (c + result) | 0;
    return (result >>> 0) / 4294967296;
  };

  // Warm up: discard the first outputs, which reflect the seeding rather than
  // the generator's steady-state behaviour.
  for (let i = 0; i < 12; i += 1) next();
  draws = 0;

  return {
    next,
    nextInt(min: number, max: number): number {
      if (max < min) throw new RangeError(`nextInt requires max >= min, got [${min}, ${max}]`);
      return min + Math.floor(next() * (max - min + 1));
    },
    nextNormal(): number {
      // Marsaglia polar method: two deviates per pass, one cached.
      if (spareNormal !== null) {
        const value = spareNormal;
        spareNormal = null;
        return value;
      }
      let u: number;
      let v: number;
      let s: number;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const factor = Math.sqrt((-2 * Math.log(s)) / s);
      spareNormal = v * factor;
      return u * factor;
    },
    get drawCount() {
      return draws;
    },
  };
}

/**
 * Latin Hypercube stratification of [0,1).
 *
 * Splits the unit interval into `count` equal strata and draws once from each,
 * then shuffles. For the same iteration count this covers the tails far more
 * evenly than plain sampling, which matters when the number being read off is a
 * P80 rather than a mean.
 */
export function latinHypercubeSamples(rng: Rng, count: number): number[] {
  if (count < 1) throw new RangeError('Latin hypercube sampling requires at least one sample');
  const samples = Array.from({ length: count }, (_, i) => (i + rng.next()) / count);
  // Fisher-Yates, driven by the same seeded stream so the whole run stays reproducible.
  for (let i = samples.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i);
    const tmp = samples[i] as number;
    samples[i] = samples[j] as number;
    samples[j] = tmp;
  }
  return samples;
}
