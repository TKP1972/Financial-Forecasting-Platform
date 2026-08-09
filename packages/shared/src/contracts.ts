/**
 * Wire contracts.
 *
 * One Zod schema per payload, shared by the API (runtime validation + OpenAPI)
 * and the web client (compile-time types). If a field is optional here it is
 * optional everywhere - there is no second, drifting definition.
 */
import { z } from 'zod';
import {
  ACCOUNT_TYPES,
  ALIGNMENT_STRENGTHS,
  AUDIT_ACTIONS,
  BUDGET_CYCLE_STATUSES,
  BUDGET_METHODS,
  BUDGET_STATUSES,
  BURDEN_POOLS,
  CONTRACT_TYPES,
  COST_CATEGORIES,
  DISTRIBUTIONS,
  EXPORT_FORMATS,
  FORECAST_METHODS,
  PERIOD_TYPES,
  PURSUIT_STAGES,
  RISK_CATEGORIES,
  RISK_RESPONSES,
  RISK_STATUSES,
  ROLES,
  SCENARIO_TYPES,
  STRATEGIC_HORIZONS,
} from './domain.js';

// --------------------------------------------------------------------------
// Primitives
// --------------------------------------------------------------------------

/** A monetary value on the wire: always a decimal string, never a float. */
export const moneyString = z
  .string()
  .regex(/^-?(\d+(\.\d{1,6})?|\.\d{1,6})$/, 'Must be a decimal amount, e.g. "1234.56"');

/** A rate expressed as a fraction (0.325 = 32.5%). */
export const rateString = z
  .string()
  .regex(/^-?(\d+(\.\d{1,8})?|\.\d{1,8})$/, 'Must be a decimal rate, e.g. "0.325"');

export const cuid = z.string().min(1).max(64);
export const isoDate = z.string().datetime({ offset: true }).or(z.string().date());
export const periodKeySchema = z
  .string()
  .regex(/^FY\d{4}-[PQHY]\d{1,2}$/, 'Expected e.g. FY2026-P03');
export const fiscalYearSchema = z.number().int().min(1900).max(2200);

/**
 * Boolean from a query string.
 *
 * `z.coerce.boolean()` is wrong here: it applies JavaScript truthiness, so the
 * string "false" becomes `true`. Every `?flag=false` in the product would have
 * silently meant the opposite.
 */
const FALSEY = new Set(['false', '0', 'no', 'off', '']);

export const queryBoolean = z.preprocess((value) => {
  if (typeof value === 'string') return !FALSEY.has(value.trim().toLowerCase());
  return value;
}, z.boolean());

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sortBy: z.string().max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type Pagination = z.infer<typeof paginationSchema>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Registration enforces a real password policy. Length does most of the work;
 * the character-class rules exist because auditors expect to see them.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256)
  .regex(/[a-z]/, 'Must contain a lowercase letter')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/\d/, 'Must contain a digit')
  .regex(/[^A-Za-z0-9]/, 'Must contain a symbol');

export const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: passwordSchema,
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  role: z.enum(ROLES),
  businessUnitId: cuid.optional(),
  approvalLimit: moneyString.nullable().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

// --------------------------------------------------------------------------
// Organisation
// --------------------------------------------------------------------------

export const createBusinessUnitSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(24)
    .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, digits, - or _'),
  name: z.string().min(1).max(160),
  parentId: cuid.nullable().optional(),
  costCentre: z.string().max(32).optional(),
  currency: z.string().length(3).optional(),
  ownerId: cuid.nullable().optional(),
});
export type CreateBusinessUnitInput = z.infer<typeof createBusinessUnitSchema>;

export const createAccountSchema = z.object({
  code: z.string().min(1).max(24),
  name: z.string().min(1).max(160),
  type: z.enum(ACCOUNT_TYPES),
  category: z.enum(COST_CATEGORIES).optional(),
  parentId: cuid.nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

// --------------------------------------------------------------------------
// Budget cycle & guidance
// --------------------------------------------------------------------------

export const createBudgetCycleSchema = z
  .object({
    name: z.string().min(1).max(160),
    fiscalYear: fiscalYearSchema,
    periodType: z.enum(PERIOD_TYPES).default('MONTH'),
    status: z.enum(BUDGET_CYCLE_STATUSES).default('PLANNING'),
    opensAt: isoDate,
    submissionDeadline: isoDate,
    approvalDeadline: isoDate,
    baseCurrency: z.string().length(3).optional(),
    guidanceNotes: z.string().max(20000).optional(),
  })
  .refine((v) => new Date(v.opensAt) < new Date(v.submissionDeadline), {
    message: 'Submission deadline must fall after the cycle opens',
    path: ['submissionDeadline'],
  })
  .refine((v) => new Date(v.submissionDeadline) <= new Date(v.approvalDeadline), {
    message: 'Approval deadline cannot precede the submission deadline',
    path: ['approvalDeadline'],
  });
export type CreateBudgetCycleInput = z.infer<typeof createBudgetCycleSchema>;

/** Planning assumptions published centrally so every unit budgets on the same basis. */
export const budgetAssumptionSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  value: rateString,
  unit: z.enum(['RATE', 'AMOUNT', 'COUNT', 'INDEX']).default('RATE'),
  notes: z.string().max(2000).optional(),
});
export type BudgetAssumptionInput = z.infer<typeof budgetAssumptionSchema>;

