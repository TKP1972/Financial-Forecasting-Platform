/**
 * Probability distributions for cost and schedule uncertainty.
 *
 * All sampling is inverse-transform where a closed form exists, so a distribution
 * can be driven either by a raw RNG draw or by a Latin Hypercube stratum - the
 * sampler does not care where its uniform came from.
 *
 * PERT is included because it is what estimators actually use: three-point
 * estimates weighted toward the most likely value, rather than the sharp peak a
 * triangular distribution implies.
 */
import { CalculationError, type DistributionType } from '@ffp/shared';
import type { Rng } from './random.js';

export interface DistributionSpec {
  code: string;
  label?: string;
  distribution: DistributionType;
  min?: number;
  mode?: number;
  max?: number;
  mean?: number;
  stdDev?: number;
  /** DISCRETE only: outcomes with their probabilities. */
  outcomes?: Array<{ value: number; probability: number }>;
}

export interface Sampler {
  code: string;
  label: string;
  /** Draw a value from a uniform in [0,1). */
  sampleFromUniform(u: number, rng: Rng): number;
  /** Analytic (or, for lognormal, exact) mean of the distribution. */
  theoreticalMean: number;
}

const EPS = 1e-12;

/** Validate a spec and return a sampler for it. Throws with a specific message. */
export function createSampler(spec: DistributionSpec): Sampler {
  const label = spec.label ?? spec.code;

  switch (spec.distribution) {
    case 'UNIFORM': {
      const { min, max } = requireRange(spec);
      return {
        code: spec.code,
        label,
        sampleFromUniform: (u) => min + u * (max - min),
        theoreticalMean: (min + max) / 2,
      };
    }

    case 'TRIANGULAR': {
      const { min, max } = requireRange(spec);
      const mode = requireMode(spec, min, max);
      const span = max - min;
      const split = span < EPS ? 0 : (mode - min) / span;
      return {
        code: spec.code,
        label,
        sampleFromUniform: (u) => {
          if (span < EPS) return min;
          return u < split
            ? min + Math.sqrt(u * span * (mode - min))
            : max - Math.sqrt((1 - u) * span * (max - mode));
        },
        theoreticalMean: (min + mode + max) / 3,
      };
    }

    case 'PERT': {
      const { min, max } = requireRange(spec);
      const mode = requireMode(spec, min, max);
      const span = max - min;
      // Standard PERT: lambda = 4, giving mean = (min + 4*mode + max)/6.
      const mean = (min + 4 * mode + max) / 6;
      if (span < EPS) {
        return { code: spec.code, label, sampleFromUniform: () => min, theoreticalMean: min };
      }
      const alpha = ((mean - min) * (2 * mode - min - max)) / ((mode - mean) * span) || 1;
      const beta = (alpha * (max - mean)) / (mean - min);
      const a = Number.isFinite(alpha) && alpha > 0 ? alpha : 1;
      const b = Number.isFinite(beta) && beta > 0 ? beta : 1;
      return {
        code: spec.code,
        label,
        // No closed-form beta inverse CDF; sample via two gammas, which needs the
        // RNG rather than a single uniform. LHS stratification is therefore not
        // applied to PERT inputs - noted in the simulation warnings.
        sampleFromUniform: (_u, rng) => {
          const x = sampleGamma(rng, a);
          const y = sampleGamma(rng, b);
          const total = x + y;
          const unit = total < EPS ? 0.5 : x / total;
          return min + unit * span;
        },
        theoreticalMean: mean,
      };
    }

    case 'NORMAL': {
      const { mean, stdDev } = requireNormalParams(spec);
      return {
        code: spec.code,
        label,
        sampleFromUniform: (_u, rng) => mean + stdDev * rng.nextNormal(),
        theoreticalMean: mean,
      };
    }

    case 'LOGNORMAL': {
      const { mean, stdDev } = requireNormalParams(spec);
      if (mean <= 0) {
        throw CalculationError(
          `Lognormal input '${spec.code}' needs a positive mean; a lognormal variable cannot be zero or negative.`,
          { code: spec.code, mean },
        );
      }
      // Convert the arithmetic mean/sd the user supplied into log-space parameters.
      const variance = stdDev * stdDev;
      const sigmaSquared = Math.log(1 + variance / (mean * mean));
      const mu = Math.log(mean) - sigmaSquared / 2;
      const sigma = Math.sqrt(sigmaSquared);
      return {
        code: spec.code,
        label,
        sampleFromUniform: (_u, rng) => Math.exp(mu + sigma * rng.nextNormal()),
        theoreticalMean: mean,
      };
    }

    case 'DISCRETE': {
      const outcomes = spec.outcomes ?? [];
      if (outcomes.length === 0) {
        throw CalculationError(`Discrete input '${spec.code}' has no outcomes.`, {
          code: spec.code,
        });
      }
      const total = outcomes.reduce((acc, o) => acc + o.probability, 0);
      if (total <= 0) {
        throw CalculationError(`Discrete input '${spec.code}' has zero total probability.`, {
          code: spec.code,
        });
      }
      // Normalise rather than reject: probabilities entered by hand rarely sum
      // to exactly 1, and the relative weights are what the estimator meant.
      const cumulative: Array<{ threshold: number; value: number }> = [];
      let running = 0;
      for (const outcome of outcomes) {
        running += outcome.probability / total;
        cumulative.push({ threshold: running, value: outcome.value });
      }
      const theoreticalMean = outcomes.reduce(
        (acc, o) => acc + (o.value * o.probability) / total,
        0,
      );
      return {
        code: spec.code,
        label,
        sampleFromUniform: (u) => {
          for (const entry of cumulative) {
            if (u <= entry.threshold) return entry.value;
          }
          return (cumulative[cumulative.length - 1] as { value: number }).value;
        },
        theoreticalMean,
      };
    }

    default: {
      const exhaustive: never = spec.distribution;
      throw CalculationError(`Unsupported distribution: ${String(exhaustive)}`, {
        code: spec.code,
      });
    }
  }
}

