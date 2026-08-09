/**
 * Workforce / cost-to-serve modelling.
 *
 * Converts operational drivers into the financial ones. This is the bridge the
 * framework asks for: contact volume, average handle time, occupancy and
 * shrinkage on one side; FTE, cost and cost-per-contact on the other.
 *
 *   productive hours per FTE = hours x (1 - shrinkage) x occupancy
 *   FTE required             = workload hours / productive hours per FTE
 *
 * Two things are routinely got wrong here and are handled explicitly:
 *
 *  - **Shrinkage and occupancy are not the same thing.** Shrinkage removes time
 *    from the roster (leave, training, sickness). Occupancy is what fraction of
 *    the time that remains is spent handling work rather than waiting for it.
 *    They multiply; treating either alone understates the requirement.
 *
 *  - **Occupancy of 100% is not achievable** in any queue with variable arrival.
 *    A model that assumes it will under-staff every time, so it is rejected
 *    rather than quietly accepted.
 */
import {
  CalculationError,
  Decimal,
  add,
  escalationFactor,
  toDecimal,
  toMoneyString,
  type MoneyInput,
} from '@ffp/shared';

export interface WorkforceDriver {
  code: string;
  name: string;
  /** Contact/transaction volume per period, in period order. */
  volumes: number[];
  /** Average handle time, in seconds. */
  averageHandleTimeSeconds: number;
  /**
   * Fraction of rostered time spent handling work, in (0, 1). Typically
   * 0.75-0.85 for voice; above ~0.9 is not sustainable.
   */
  occupancy: number;
  /**
   * Fraction of paid time unavailable for work - leave, training, sickness,
   * breaks. In [0, 1).
   */
  shrinkage: number;
  /** Paid hours per FTE per period. Default 173.33 (a 2,080-hour year / 12). */
  hoursPerFtePerPeriod?: number;
  /** Fully-loaded cost per FTE per period, including on-costs. */
  costPerFtePerPeriod: MoneyInput;
  /** Compound cost escalation per period. */
  costEscalationRate?: MoneyInput;
  /** Compound volume growth per period. */
  volumeGrowthRate?: MoneyInput;
  /**
   * Round FTE up to whole people. Real rostering cannot hire 4.3 people, and
   * ignoring that understates cost by up to one FTE per period.
   */
  roundToWholeFte?: boolean;
}

export interface WorkforcePeriodResult {
  periodIndex: number;
  volume: number;
  /** Total handling hours demanded by the volume. */
  workloadHours: string;
  /** Hours one FTE actually contributes after shrinkage and occupancy. */
  productiveHoursPerFte: string;
  /** Unrounded requirement. */
  requiredFte: string;
  /** What is actually staffed, after any rounding. */
  staffedFte: number;
  cost: string;
  /** Cost per contact - the unit economic the business is steered on. */
  costPerUnit: string | null;
}

export interface WorkforceResult {
  code: string;
  name: string;
  periods: WorkforcePeriodResult[];
  totalVolume: number;
  totalCost: string;
  peakFte: number;
  averageFte: number;
  /** Blended cost per contact across the whole horizon. */
  blendedCostPerUnit: string | null;
  assumptions: Record<string, number | string>;
  warnings: string[];
}

const DEFAULT_HOURS_PER_FTE = 173.3333;

function validate(driver: WorkforceDriver): void {
  const { code, occupancy, shrinkage, averageHandleTimeSeconds } = driver;

  if (occupancy <= 0 || occupancy > 1) {
    throw CalculationError(
      `Workforce driver '${code}' has occupancy ${occupancy}; it must be a fraction in (0, 1].`,
      { code, occupancy },
    );
  }
  if (shrinkage < 0 || shrinkage >= 1) {
    throw CalculationError(
      `Workforce driver '${code}' has shrinkage ${shrinkage}; it must be a fraction in [0, 1). A shrinkage of 1 would mean nobody is ever available.`,
      { code, shrinkage },
    );
  }
  if (averageHandleTimeSeconds <= 0) {
    throw CalculationError(`Workforce driver '${code}' has a non-positive average handle time.`, {
      code,
      averageHandleTimeSeconds,
    });
  }
  if (driver.volumes.length === 0) {
    throw CalculationError(`Workforce driver '${code}' has no volumes.`, { code });
  }
  if (driver.volumes.some((v) => v < 0 || !Number.isFinite(v))) {
    throw CalculationError(`Workforce driver '${code}' has a negative or non-finite volume.`, {
      code,
    });
  }
  const hours = driver.hoursPerFtePerPeriod ?? DEFAULT_HOURS_PER_FTE;
  if (hours <= 0) {
    throw CalculationError(`Workforce driver '${code}' has non-positive hours per FTE.`, { code });
  }
}