export const publishGuidanceSchema = z.object({
  cycleId: cuid,
  title: z.string().min(1).max(200),
  strategicPriorities: z.array(z.string().min(1).max(500)).max(20).default([]),
  assumptions: z.array(budgetAssumptionSchema).max(100).default([]),
  submissionInstructions: z.string().max(20000).optional(),
  targets: z
    .array(
      z.object({
        businessUnitId: cuid,
        revenueTarget: moneyString.optional(),
        costCeiling: moneyString.optional(),
        headcountCeiling: z.number().int().min(0).optional(),
      }),
    )
    .default([]),
});
export type PublishGuidanceInput = z.infer<typeof publishGuidanceSchema>;

// --------------------------------------------------------------------------
// Budgets
// --------------------------------------------------------------------------

export const budgetLineSchema = z.object({
  id: cuid.optional(),
  accountId: cuid,
  costCategory: z.enum(COST_CATEGORIES).optional(),
  method: z.enum(BUDGET_METHODS).default('INCREMENTAL'),
  description: z.string().max(500).optional(),
  /**
   * One amount per period of the cycle, in period order. A single-year cycle
   * has 12 monthly periods; a Medium Term Plan spanning five years has 60.
   */
  periodAmounts: z.array(moneyString).min(1).max(120),
  driverId: cuid.nullable().optional(),
  strategicObjectiveId: cuid.nullable().optional(),
  alignment: z.enum(ALIGNMENT_STRENGTHS).default('SUPPORTING'),
  justification: z.string().max(4000).optional(),
});
export type BudgetLineInput = z.infer<typeof budgetLineSchema>;

export const createBudgetSchema = z.object({
  cycleId: cuid,
  businessUnitId: cuid,
  name: z.string().min(1).max(160),
  currency: z.string().length(3).optional(),
  lines: z.array(budgetLineSchema).max(2000).default([]),
});
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = createBudgetSchema
  .partial()
  .omit({ cycleId: true, businessUnitId: true });

export const budgetTransitionSchema = z.object({
  to: z.enum(BUDGET_STATUSES),
  comment: z.string().max(4000).optional(),
});
export type BudgetTransitionInput = z.infer<typeof budgetTransitionSchema>;

// --------------------------------------------------------------------------
// Forecasting
// --------------------------------------------------------------------------

export const historicalPointSchema = z.object({
  periodKey: periodKeySchema,
  value: moneyString,
});

export const forecastRequestSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    businessUnitId: cuid.optional(),
    accountId: cuid.optional(),
    method: z.enum(FORECAST_METHODS).or(z.literal('AUTO')).default('AUTO'),
    history: z.array(historicalPointSchema).min(2).max(240),
    horizon: z.number().int().min(1).max(60),
    seasonLength: z.number().int().min(2).max(24).optional(),
    /** Smoothing parameters; omitted values are fitted by grid search. */
    alpha: z.number().min(0.01).max(0.99).optional(),
    beta: z.number().min(0.01).max(0.99).optional(),
    gamma: z.number().min(0.01).max(0.99).optional(),
    window: z.number().int().min(2).max(24).optional(),
    confidenceLevel: z.number().min(0.5).max(0.999).default(0.95),
    /** Holdout size for backtesting when method is AUTO. */
    holdout: z.number().int().min(1).max(36).optional(),
  })
  .refine((v) => !v.seasonLength || v.history.length >= v.seasonLength * 2, {
    message: 'Seasonal methods need at least two full seasons of history',
    path: ['history'],
  });
export type ForecastRequestInput = z.infer<typeof forecastRequestSchema>;

export const driverSchema = z.object({
  code: z.string().min(1).max(48),
  name: z.string().min(1).max(160),
  unit: z.string().max(32).default('units'),
  /** Volume per period. */
  volumes: z.array(moneyString).min(1).max(60),
  /** Unit rate applied to volume; single value or one per period. */
  unitRate: z.union([moneyString, z.array(moneyString)]),
  growthRate: rateString.optional(),
});
export type DriverInput = z.infer<typeof driverSchema>;

