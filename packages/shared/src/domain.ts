/**
 * The platform's shared vocabulary.
 *
 * These constants are duplicated as Prisma enums in the API package. They are
 * declared here as the single source of truth for the front end and the engine,
 * and a test asserts the two stay in step.
 */

// --------------------------------------------------------------------------
// Identity & access
// --------------------------------------------------------------------------

/**
 * Roles are ordered least- to most-privileged. `rank` drives "at least this
 * role" checks; explicit permissions still govern what each one may actually do.
 */
export const ROLES = [
  'VIEWER',
  'ANALYST',
  'BUDGET_OWNER',
  'FINANCE_MANAGER',
  'CFO',
  'ADMIN',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 10,
  ANALYST: 20,
  BUDGET_OWNER: 30,
  FINANCE_MANAGER: 40,
  CFO: 50,
  ADMIN: 60,
};

export const ROLE_LABELS: Record<Role, string> = {
  VIEWER: 'Viewer',
  ANALYST: 'Financial Analyst',
  BUDGET_OWNER: 'Budget Owner',
  FINANCE_MANAGER: 'Finance Manager',
  CFO: 'Chief Financial Officer',
  ADMIN: 'System Administrator',
};

// --------------------------------------------------------------------------
// Budget lifecycle
// --------------------------------------------------------------------------

/**
 * The budget workflow. Transitions are constrained by {@link BUDGET_TRANSITIONS};
 * LOCKED is terminal, which is what makes an approved budget a stable baseline
 * for variance reporting.
 */
export const BUDGET_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'LOCKED',
] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

export const BUDGET_TRANSITIONS: Record<BudgetStatus, readonly BudgetStatus[]> = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['DRAFT', 'SUBMITTED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'IN_REVIEW'],
  APPROVED: ['LOCKED', 'IN_REVIEW'],
  REJECTED: ['DRAFT'],
  LOCKED: [],
};

/** Which role may drive each transition. Enforced server-side, mirrored in the UI. */
export const TRANSITION_MIN_ROLE: Record<BudgetStatus, Role> = {
  DRAFT: 'ANALYST',
  IN_REVIEW: 'ANALYST',
  SUBMITTED: 'BUDGET_OWNER',
  APPROVED: 'FINANCE_MANAGER',
  REJECTED: 'FINANCE_MANAGER',
  LOCKED: 'CFO',
};

export const BUDGET_CYCLE_STATUSES = ['PLANNING', 'OPEN', 'CONSOLIDATING', 'CLOSED'] as const;
export type BudgetCycleStatus = (typeof BUDGET_CYCLE_STATUSES)[number];

/**
 * How a budget line was arrived at. Recorded per line because reviewers ask
 * "where did this number come from?" more than any other question.
 */
export const BUDGET_METHODS = [
  'INCREMENTAL',
  'ZERO_BASED',
  'DRIVER_BASED',
  'ACTIVITY_BASED',
  'ROLLING_FORECAST',
] as const;
export type BudgetMethod = (typeof BUDGET_METHODS)[number];

// --------------------------------------------------------------------------
// Chart of accounts
// --------------------------------------------------------------------------

