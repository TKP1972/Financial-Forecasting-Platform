/**
 * Wire shapes, transcribed from the API route handlers and the engine's public
 * types. Money and rates are decimal strings; anything the API can redact or
 * omit is explicitly nullable here so the UI has to handle it.
 */
import type {
  AccountType,
  AlignmentStrength,
  AuditAction,
  BudgetCycleStatus,
  BudgetMethod,
  BudgetStatus,
  BurdenPool,
  ContractType,
  CostCategory,
  ForecastMethod,
  Permission,
  PeriodType,
  PursuitStage,
  RagStatus,
  RiskCategory,
  RiskResponse,
  RiskSeverity,
  RiskStatus,
  Role,
  StrategicHorizon,
  VarianceDirection,
} from '@ffp/shared';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}

export interface PersonRef {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface BusinessUnitRef {
  id: string;
  code: string;
  name: string;
}

// --------------------------------------------------------------------------
// Organisation
// --------------------------------------------------------------------------

export interface BusinessUnit extends BusinessUnitRef {
  parentId: string | null;
  costCentre: string | null;
  currency: string;
  owner: PersonRef | null;
  budgetCount: number;
  childCount: number;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  category: CostCategory | null;
  parentId: string | null;
  isActive: boolean;
}

export interface StrategicObjectiveSummary {
  id: string;
  code: string;
  title: string;
  description: string | null;
  horizon: StrategicHorizon;
  targetShare: string | null;
  linkedLineCount: number;
}

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

export interface ScoredRisk {
  id: string;
  title: string;
  category: RiskCategory;
  probability: number;
  impact: number;
  financialImpact: string;
  response: RiskResponse;
  residualProbability?: number;
  residualImpact?: number;
  status: RiskStatus;
  ownerId?: string;
  inherentScore: number;
  inherentSeverity: RiskSeverity;
  residualScore: number | null;
  residualSeverity: RiskSeverity | null;
  expectedValue: string;
  residualExpectedValue: string | null;
  mitigationBenefit: string | null;
  owner?: PersonRef | null;
}

export interface DashboardData {
  cycle: {
    id: string;
    name: string;
    fiscalYear: number;
    status: BudgetCycleStatus;
    baseCurrency: string;
    submissionDeadline: string;
    daysToSubmission: number;
  } | null;
  message?: string;
  budget?: {
    totalSubmitted: string;
    totalApproved: string;
    budgetCount: number;
    byStatus: Array<{ status: BudgetStatus; count: number }>;
    approvalProgress: number;
  };
  expenditure?: {
    actual: string;
    commitment: string;
    consumed: string;
    remaining: string;
    utilisation: number | null;
  };
  risk?: {
    openRisks: number;
    totalExposure: string;
    residualExposure: string;
    escalations: ScoredRisk[];
    severityCounts: Record<RiskSeverity, number>;
  };
  pipeline?: {
    activePursuits: number;
    weightedValue: string;
  };
}

// --------------------------------------------------------------------------
// Cycles
// --------------------------------------------------------------------------

export interface CycleSummary {
  id: string;
  name: string;
  fiscalYear: number;
  periodType: PeriodType;
  status: BudgetCycleStatus;
  opensAt: string;
  submissionDeadline: string;
  approvalDeadline: string;
  baseCurrency: string;
  budgetCount: number;
  assumptionCount: number;
  targetCount: number;
  guidancePublishedAt: string | null;
  daysToSubmission: number;
}

export interface CycleAssumption {
  id: string;
  key: string;
  label: string;
  value: string;
  unit: string;
  notes: string | null;
}

export interface CycleTarget {
  id: string;
  businessUnitId: string;
  revenueTarget: string | null;
  costCeiling: string | null;
  headcountCeiling: number | null;
  businessUnit: BusinessUnitRef;
}

export interface CyclePeriod {
  key: string;
  label: string;
  periodIndex: number;
  quarter: number;
  startDate: string;
  endDateExclusive: string;
}

export interface CycleDetail {
  id: string;
  name: string;
  fiscalYear: number;
  periodType: PeriodType;
  status: BudgetCycleStatus;
  opensAt: string;
  submissionDeadline: string;
  approvalDeadline: string;
  baseCurrency: string;
  guidanceNotes: string | null;
  periods: CyclePeriod[];
  assumptions: CycleAssumption[];
  targets: CycleTarget[];
  budgets: Array<{
    id: string;
    name: string;
    status: BudgetStatus;
    totalAmount: string;
    businessUnit: BusinessUnitRef;
  }>;
  guidance: {
    id: string;
    title: string;
    version: number;
    publishedAt: string | null;
    strategicPriorities: string[];
    submissionInstructions: string | null;
  } | null;
}

export interface GuidancePack {
  version: number;
  title: string;
  publishedAt: string | null;
  cycle: {
    id: string;
    name: string;
    fiscalYear: number;
    periodType: PeriodType;
    status: string;
    baseCurrency: string;
    opensAt: string;
    submissionDeadline: string;
    approvalDeadline: string;
  };
  calendar: Array<{ key: string; label: string; startDate: string; endDateExclusive: string }>;
  strategicPriorities: string[];
  objectives: Array<{ code: string; title: string; horizon: string; targetShare: string | null }>;
  assumptions: Array<{
    key: string;
    label: string;
    value: string;
    unit: string;
    displayValue: string;
    notes: string | null;
  }>;
  targets: Array<{
    businessUnitCode: string;
    businessUnitName: string;
    revenueTarget: string | null;
    costCeiling: string | null;
    headcountCeiling: number | null;
  }>;
  submissionInstructions: string | null;
  notes: string | null;
  accounts: Array<{ code: string; name: string; type: string }>;
}

// --------------------------------------------------------------------------
// Budgets
// --------------------------------------------------------------------------

export interface BudgetListItem {
  id: string;
  name: string;
  status: BudgetStatus;
  version: number;
  currency: string;
  totalAmount: string;
  lineCount: number;
  businessUnit: BusinessUnitRef;
  cycle: { id: string; name: string; fiscalYear: number };
  preparedBy: PersonRef | null;
  approvedBy: PersonRef | null;
  submittedAt: string | null;
  approvedAt: string | null;
  updatedAt: string;
  availableTransitions: BudgetStatus[];
}

export interface BudgetLinePeriod {
  id: string;
  periodKey: string;
  periodIndex: number;
  amount: string;
}

export interface BudgetLine {
  id: string;
  accountId: string;
  costCategory: CostCategory | null;
  method: BudgetMethod;
  description: string | null;
  alignment: AlignmentStrength;
  justification: string | null;
  sortOrder: number;
  totalAmount: string;
  account: { id: string; code: string; name: string; type: AccountType };
  strategicObjective: { id: string; code: string; title: string } | null;
  periods: BudgetLinePeriod[];
}

export interface BudgetApproval {
  id: string;
  fromStatus: BudgetStatus;
  toStatus: BudgetStatus;
  comment: string | null;
  amount: string;
  createdAt: string;
  approver: PersonRef | null;
}

export interface BudgetVersion {
  id: string;
  version: number;
  status: BudgetStatus;
  totalAmount: string;
  comment: string | null;
  createdAt: string;
}

export interface BudgetDetail {
  id: string;
  name: string;
  status: BudgetStatus;
  version: number;
  currency: string;
  totalAmount: string;
  submittedAt: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
  updatedAt: string;
  businessUnit: BusinessUnit;
  cycle: { id: string; name: string; fiscalYear: number; periodType: PeriodType };
  preparedBy: PersonRef | null;
  submittedBy: PersonRef | null;
  approvedBy: PersonRef | null;
  lines: BudgetLine[];
  approvals: BudgetApproval[];
  versions: BudgetVersion[];
  availableTransitions: BudgetStatus[];
}

export interface ObjectiveAllocation {
  objectiveId: string;
  code: string;
  title: string;
  horizon: StrategicHorizon;
  amount: string;
  actualShare: number;
  targetShare: number | null;
  shareGap: number | null;
  fundingGap: string | null;
  lineCount: number;
}

export interface AlignmentReport {
  totalBudget: string;
  unallocated: string;
  unallocatedShare: number;
  allocations: ObjectiveAllocation[];
  byHorizon: Array<{ horizon: StrategicHorizon; amount: string; share: number }>;
  alignmentScore: number;
  misalignments: ObjectiveAllocation[];
  observations: string[];
}

// --------------------------------------------------------------------------
// Forecasting
// --------------------------------------------------------------------------

export interface HistoryPoint {
  periodKey: string;
  value: string;
}

export interface AccuracyMetrics {
  mae: number;
  rmse: number;
  mape: number | null;
  smape: number;
  mase: number | null;
  bias: number;
  biasPercent: number | null;
  rSquared: number | null;
  n: number;
}

export interface BacktestCandidate {
  method: ForecastMethod;
  parameters: Record<string, number>;
  accuracy: AccuracyMetrics;
  score: number;
  foldCount: number;
  error?: string;
}

export interface ForecastRunResult {
  id: string;
  method: ForecastMethod;
  parameters: Record<string, number>;
  periodKeys: string[];
  point: string[];
  interval: { level: number; lower: string[]; upper: string[] } | null;
  fitted: Array<string | null>;
  accuracy: AccuracyMetrics;
  warnings: string[];
  candidates: BacktestCandidate[] | null;
  selectionCriterion: 'MASE' | 'RMSE' | null;
}

// --------------------------------------------------------------------------
// Pricing
// --------------------------------------------------------------------------

export interface PursuitListItem {
  id: string;
  name: string;
  client: string;
  stage: PursuitStage;
  contractType: ContractType;
  probabilityOfWin: string;
  durationMonths: number;
  expectedAwardDate: string | null;
  businessUnit: BusinessUnitRef;
  latestPrice: string | null;
  latestMargin: string | null;
}

export interface AppliedBurden {
  pool: BurdenPool;
  rate: string;
  base: string;
  amount: string;
  baseElements: string[];
}

export interface PricingYearResult {
  year: number;
  labourHours: number;
  directLabour: string;
  material: string;
  subcontract: string;
  otherDirect: string;
  passThrough: string;
  totalDirect: string;
  burdens: AppliedBurden[];
  totalBurden: string;
  totalCost: string;
  fee: string;
  priceBeforeDiscount: string;
  discount: string;
  price: string;
  wrapRate: string | null;
  profit: string;
}

export interface PricingTotals {
  labourHours: number;
  directLabour: string;
  material: string;
  subcontract: string;
  otherDirect: string;
  passThrough: string;
  totalDirect: string;
  totalBurden: string;
  totalCost: string;
  fee: string;
  discount: string;
  price: string;
  profit: string;
}

export interface PricingBreakdownRow {
  key: string;
  label: string;
  amount: string;
  share: number | null;
}

export interface PricingResult {
  name: string;
  contractType: ContractType;
  currency: string;
  years: PricingYearResult[];
  totals: PricingTotals;
  margin: {
    revenue: string;
    cost: string;
    grossProfit: string;
    grossMargin: number | null;
    markup: number | null;
  };
  effectiveFeeRate: string | null;
  npv: string;
  irr: number | null;
  payback: { periods: number | null; discountedPeriods: number | null };
  byLabourCategory: PricingBreakdownRow[];
  byCostCategory: PricingBreakdownRow[];
  byBurdenPool: PricingBreakdownRow[];
  assumptions: string[];
  warnings: string[];
}

export interface PriceToWinResult {
  feeRate: string;
  converged: boolean;
  iterations: number;
  residual: string;
  result: PricingResult;
  warning?: string;
}

// --------------------------------------------------------------------------
// Risk
// --------------------------------------------------------------------------

export interface RiskRegister {
  risks: ScoredRisk[];
  totalInherentExposure: string;
  totalResidualExposure: string;
  totalMitigationBenefit: string;
  severityCounts: Record<RiskSeverity, number>;
  byCategory: Array<{ category: RiskCategory; count: number; exposure: string }>;
  escalations: ScoredRisk[];
  /** [impact - 1][probability - 1] */
  heatMap: number[][];
}

export interface MonteCarloResult {
  id: string;
  name: string;
  iterations: number;
  seed: number;
  usedLatinHypercube: boolean;
  baseValue: string;
  deterministicEstimate: string;
  mean: string;
  median: string;
  standardDeviation: string;
  min: string;
  max: string;
  percentiles: Array<{ level: number; label: string; value: string }>;
  contingency: string;
  probabilityOfUnderrun: number;
  sensitivity: Array<{ code: string; label: string; correlation: number; contribution: number }>;
  histogram: Array<{ lowerBound: string; upperBound: string; count: number; frequency: number }>;
  warnings: string[];
  durationMs: number;
}

// --------------------------------------------------------------------------
// Variance
// --------------------------------------------------------------------------

export interface VarianceLine {
  key: string;
  label: string;
  accountType: AccountType;
  costCategory?: CostCategory;
  businessUnitId?: string;
  accountId?: string;
  budget: string;
  actual: string;
  commitment?: string;
  consumed: string;
  variance: string;
  variancePercent: number | null;
  direction: VarianceDirection;
  rag: RagStatus;
  remaining: string;
  utilisation: number | null;
  forecastVariance: string | null;
  forecastVariancePercent: number | null;
}

export interface VarianceGroup {
  key: string;
  label: string;
  budget: string;
  actual: string;
  commitment: string;
  consumed: string;
  variance: string;
  variancePercent: number | null;
  direction: VarianceDirection;
  rag: RagStatus;
  lineCount: number;
  lines: VarianceLine[];
}

export interface VarianceReport {
  lines: VarianceLine[];
  groups: VarianceGroup[];
  totals: Omit<VarianceGroup, 'lines' | 'key' | 'label'>;
  exceptions: VarianceLine[];
  thresholds: { amber: number; red: number; materialityFloor?: string };
  meta: {
    cycleId: string;
    fiscalYear: number;
    throughPeriod: number;
    periodsInYear: number;
    budgetsIncluded: number;
    note: string | null;
  };
}

export type ProjectionBasis = 'RUN_RATE' | 'BUDGET_REMAINING' | 'REFORECAST';

export interface ProjectionLine {
  key: string;
  label: string;
  basis: ProjectionBasis;
  budget: string;
  actualToDate: string;
  commitmentToDate: string;
  budgetToDate: string;
  varianceToDate: string;
  projectedRemaining: string;
  projectedOutturn: string;
  projectedVariance: string;
  projectedVariancePercent: number | null;
  direction: VarianceDirection;
  periodsElapsed: number;
  periodsRemaining: number;
  warnings: string[];
}

export interface ProjectionReport {
  lines: ProjectionLine[];
  totals: {
    budget: string;
    actualToDate: string;
    projectedOutturn: string;
    projectedVariance: string;
    projectedVariancePercent: number | null;
  };
  meta: {
    basis: ProjectionBasis;
    periodsElapsed: number;
    periodsInYear: number;
    basisExplanation: string;
  };
}

// --------------------------------------------------------------------------
// Governance
// --------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  sequence: string;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  summary: string;
  changes: unknown;
  actor: PersonRef | null;
  actorEmail: string | null;
  ipAddress: string | null;
  hash: string;
  previousHash: string;
  createdAt: string;
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  brokenAtSequence: string | null;
  reason: string | null;
  firstSequence: string | null;
  lastSequence: string | null;
  verifiedAt: string;
}

export interface ControlRegister {
  controls: Array<{ id: string; name: string; description: string; status: string }>;
  metrics: {
    users: number;
    activeUsers: number;
    approvedBudgets: number;
    auditEntries: number;
    lastChainVerification: string | null;
    lastChainVerificationResult: string | null;
  };
}

export interface RoleMatrixEntry {
  role: Role;
  permissions: Permission[];
  defaultApprovalLimit: string | null;
}