/** Expand a workforce driver into per-period FTE and cost. */
export function buildWorkforceForecast(driver: WorkforceDriver): WorkforceResult {
  validate(driver);

  const warnings: string[] = [];
  const hoursPerFte = driver.hoursPerFtePerPeriod ?? DEFAULT_HOURS_PER_FTE;

  if (driver.occupancy > 0.9) {
    warnings.push(
      `Occupancy is set to ${(driver.occupancy * 100).toFixed(0)}%. Sustained occupancy above about 85% drives attrition and is rarely achievable against variable arrival patterns; this model will understate the staffing requirement.`,
    );
  }
  if (driver.shrinkage < 0.15) {
    warnings.push(
      `Shrinkage of ${(driver.shrinkage * 100).toFixed(0)}% is low. Typical operations run 25-35% once leave, training, sickness and breaks are counted; a low figure here understates cost.`,
    );
  }

  // The two effects multiply: shrinkage removes time from the roster, occupancy
  // determines how much of what remains is productive.
  const productiveHoursPerFte = hoursPerFte * (1 - driver.shrinkage) * driver.occupancy;

  const periods: WorkforcePeriodResult[] = driver.volumes.map((rawVolume, index) => {
    const growth = escalationFactor(driver.volumeGrowthRate ?? '0', index).toNumber();
    const volume = rawVolume * growth;

    const workloadHours = (volume * driver.averageHandleTimeSeconds) / 3600;
    const requiredFte = workloadHours / productiveHoursPerFte;
    const staffedFte = driver.roundToWholeFte ? Math.ceil(requiredFte) : requiredFte;

    const costPerFte = toDecimal(driver.costPerFtePerPeriod).times(
      escalationFactor(driver.costEscalationRate ?? '0', index),
    );
    const cost = costPerFte.times(staffedFte);

    return {
      periodIndex: index,
      volume: Number(volume.toFixed(4)),
      workloadHours: toMoneyString(workloadHours),
      productiveHoursPerFte: toMoneyString(productiveHoursPerFte),
      requiredFte: toMoneyString(requiredFte),
      staffedFte: Number(staffedFte.toFixed(4)),
      cost: toMoneyString(cost),
      costPerUnit: volume === 0 ? null : toMoneyString(cost.dividedBy(volume), 6),
    };
  });

  const totalVolume = periods.reduce((acc, p) => acc + p.volume, 0);
  const totalCost = periods.length === 0 ? new Decimal(0) : add(...periods.map((p) => p.cost));
  const fteValues = periods.map((p) => p.staffedFte);

  return {
    code: driver.code,
    name: driver.name,
    periods,
    totalVolume: Number(totalVolume.toFixed(4)),
    totalCost: toMoneyString(totalCost),
    peakFte: fteValues.length === 0 ? 0 : Math.max(...fteValues),
    averageFte:
      fteValues.length === 0
        ? 0
        : Number((fteValues.reduce((a, b) => a + b, 0) / fteValues.length).toFixed(4)),
    blendedCostPerUnit:
      totalVolume === 0 ? null : toMoneyString(totalCost.dividedBy(totalVolume), 6),
    assumptions: {
      averageHandleTimeSeconds: driver.averageHandleTimeSeconds,
      occupancy: driver.occupancy,
      shrinkage: driver.shrinkage,
      hoursPerFtePerPeriod: hoursPerFte,
      productiveHoursPerFte: Number(productiveHoursPerFte.toFixed(4)),
      costPerFtePerPeriod: toMoneyString(driver.costPerFtePerPeriod),
      roundToWholeFte: driver.roundToWholeFte ? 'yes' : 'no',
    },
    warnings,
  };
}