function requireRange(spec: DistributionSpec): { min: number; max: number } {
  const { min, max } = spec;
  if (min === undefined || max === undefined) {
    throw CalculationError(
      `Input '${spec.code}' (${spec.distribution}) requires both min and max.`,
      { code: spec.code },
    );
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw CalculationError(`Input '${spec.code}' has a non-finite bound.`, { code: spec.code });
  }
  if (max < min) {
    throw CalculationError(`Input '${spec.code}' has max below min.`, {
      code: spec.code,
      min,
      max,
    });
  }
  return { min, max };
}

function requireMode(spec: DistributionSpec, min: number, max: number): number {
  const mode = spec.mode;
  if (mode === undefined) {
    throw CalculationError(
      `Input '${spec.code}' (${spec.distribution}) requires a most-likely value.`,
      { code: spec.code },
    );
  }
  if (mode < min || mode > max) {
    throw CalculationError(
      `Input '${spec.code}' has a most-likely value outside [${min}, ${max}].`,
      { code: spec.code, min, mode, max },
    );
  }
  return mode;
}

function requireNormalParams(spec: DistributionSpec): { mean: number; stdDev: number } {
  const { mean, stdDev } = spec;
  if (mean === undefined || stdDev === undefined) {
    throw CalculationError(
      `Input '${spec.code}' (${spec.distribution}) requires both mean and stdDev.`,
      { code: spec.code },
    );
  }
  if (stdDev < 0) {
    throw CalculationError(`Input '${spec.code}' has a negative standard deviation.`, {
      code: spec.code,
    });
  }
  return { mean, stdDev };
}

/**
 * Gamma variate with unit scale, via Marsaglia-Tsang.
 * Used only to build beta variates for the PERT distribution.
 */
function sampleGamma(rng: Rng, shape: number): number {
  if (shape < 1) {
    // Boost a sub-1 shape into the valid range, then scale back down.
    const u = Math.max(rng.next(), EPS);
    return sampleGamma(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = rng.nextNormal();
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, EPS)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Distributions that consume the RNG directly and cannot use stratified uniforms. */
export const NON_STRATIFIABLE: ReadonlySet<DistributionType> = new Set([
  'PERT',
  'NORMAL',
  'LOGNORMAL',
]);