export const scenarioSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(SCENARIO_TYPES).default('CUSTOM'),
  description: z.string().max(2000).optional(),
  /** Multiplicative adjustments applied to the base forecast, by driver or account. */
  adjustments: z
    .array(
      z.object({
        targetId: cuid.optional(),
        targetCode: z.string().max(48).optional(),
        factor: rateString,
        appliesFromPeriod: z.number().int().min(1).optional(),
      }),
    )
    .max(200)
    .default([]),
  probability: z.number().min(0).max(1).optional(),
});
export type ScenarioInput = z.infer<typeof scenarioSchema>;

// --------------------------------------------------------------------------
// Pricing
// --------------------------------------------------------------------------

export const labourLineSchema = z.object({
  labourCategory: z.string().min(1).max(120),
  /** Hours per contract year, in year order. */
  hoursByYear: z.array(z.number().min(0).max(100000)).min(1).max(10),
  baseRate: moneyString,
  escalationRate: rateString.default('0'),
  /**
   * An explicit rate per contract year, from a rate card. Overrides baseRate
   * and escalationRate: the schedule already carries the card's movement, so
   * escalating on top would double-count it.
   */
  ratesByYear: z.array(moneyString).max(20).optional(),
  fte: z.number().min(0).max(10000).optional(),
  location: z.string().max(80).optional(),
});
export type LabourLineInput = z.infer<typeof labourLineSchema>;

export const directCostLineSchema = z.object({
  description: z.string().min(1).max(240),
  category: z.enum(COST_CATEGORIES),
  amountByYear: z.array(moneyString).min(1).max(10),
  escalationRate: rateString.default('0'),
  /** Pass-through items are excluded from fee, per standard pricing practice. */
  isPassThrough: z.boolean().default(false),
});
export type DirectCostLineInput = z.infer<typeof directCostLineSchema>;

export const burdenRateSchema = z.object({
  pool: z.enum(BURDEN_POOLS),
  /** One rate per contract year; a single entry is applied to every year. */
  ratesByYear: z.array(rateString).min(1).max(10),
  /** Which preceding pools' output this pool burdens. Empty = direct costs only. */
  appliesTo: z.array(z.enum(BURDEN_POOLS)).default([]),
});
export type BurdenRateInput = z.infer<typeof burdenRateSchema>;

export const pricingModelSchema = z.object({
  pursuitId: cuid.optional(),
  name: z.string().min(1).max(160),
  contractType: z.enum(CONTRACT_TYPES),
  currency: z.string().length(3).optional(),
  years: z.number().int().min(1).max(10),
  labour: z.array(labourLineSchema).max(500).default([]),
  directCosts: z.array(directCostLineSchema).max(500).default([]),
  burdens: z.array(burdenRateSchema).max(10).default([]),
  /** Target fee as a fraction of burdened cost. */
  feeRate: rateString.default('0'),
  /** Optional discount applied to the final price. */
  discountRate: rateString.default('0'),
  /** Annual discount rate used for NPV of the cash flows. */
  costOfCapital: rateString.default('0.10'),
  assumptions: z.array(z.string().max(1000)).max(100).default([]),
});
export type PricingModelInput = z.infer<typeof pricingModelSchema>;

/** Goal-seek: solve for the fee rate that hits a target margin or price. */
export const priceToWinSchema = z.object({
  model: pricingModelSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('MARGIN'), value: rateString }),
    z.object({ kind: z.literal('PRICE'), value: moneyString }),
  ]),
});
export type PriceToWinInput = z.infer<typeof priceToWinSchema>;

export const createPursuitSchema = z.object({
  name: z.string().min(1).max(200),
  client: z.string().min(1).max(200),
  businessUnitId: cuid,
  stage: z.enum(PURSUIT_STAGES).default('IDENTIFIED'),
  contractType: z.enum(CONTRACT_TYPES),
  probabilityOfWin: z.number().min(0).max(1).default(0.3),
  expectedAwardDate: isoDate.optional(),
  durationMonths: z.number().int().min(1).max(120),
  notes: z.string().max(8000).optional(),
});
export type CreatePursuitInput = z.infer<typeof createPursuitSchema>;

// --------------------------------------------------------------------------
// Risk
// --------------------------------------------------------------------------

export const createRiskSchema = z.object({
  title: z.string().min(1).max(240),
  description: z.string().max(8000).optional(),
  category: z.enum(RISK_CATEGORIES),
  businessUnitId: cuid.optional(),
  budgetId: cuid.optional(),
  pursuitId: cuid.optional(),
  /** 1-5 on the standard heat map axes. */
  probability: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  financialImpact: moneyString,
  response: z.enum(RISK_RESPONSES).default('MITIGATE'),
  mitigationPlan: z.string().max(8000).optional(),
  residualProbability: z.number().int().min(1).max(5).optional(),
  residualImpact: z.number().int().min(1).max(5).optional(),
  ownerId: cuid.optional(),
  status: z.enum(RISK_STATUSES).default('OPEN'),
  reviewDate: isoDate.optional(),
});
export type CreateRiskInput = z.infer<typeof createRiskSchema>;