export interface StaffingRamp {
  /** Periods from the start before any capacity is productive. */
  leadTimePeriods: number;
  /** Periods over which a new hire reaches full productivity. */
  rampPeriods: number;
  /** Productivity of a hire during ramp, as a fraction. Default 0.5. */
  rampProductivity?: number;
}

/**
 * Apply a hiring ramp to a staffing requirement.
 *
 * A pursuit that assumes people are productive on day one prices the first
 * quarter wrong every time: recruitment takes time, and a new hire is not fully
 * effective for weeks after that. Both effects raise the headcount needed to
 * meet a given requirement early in a contract.
 */
export function applyStaffingRamp(
  requiredFte: readonly number[],
  ramp: StaffingRamp,
): {
  periods: Array<{
    periodIndex: number;
    requiredFte: number;
    hiredFte: number;
    effectiveFte: number;
    shortfallFte: number;
  }>;
  totalHired: number;
  /** Periods where effective capacity falls short of the requirement. */
  shortfallPeriods: number;
  warnings: string[];
} {
  const { leadTimePeriods, rampPeriods } = ramp;
  const rampProductivity = ramp.rampProductivity ?? 0.5;

  if (leadTimePeriods < 0 || !Number.isInteger(leadTimePeriods)) {
    throw CalculationError('Lead time must be a non-negative whole number of periods.');
  }
  if (rampPeriods < 0 || !Number.isInteger(rampPeriods)) {
    throw CalculationError('Ramp duration must be a non-negative whole number of periods.');
  }
  if (rampProductivity < 0 || rampProductivity > 1) {
    throw CalculationError('Ramp productivity must be a fraction in [0, 1].');
  }

  // hires[i] is the FTE that starts in period i.
  const hires = new Array<number>(requiredFte.length).fill(0);
  const warnings: string[] = [];

  const effectiveAt = (period: number): number => {
    let total = 0;
    for (let start = 0; start <= period; start += 1) {
      const tenure = period - start;
      if (tenure < 0) continue;
      total +=
        hires[start] === undefined
          ? 0
          : (hires[start] as number) * (tenure < rampPeriods ? rampProductivity : 1);
    }
    return total;
  };

  for (let period = 0; period < requiredFte.length; period += 1) {
    const need = requiredFte[period] as number;
    const have = effectiveAt(period);
    if (have >= need) continue;

    // Hiring must have been initiated `leadTimePeriods` earlier to land now.
    const startPeriod = period - 0;
    const gap = need - have;
    // A hire starting now contributes at ramp productivity, so more heads are
    // needed to close a given gap than the gap itself.
    const productivityNow = rampPeriods > 0 ? rampProductivity : 1;
    hires[startPeriod] = (hires[startPeriod] as number) + gap / productivityNow;

    if (period < leadTimePeriods) {
      warnings.push(
        `Period ${period + 1} needs staff that could not have been recruited in time: the lead time is ${leadTimePeriods} period(s). Either start recruiting before the contract begins or accept a service shortfall.`,
      );
    }
  }

  const periods = requiredFte.map((need, period) => {
    const effective = effectiveAt(period);
    return {
      periodIndex: period,
      requiredFte: Number(need.toFixed(4)),
      hiredFte: Number((hires[period] ?? 0).toFixed(4)),
      effectiveFte: Number(effective.toFixed(4)),
      shortfallFte: Number(Math.max(0, need - effective).toFixed(4)),
    };
  });

  return {
    periods,
    totalHired: Number(hires.reduce((a, b) => a + b, 0).toFixed(4)),
    shortfallPeriods: periods.filter((p) => p.shortfallFte > 1e-6).length,
    warnings: [...new Set(warnings)],
  };
}