export const ACCOUNT_TYPES = ['REVENUE', 'COGS', 'OPEX', 'CAPEX', 'HEADCOUNT', 'OTHER'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Sign convention: for revenue, actual > budget is *favourable*; for cost it is
 * unfavourable. Getting this backwards is the classic variance-report bug, so
 * the direction lives in one place.
 */
export const FAVOURABLE_WHEN_OVER: Record<AccountType, boolean> = {
  REVENUE: true,
  COGS: false,
  OPEX: false,
  CAPEX: false,
  HEADCOUNT: false,
  OTHER: false,
};

/**
 * Telecom spend taxonomy, for spend analytics and optimisation.
 *
 * Deliberately separate from {@link COST_CATEGORIES}: that one describes what
 * kind of cost element a line is, for building a price up (labour, material,
 * subcontract...). This one describes what the money was spent *on*, which is
 * the axis you optimise along. A single "network operations" cost element can be
 * access spend in one unit and transport spend in another.
 */
export const SPEND_CATEGORIES = [
  'ACCESS',
  'TRANSPORT',
  'EQUIPMENT',
  'SOFTWARE_SAAS',
  'FACILITIES',
  'LABOUR',
  'OTHER',
] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export const SPEND_CATEGORY_LABELS: Record<SpendCategory, string> = {
  ACCESS: 'Access & last mile',
  TRANSPORT: 'Transport & backhaul',
  EQUIPMENT: 'Equipment & hardware',
  SOFTWARE_SAAS: 'Software & SaaS',
  FACILITIES: 'Facilities & power',
  LABOUR: 'Labour & contractors',
  OTHER: 'Other spend',
};

/**
 * How a cost responds to volume.
 *
 * Without this, "we spent 12% more" cannot be split into "we did 12% more work"
 * and "we got 12% worse at it" - which is the whole point of the distinction.
 * SEMI_VARIABLE carries a fixed floor plus a variable element; the variable
 * share is held on the line rather than assumed.
 */
export const COST_BEHAVIOURS = ['FIXED', 'VARIABLE', 'SEMI_VARIABLE'] as const;
export type CostBehaviour = (typeof COST_BEHAVIOURS)[number];

export const COST_BEHAVIOUR_LABELS: Record<CostBehaviour, string> = {
  FIXED: 'Fixed',
  VARIABLE: 'Variable',
  SEMI_VARIABLE: 'Semi-variable',
};

/**
 * Sensible default behaviour per spend category, used when a line does not
 * declare its own. These are defaults, not rules - a fully committed transport
 * circuit is fixed even though transport is usually variable.
 */
export const DEFAULT_BEHAVIOUR_BY_SPEND_CATEGORY: Record<SpendCategory, CostBehaviour> = {
  ACCESS: 'VARIABLE',
  TRANSPORT: 'SEMI_VARIABLE',
  EQUIPMENT: 'FIXED',
  SOFTWARE_SAAS: 'SEMI_VARIABLE',
  FACILITIES: 'FIXED',
  LABOUR: 'SEMI_VARIABLE',
  OTHER: 'FIXED',
};

export const COST_CATEGORIES = [
  'DIRECT_LABOUR',
  'SUBCONTRACT',
  'MATERIAL',
  'EQUIPMENT',
  'TRAVEL',
  'FACILITIES',
  'SOFTWARE',
  'PROFESSIONAL_SERVICES',
  'OTHER_DIRECT',
  'INDIRECT',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

// --------------------------------------------------------------------------
// Periods
// --------------------------------------------------------------------------

export const PERIOD_TYPES = ['MONTH', 'QUARTER', 'HALF', 'YEAR'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

export const PERIODS_PER_YEAR: Record<PeriodType, number> = {
  MONTH: 12,
  QUARTER: 4,
  HALF: 2,
  YEAR: 1,
};

// --------------------------------------------------------------------------
// Forecasting
// --------------------------------------------------------------------------

export const FORECAST_METHODS = [
  'NAIVE',
  'SEASONAL_NAIVE',
  'MOVING_AVERAGE',
  'WEIGHTED_MOVING_AVERAGE',
  'SIMPLE_EXPONENTIAL_SMOOTHING',
  'HOLT_LINEAR',
  'HOLT_WINTERS_ADDITIVE',
  'HOLT_WINTERS_MULTIPLICATIVE',
  'LINEAR_REGRESSION',
  'DRIVER_BASED',
  'RUN_RATE',
] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

export const FORECAST_METHOD_LABELS: Record<ForecastMethod, string> = {
  NAIVE: 'Naive (last value)',
  SEASONAL_NAIVE: 'Seasonal naive',
  MOVING_AVERAGE: 'Moving average',
  WEIGHTED_MOVING_AVERAGE: 'Weighted moving average',
  SIMPLE_EXPONENTIAL_SMOOTHING: 'Simple exponential smoothing',
  HOLT_LINEAR: "Holt's linear trend",
  HOLT_WINTERS_ADDITIVE: 'Holt-Winters (additive seasonality)',
  HOLT_WINTERS_MULTIPLICATIVE: 'Holt-Winters (multiplicative seasonality)',
  LINEAR_REGRESSION: 'Ordinary least squares trend',
  DRIVER_BASED: 'Driver-based build-up',
  RUN_RATE: 'Annualised run rate',
};

export const SCENARIO_TYPES = ['BASE', 'BEST', 'WORST', 'STRETCH', 'CUSTOM'] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];

// --------------------------------------------------------------------------
// Pricing
// --------------------------------------------------------------------------

export const PURSUIT_STAGES = [
  'IDENTIFIED',
  'QUALIFIED',
  'PROPOSAL',
  'SUBMITTED',
  'NEGOTIATION',
  'WON',
  'LOST',
  'WITHDRAWN',
] as const;
export type PursuitStage = (typeof PURSUIT_STAGES)[number];

export const CONTRACT_TYPES = [
  'FIRM_FIXED_PRICE',
  'TIME_AND_MATERIALS',
  'COST_PLUS_FIXED_FEE',
  'COST_PLUS_INCENTIVE_FEE',
  'MANAGED_SERVICE',
  'SUBSCRIPTION',
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/**
 * Indirect cost pools, in the order they are applied. Each pool burdens the
 * running subtotal produced by the pools before it - order is the whole point.
 */
export const BURDEN_POOLS = ['FRINGE', 'OVERHEAD', 'MATERIAL_HANDLING', 'GA', 'COM'] as const;
export type BurdenPool = (typeof BURDEN_POOLS)[number];

export const BURDEN_POOL_LABELS: Record<BurdenPool, string> = {
  FRINGE: 'Fringe benefits',
  OVERHEAD: 'Overhead',
  MATERIAL_HANDLING: 'Material handling',
  GA: 'General & administrative',
  COM: 'Cost of money',
};

// --------------------------------------------------------------------------
// Risk
// --------------------------------------------------------------------------

export const RISK_CATEGORIES = [
  'FINANCIAL',
  'OPERATIONAL',
  'STRATEGIC',
  'COMPLIANCE',
  'TECHNICAL',
  'MARKET',
  'SUPPLY_CHAIN',
  'REGULATORY',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_RESPONSES = ['AVOID', 'MITIGATE', 'TRANSFER', 'ACCEPT'] as const;
export type RiskResponse = (typeof RISK_RESPONSES)[number];

export const RISK_STATUSES = ['OPEN', 'MONITORING', 'MITIGATED', 'REALISED', 'CLOSED'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

/** 5x5 heat map bands, derived from probability x impact score. */
export const RISK_SEVERITIES = ['LOW', 'MODERATE', 'HIGH', 'SEVERE', 'CRITICAL'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const DISTRIBUTIONS = [
  'TRIANGULAR',
  'PERT',
  'NORMAL',
  'LOGNORMAL',
  'UNIFORM',
  'DISCRETE',
] as const;
export type DistributionType = (typeof DISTRIBUTIONS)[number];

// --------------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------------

/** Red/amber/green banding used across dashboards and the leadership pack. */
export const RAG_STATUSES = ['GREEN', 'AMBER', 'RED'] as const;
export type RagStatus = (typeof RAG_STATUSES)[number];

export const VARIANCE_DIRECTIONS = ['FAVOURABLE', 'UNFAVOURABLE', 'NEUTRAL'] as const;
export type VarianceDirection = (typeof VARIANCE_DIRECTIONS)[number];

export const EXPORT_FORMATS = ['XLSX', 'PDF', 'CSV', 'MARKDOWN', 'JSON'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'LOCK',
  'UNLOCK',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'EXPORT',
  /**
   * Bulk load of reference data. Distinct from CREATE because "who added this
   * account?" and "which import run added it?" are different questions.
   */
  'IMPORT',
  'RECALCULATE',
  'SIMULATE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// --------------------------------------------------------------------------
// Strategic alignment
// --------------------------------------------------------------------------

/**
 * Budget lines link to strategic objectives so leadership can answer "what are we
 * actually funding?" - the education-and-alignment part of the mandate.
 */
export const STRATEGIC_HORIZONS = ['H1_CORE', 'H2_ADJACENT', 'H3_TRANSFORMATIONAL'] as const;
export type StrategicHorizon = (typeof STRATEGIC_HORIZONS)[number];

export const ALIGNMENT_STRENGTHS = ['DIRECT', 'SUPPORTING', 'INDIRECT', 'NONE'] as const;
export type AlignmentStrength = (typeof ALIGNMENT_STRENGTHS)[number];

/** Weighting used when scoring how well a budget maps onto strategy. */
export const ALIGNMENT_WEIGHT: Record<AlignmentStrength, number> = {
  DIRECT: 1,
  SUPPORTING: 0.6,
  INDIRECT: 0.3,
  NONE: 0,
};