export const uncertainInputSchema = z.object({
  code: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  distribution: z.enum(DISTRIBUTIONS),
  /** Distribution parameters; which keys are required depends on the type. */
  min: z.number().optional(),
  mode: z.number().optional(),
  max: z.number().optional(),
  mean: z.number().optional(),
  stdDev: z.number().optional(),
  /** DISCRETE only. */
  outcomes: z
    .array(z.object({ value: z.number(), probability: z.number().min(0).max(1) }))
    .optional(),
});
export type UncertainInputSpec = z.infer<typeof uncertainInputSchema>;

export const monteCarloSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  iterations: z.number().int().min(1000).max(200000).default(10000),
  /** Fixed seed keeps a published simulation reproducible for audit. */
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .default(20260101),
  baseValue: moneyString,
  inputs: z.array(uncertainInputSchema).min(1).max(50),
  /** Risk register entries folded in as probability-weighted discrete events. */
  riskEvents: z
    .array(
      z.object({
        riskId: cuid.optional(),
        label: z.string().max(160),
        probability: z.number().min(0).max(1),
        impactMin: z.number(),
        impactMode: z.number(),
        impactMax: z.number(),
      }),
    )
    .max(200)
    .default([]),
  confidenceLevels: z.array(z.number().min(0).max(1)).max(10).default([0.1, 0.5, 0.8, 0.9, 0.95]),
});
export type MonteCarloInput = z.infer<typeof monteCarloSchema>;

// --------------------------------------------------------------------------
// Actuals & variance
// --------------------------------------------------------------------------

export const actualEntrySchema = z.object({
  businessUnitId: cuid,
  accountId: cuid,
  periodKey: periodKeySchema,
  amount: moneyString,
  /** Committed-but-unspent, so "remaining budget" reflects reality. */
  commitment: moneyString.optional(),
  source: z.string().max(64).default('MANUAL'),
  reference: z.string().max(120).optional(),
});
export type ActualEntryInput = z.infer<typeof actualEntrySchema>;

export const importActualsSchema = z.object({
  cycleId: cuid,
  entries: z.array(actualEntrySchema).min(1).max(10000),
  /** Replace existing entries for the same BU/account/period instead of adding. */
  mode: z.enum(['UPSERT', 'APPEND']).default('UPSERT'),
});
export type ImportActualsInput = z.infer<typeof importActualsSchema>;

export const varianceQuerySchema = z.object({
  cycleId: cuid,
  businessUnitId: cuid.optional(),
  accountId: cuid.optional(),
  // Query-string values arrive as strings, so these must coerce.
  throughPeriod: z.coerce.number().int().min(1).max(12).optional(),
  includeCommitments: queryBoolean.default(true),
  groupBy: z.enum(['ACCOUNT', 'BUSINESS_UNIT', 'COST_CATEGORY', 'PERIOD']).default('ACCOUNT'),
  /** Absolute and percentage thresholds for RAG banding. */
  amberThreshold: z.coerce.number().min(0).max(1).default(0.05),
  redThreshold: z.coerce.number().min(0).max(1).default(0.1),
});
export type VarianceQueryInput = z.infer<typeof varianceQuerySchema>;

// --------------------------------------------------------------------------
// Strategy
// --------------------------------------------------------------------------

export const strategicObjectiveSchema = z.object({
  code: z.string().min(1).max(24),
  title: z.string().min(1).max(240),
  description: z.string().max(4000).optional(),
  horizon: z.enum(STRATEGIC_HORIZONS).default('H1_CORE'),
  ownerId: cuid.optional(),
  /** Share of total budget leadership intends this objective to receive. */
  targetShare: rateString.optional(),
});
export type StrategicObjectiveInput = z.infer<typeof strategicObjectiveSchema>;

// --------------------------------------------------------------------------
// Reporting & export
// --------------------------------------------------------------------------

export const exportRequestSchema = z.object({
  format: z.enum(EXPORT_FORMATS).default('XLSX'),
  includeAssumptions: z.boolean().default(true),
  includeVariance: z.boolean().default(true),
  includeRisk: z.boolean().default(true),
  includeCharts: z.boolean().default(false),
});
export type ExportRequestInput = z.infer<typeof exportRequestSchema>;

export const auditQuerySchema = paginationSchema.extend({
  entityType: z.string().max(64).optional(),
  entityId: cuid.optional(),
  actorId: cuid.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
