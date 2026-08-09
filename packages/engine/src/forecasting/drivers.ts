/**
 * Driver-based forecasting and scenario modelling.
 *
 * A time-series forecast tells you what the trend implies. A driver build-up
 * tells you *why* the number is what it is - subscribers x ARPU, headcount x
 * fully-loaded cost, sites x maintenance rate. Budget conversations happen in
 * driver terms, so this stays in Decimal end to end: these figures go straight
 * into a budget line and must foot exactly.
 */
import {
  Decimal,
  add,
  escalationFactor,
  multiply,
  toDecimal,
  toMoneyString,
  type MoneyInput,
} from '@ffp/shared';
import { CalculationError } from '@ffp/shared';

export interface DriverDefinition {
  code: string;
  name: string;
  unit?: string;
  /** Volume per period, in period order. */
  volumes: MoneyInput[];
  /** Unit rate: one value applied to every period, or one value per period. */
  unitRate: MoneyInput | MoneyInput[];
  /** Compound growth applied to volume, period over period. */
  volumeGrowthRate?: MoneyInput;
  /** Compound escalation applied to the unit rate, period over period. */
  rateEscalationRate?: MoneyInput;
}

export interface DriverPeriodResult {
  periodIndex: number;
  volume: string;
  unitRate: string;
  amount: string;
}

export interface DriverForecastResult {
  code: string;
  name: string;
  unit: string;
  periods: DriverPeriodResult[];
  total: string;
}

/**
 * Expand one driver into per-period amounts.
 *
 * Growth and escalation compound from period 0, so period *n* carries a factor of
 * `(1+r)^n`. Period 0 is therefore always the as-supplied value - which is what
 * budget owners expect when they type in "current run rate, growing 3%".
 */
export function buildDriverForecast(driver: DriverDefinition): DriverForecastResult {
  const { code, name, volumes } = driver;
  if (volumes.length === 0) {
    throw CalculationError(`Driver '${code}' has no volumes.`, { code });
  }

  const rates = Array.isArray(driver.unitRate) ? driver.unitRate : null;
  if (rates && rates.length !== volumes.length) {
    throw CalculationError(
      `Driver '${code}' supplies ${rates.length} unit rates for ${volumes.length} periods. Provide one rate, or one per period.`,
      { code, rates: rates.length, periods: volumes.length },
    );
  }

  const growth = driver.volumeGrowthRate ?? '0';
  const escalation = driver.rateEscalationRate ?? '0';

  const periods = volumes.map((rawVolume, index) => {
    const volume = multiply(toDecimal(rawVolume), escalationFactor(growth, index));
    const baseRate = rates
      ? toDecimal(rates[index] as MoneyInput)
      : toDecimal(driver.unitRate as MoneyInput);
    const unitRate = multiply(baseRate, escalationFactor(escalation, index));
    return {
      periodIndex: index,
      volume: toMoneyString(volume),
      unitRate: toMoneyString(unitRate, 6),
      amount: toMoneyString(multiply(volume, unitRate)),
    };
  });

  return {
    code,
    name,
    unit: driver.unit ?? 'units',
    periods,
    total: toMoneyString(add(...periods.map((p) => p.amount))),
  };
}

export interface DriverBundleResult {
  drivers: DriverForecastResult[];
  /** Sum across all drivers, per period. */
  periodTotals: string[];
  grandTotal: string;
}

/** Roll a set of drivers into a single per-period forecast. */
export function buildDriverBundle(drivers: readonly DriverDefinition[]): DriverBundleResult {
  if (drivers.length === 0) {
    return { drivers: [], periodTotals: [], grandTotal: toMoneyString(0) };
  }

  const results = drivers.map(buildDriverForecast);
  const periodCount = Math.max(...results.map((r) => r.periods.length));

  const periodTotals = Array.from({ length: periodCount }, (_, i) =>
    toMoneyString(add(...results.map((r) => r.periods[i]?.amount ?? '0'))),
  );

  return {
    drivers: results,
    periodTotals,
    grandTotal: toMoneyString(add(...periodTotals)),
  };
}

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

