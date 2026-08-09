/**
 * Monte Carlo simulation over cost and revenue uncertainty.
 *
 * Produces the confidence figures a budget or bid actually gets approved against:
 * "the P80 cost is 4.2m, so we hold 380k of contingency". A single-point estimate
 * cannot answer that question, and a triangular-mean adjustment only pretends to.
 *
 * Every run is driven by an explicit seed and reports it back, so a published
 * contingency number can be regenerated exactly during review or audit.
 */
import { CalculationError, Decimal, toDecimal, toMoneyString, type MoneyInput } from '@ffp/shared';
import { mean, quantileSorted, rankCorrelation, stdDev } from '../stats.js';
import { NON_STRATIFIABLE, createSampler, type DistributionSpec } from './distributions.js';
import { createRng, latinHypercubeSamples } from './random.js';

/** A discrete risk-register event folded into the simulation. */
export interface RiskEventSpec {
  riskId?: string;
  label: string;
  /** Chance the event occurs at all, in [0,1]. */
  probability: number;
  /** Three-point estimate of the cost if it does occur. */
  impactMin: number;
  impactMode: number;
  impactMax: number;
}

export interface MonteCarloConfig {
  name?: string;
  iterations?: number;
  seed?: number;
  /** Deterministic base estimate the uncertain inputs are added to. */
  baseValue: MoneyInput;
  inputs: DistributionSpec[];
  riskEvents?: RiskEventSpec[];
  /** Percentiles to report, as fractions. */
  confidenceLevels?: number[];
  /** Latin Hypercube stratification. On by default; improves tail accuracy. */
  useLatinHypercube?: boolean;
}

export interface PercentileResult {
  level: number;
  /** Conventional label, e.g. "P80". */
  label: string;
  value: string;
}

export interface SensitivityResult {
  code: string;
  label: string;
  /** Spearman rank correlation against the output. Signed: -1 to 1. */
  correlation: number;
  /** Share of explained variation, normalised across inputs. Sums to ~1. */
  contribution: number;
}

export interface MonteCarloResult {
  name: string;
  iterations: number;
  seed: number;
  usedLatinHypercube: boolean;
  baseValue: string;
  /** Deterministic estimate plus the analytic means of every input. */
  deterministicEstimate: string;
  mean: string;
  median: string;
  standardDeviation: string;
  min: string;
  max: string;
  percentiles: PercentileResult[];
  /** P80 minus the deterministic estimate. The number that funds the reserve. */
  contingency: string;
  /** Chance the outcome lands at or below the deterministic estimate. */
  probabilityOfUnderrun: number;
  sensitivity: SensitivityResult[];
  /** Bucketed outcomes for plotting the distribution. */
  histogram: Array<{ lowerBound: string; upperBound: string; count: number; frequency: number }>;
  warnings: string[];
  /** Milliseconds spent simulating - surfaced so slow models are visible. */
  durationMs: number;
}

const DEFAULT_LEVELS = [0.1, 0.5, 0.8, 0.9, 0.95];

/** Run the simulation. Pure and deterministic for a given config. */
export function runMonteCarlo(config: MonteCarloConfig): MonteCarloResult {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const iterations = Math.trunc(config.iterations ?? 10000);
  if (iterations < 100 || iterations > 1_000_000) {
    throw CalculationError(`Iterations must be between 100 and 1,000,000, got ${iterations}.`, {
      iterations,
    });
  }
  if (iterations < 5000) {
    warnings.push(
      `${iterations} iterations gives noisy tail percentiles. 10,000 or more is recommended for a P80 you intend to publish.`,
    );
  }

  const inputs = config.inputs ?? [];
  const riskEvents = config.riskEvents ?? [];
  if (inputs.length === 0 && riskEvents.length === 0) {
    throw CalculationError('A simulation needs at least one uncertain input or risk event.');
  }

  const seed = config.seed ?? 20260101;
  const rng = createRng(seed);
  const samplers = inputs.map(createSampler);

  const useLhs = config.useLatinHypercube ?? true;
  const stratifiable = samplers.map((_, i) => {
    const spec = inputs[i] as DistributionSpec;
    return useLhs && !NON_STRATIFIABLE.has(spec.distribution);
  });
  if (useLhs && stratifiable.some((s) => !s)) {
    warnings.push(
      'Normal, lognormal and PERT inputs draw from the generator directly and are not stratified; their tails converge more slowly than the stratified inputs.',
    );
  }

  // Pre-draw one stratified column per stratifiable input.
  const strata = samplers.map((_, i) =>
    stratifiable[i] ? latinHypercubeSamples(rng, iterations) : null,
  );

  const base = toDecimal(config.baseValue).toNumber();
  const outcomes = new Float64Array(iterations);
  const inputSamples: Float64Array[] = samplers.map(() => new Float64Array(iterations));
  const eventSamples: Float64Array[] = riskEvents.map(() => new Float64Array(iterations));

  for (const event of riskEvents) {
    if (event.probability < 0 || event.probability > 1) {
      throw CalculationError(`Risk event '${event.label}' has a probability outside [0,1].`, {
        label: event.label,
        probability: event.probability,
      });
    }
    if (event.impactMin > event.impactMode || event.impactMode > event.impactMax) {
      throw CalculationError(
        `Risk event '${event.label}' has an inconsistent three-point estimate (min <= mode <= max is required).`,
        { label: event.label },
      );
    }
  }

  for (let i = 0; i < iterations; i += 1) {
    let total = base;

    for (let s = 0; s < samplers.length; s += 1) {
      const sampler = samplers[s] as ReturnType<typeof createSampler>;
      const column = strata[s];
      const u = column ? (column[i] as number) : rng.next();
      const value = sampler.sampleFromUniform(u, rng);
      (inputSamples[s] as Float64Array)[i] = value;
      total += value;
    }

    for (let e = 0; e < riskEvents.length; e += 1) {
      const event = riskEvents[e] as RiskEventSpec;
      let impact = 0;
      if (rng.next() < event.probability) {
        impact = sampleTriangular(rng.next(), event.impactMin, event.impactMode, event.impactMax);
      }
      (eventSamples[e] as Float64Array)[i] = impact;
      total += impact;
    }

    outcomes[i] = total;
  }

  const values = Array.from(outcomes);
  const sorted = [...values].sort((a, b) => a - b);

  const deterministic =
    base +
    samplers.reduce((acc, s) => acc + s.theoreticalMean, 0) +
    riskEvents.reduce(
      (acc, e) => acc + e.probability * ((e.impactMin + e.impactMode + e.impactMax) / 3),
      0,
    );

  const levels = (config.confidenceLevels ?? DEFAULT_LEVELS)
    .filter((l) => l >= 0 && l <= 1)
    .sort((a, b) => a - b);

  const percentiles: PercentileResult[] = levels.map((level) => ({
    level,
    label: `P${Math.round(level * 100)}`,
    value: toMoneyString(quantileSorted(sorted, level)),
  }));

  const p80 = quantileSorted(sorted, 0.8);
  const underrunCount = sorted.filter((v) => v <= deterministic).length;

  return {
    name: config.name ?? 'Monte Carlo simulation',
    iterations,
    seed,
    usedLatinHypercube: useLhs,
    baseValue: toMoneyString(base),
    deterministicEstimate: toMoneyString(deterministic),
    mean: toMoneyString(mean(values)),
    median: toMoneyString(quantileSorted(sorted, 0.5)),
    standardDeviation: toMoneyString(stdDev(values)),
    min: toMoneyString(sorted[0] as number),
    max: toMoneyString(sorted[sorted.length - 1] as number),
    percentiles,
    contingency: toMoneyString(new Decimal(p80).minus(deterministic)),
    probabilityOfUnderrun: underrunCount / iterations,
    sensitivity: computeSensitivity(values, samplers, inputSamples, riskEvents, eventSamples),
    histogram: buildHistogram(sorted),
    warnings,
    durationMs: Date.now() - startedAt,
  };
}

function sampleTriangular(u: number, min: number, mode: number, max: number): number {
  const span = max - min;
  if (span <= 0) return min;
  const split = (mode - min) / span;
  return u < split
    ? min + Math.sqrt(u * span * (mode - min))
    : max - Math.sqrt((1 - u) * span * (max - mode));
}

/**
 * Tornado data: which inputs actually drive the outcome.
 *
 * Spearman rank correlation, squared and normalised to give each input a share
 * of explained variation. Rank rather than Pearson so a strongly influential but
 * non-linear input is not understated.
 */
function computeSensitivity(
  outcomes: readonly number[],
  samplers: ReadonlyArray<{ code: string; label: string }>,
  inputSamples: readonly Float64Array[],
  riskEvents: readonly RiskEventSpec[],
  eventSamples: readonly Float64Array[],
): SensitivityResult[] {
  const entries: Array<{ code: string; label: string; correlation: number }> = [];

  samplers.forEach((sampler, i) => {
    const column = Array.from(inputSamples[i] as Float64Array);
    entries.push({
      code: sampler.code,
      label: sampler.label,
      correlation: rankCorrelation(column, outcomes),
    });
  });

  riskEvents.forEach((event, i) => {
    const column = Array.from(eventSamples[i] as Float64Array);
    entries.push({
      code: event.riskId ?? event.label,
      label: event.label,
      correlation: rankCorrelation(column, outcomes),
    });
  });

  const totalSquared = entries.reduce((acc, e) => acc + e.correlation ** 2, 0);

  return entries
    .map((e) => ({
      ...e,
      contribution: totalSquared === 0 ? 0 : e.correlation ** 2 / totalSquared,
    }))
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

function buildHistogram(
  sorted: readonly number[],
  binCount = 30,
): Array<{ lowerBound: string; upperBound: string; count: number; frequency: number }> {
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  const span = max - min;

  if (span === 0) {
    return [
      {
        lowerBound: toMoneyString(min),
        upperBound: toMoneyString(max),
        count: sorted.length,
        frequency: 1,
      },
    ];
  }

  const width = span / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const value of sorted) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[index] = (counts[index] as number) + 1;
  }

  return counts.map((count, i) => ({
    lowerBound: toMoneyString(min + i * width),
    upperBound: toMoneyString(min + (i + 1) * width),
    count,
    frequency: count / sorted.length,
  }));
}

/**
 * Contingency required to reach a given confidence level.
 * Separated out so a reserve can be recalculated at a different confidence
 * without re-running the whole simulation.
 */
export function contingencyAt(result: MonteCarloResult, level: number): string {
  const match = result.percentiles.find((p) => Math.abs(p.level - level) < 1e-9);
  if (!match) {
    throw CalculationError(
      `Confidence level ${level} was not computed in this simulation. Available: ${result.percentiles.map((p) => p.level).join(', ')}.`,
      { level, available: result.percentiles.map((p) => p.level) },
    );
  }
  return toMoneyString(toDecimal(match.value).minus(toDecimal(result.deterministicEstimate)));
}