export interface ScenarioAdjustment {
  /** Driver code or account code this adjustment targets. Omit to apply to all. */
  targetCode?: string;
  /** Multiplicative factor: 1.1 = +10%, 0.85 = -15%. */
  factor: MoneyInput;
  /** 1-based period from which the adjustment bites. Defaults to period 1. */
  appliesFromPeriod?: number;
}

export interface ScenarioDefinition {
  name: string;
  type?: string;
  description?: string;
  adjustments: ScenarioAdjustment[];
  /** Subjective likelihood, used for probability-weighted expected value. */
  probability?: number;
}

export interface ScenarioResult {
  name: string;
  type: string;
  periodTotals: string[];
  grandTotal: string;
  /** Difference from the unadjusted base case. */
  deltaFromBase: string;
  deltaPercent: number | null;
  probability: number | null;
}

/**
 * Apply a scenario's adjustments to a set of driver forecasts.
 *
 * Adjustments are multiplicative and compose: two +10% adjustments on the same
 * target give +21%, not +20%. That is deliberate - they represent independent
 * effects stacking, which is how sensitivity cases are normally described.
 */
export function applyScenario(
  drivers: readonly DriverDefinition[],
  scenario: ScenarioDefinition,
): ScenarioResult {
  const base = buildDriverBundle(drivers);
  const built = drivers.map(buildDriverForecast);
  const periodCount = base.periodTotals.length;

  const adjustedTotals = Array.from({ length: periodCount }, (_, periodIndex) => {
    let total = new Decimal(0);
    for (const driver of built) {
      const amount = toDecimal(driver.periods[periodIndex]?.amount ?? '0');
      let factor = new Decimal(1);
      for (const adjustment of scenario.adjustments) {
        if (adjustment.targetCode && adjustment.targetCode !== driver.code) continue;
        const from = (adjustment.appliesFromPeriod ?? 1) - 1;
        if (periodIndex < from) continue;
        factor = factor.times(toDecimal(adjustment.factor));
      }
      total = total.plus(amount.times(factor));
    }
    return total;
  });

  const grandTotal = adjustedTotals.reduce((a, b) => a.plus(b), new Decimal(0));
  const baseTotal = toDecimal(base.grandTotal);
  const delta = grandTotal.minus(baseTotal);

  return {
    name: scenario.name,
    type: scenario.type ?? 'CUSTOM',
    periodTotals: adjustedTotals.map((t) => toMoneyString(t)),
    grandTotal: toMoneyString(grandTotal),
    deltaFromBase: toMoneyString(delta),
    deltaPercent: baseTotal.isZero() ? null : delta.dividedBy(baseTotal.abs()).toNumber(),
    probability: scenario.probability ?? null,
  };
}

export interface ScenarioComparison {
  base: DriverBundleResult;
  scenarios: ScenarioResult[];
  /** Probability-weighted total, when every scenario carries a probability. */
  expectedValue: string | null;
  /** Sum of supplied probabilities - should be 1; surfaced so a gap is visible. */
  probabilityCoverage: number;
}

/** Run a set of scenarios against one driver bundle and compare them. */
export function compareScenarios(
  drivers: readonly DriverDefinition[],
  scenarios: readonly ScenarioDefinition[],
): ScenarioComparison {
  const base = buildDriverBundle(drivers);
  const results = scenarios.map((s) => applyScenario(drivers, s));

  const withProbability = results.filter((r) => r.probability !== null);
  const coverage = withProbability.reduce((acc, r) => acc + (r.probability as number), 0);

  const expectedValue =
    withProbability.length === results.length && results.length > 0 && coverage > 0
      ? toMoneyString(
          results
            .reduce(
              (acc, r) => acc.plus(toDecimal(r.grandTotal).times(r.probability as number)),
              new Decimal(0),
            )
            // Normalise if the probabilities do not quite sum to 1, rather than
            // silently reporting a scaled-down expected value.
            .dividedBy(coverage),
        )
      : null;

  return { base, scenarios: results, expectedValue, probabilityCoverage: coverage };
}
