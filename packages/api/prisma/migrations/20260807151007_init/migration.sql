-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VIEWER', 'ANALYST', 'BUDGET_OWNER', 'FINANCE_MANAGER', 'CFO', 'ADMIN');

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "BudgetCycleStatus" AS ENUM ('PLANNING', 'OPEN', 'CONSOLIDATING', 'CLOSED');

-- CreateEnum
CREATE TYPE "BudgetMethod" AS ENUM ('INCREMENTAL', 'ZERO_BASED', 'DRIVER_BASED', 'ACTIVITY_BASED', 'ROLLING_FORECAST');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('REVENUE', 'COGS', 'OPEX', 'CAPEX', 'HEADCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('DIRECT_LABOUR', 'SUBCONTRACT', 'MATERIAL', 'EQUIPMENT', 'TRAVEL', 'FACILITIES', 'SOFTWARE', 'PROFESSIONAL_SERVICES', 'OTHER_DIRECT', 'INDIRECT');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('MONTH', 'QUARTER', 'HALF', 'YEAR');

-- CreateEnum
CREATE TYPE "ForecastMethod" AS ENUM ('NAIVE', 'SEASONAL_NAIVE', 'MOVING_AVERAGE', 'WEIGHTED_MOVING_AVERAGE', 'SIMPLE_EXPONENTIAL_SMOOTHING', 'HOLT_LINEAR', 'HOLT_WINTERS_ADDITIVE', 'HOLT_WINTERS_MULTIPLICATIVE', 'LINEAR_REGRESSION', 'DRIVER_BASED', 'RUN_RATE');

-- CreateEnum
CREATE TYPE "ScenarioType" AS ENUM ('BASE', 'BEST', 'WORST', 'STRETCH', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PursuitStage" AS ENUM ('IDENTIFIED', 'QUALIFIED', 'PROPOSAL', 'SUBMITTED', 'NEGOTIATION', 'WON', 'LOST', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('FIRM_FIXED_PRICE', 'TIME_AND_MATERIALS', 'COST_PLUS_FIXED_FEE', 'COST_PLUS_INCENTIVE_FEE', 'MANAGED_SERVICE', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('FINANCIAL', 'OPERATIONAL', 'STRATEGIC', 'COMPLIANCE', 'TECHNICAL', 'MARKET', 'SUPPLY_CHAIN', 'REGULATORY');

-- CreateEnum
CREATE TYPE "RiskResponse" AS ENUM ('AVOID', 'MITIGATE', 'TRANSFER', 'ACCEPT');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'MONITORING', 'MITIGATED', 'REALISED', 'CLOSED');

-- CreateEnum
CREATE TYPE "StrategicHorizon" AS ENUM ('H1_CORE', 'H2_ADJACENT', 'H3_TRANSFORMATIONAL');

-- CreateEnum
CREATE TYPE "AlignmentStrength" AS ENUM ('DIRECT', 'SUPPORTING', 'INDIRECT', 'NONE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'SUBMIT', 'APPROVE', 'REJECT', 'LOCK', 'UNLOCK', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'EXPORT', 'RECALCULATE', 'SIMULATE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "businessUnitId" TEXT,
    "approvalLimit" DECIMAL(18,4),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "costCentre" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ownerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "category" "CostCategory",
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategic_objectives" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "horizon" "StrategicHorizon" NOT NULL DEFAULT 'H1_CORE',
    "ownerId" TEXT,
    "targetShare" DECIMAL(18,8),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategic_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_cycles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "periodType" "PeriodType" NOT NULL DEFAULT 'MONTH',
    "status" "BudgetCycleStatus" NOT NULL DEFAULT 'PLANNING',
    "opensAt" TIMESTAMP(3) NOT NULL,
    "submissionDeadline" TIMESTAMP(3) NOT NULL,
    "approvalDeadline" TIMESTAMP(3) NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
    "guidanceNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_assumptions" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" DECIMAL(18,8) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'RATE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_assumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_guidance" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "strategicPriorities" JSONB NOT NULL DEFAULT '[]',
    "submissionInstructions" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_guidance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_targets" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL,
    "revenueTarget" DECIMAL(18,4),
    "costCeiling" DECIMAL(18,4),
    "headcountCeiling" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "preparedById" TEXT,
    "submittedById" TEXT,
    "approvedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "totalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "costCategory" "CostCategory",
    "method" "BudgetMethod" NOT NULL DEFAULT 'INCREMENTAL',
    "description" TEXT,
    "driverId" TEXT,
    "strategicObjectiveId" TEXT,
    "alignment" "AlignmentStrength" NOT NULL DEFAULT 'SUPPORTING',
    "justification" TEXT,
    "totalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_line_periods" (
    "id" TEXT NOT NULL,
    "budgetLineId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "budget_line_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_versions" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BudgetStatus" NOT NULL,
    "totalAmount" DECIMAL(18,4) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "fromStatus" "BudgetStatus" NOT NULL,
    "toStatus" "BudgetStatus" NOT NULL,
    "comment" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actuals" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "commitment" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "actuals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'units',
    "businessUnitId" TEXT,
    "description" TEXT,
    "volumes" JSONB NOT NULL DEFAULT '[]',
    "unitRate" JSONB NOT NULL,
    "growthRate" DECIMAL(18,8),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_runs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessUnitId" TEXT,
    "accountId" TEXT,
    "method" "ForecastMethod" NOT NULL,
    "autoSelected" BOOLEAN NOT NULL DEFAULT false,
    "horizon" INTEGER NOT NULL,
    "seasonLength" INTEGER,
    "confidenceLevel" DECIMAL(18,8) NOT NULL DEFAULT 0.95,
    "history" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "candidates" JSONB,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "mape" DECIMAL(18,8),
    "mase" DECIMAL(18,8),
    "rmse" DECIMAL(18,4),
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecast_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "forecastRunId" TEXT,
    "name" TEXT NOT NULL,
    "type" "ScenarioType" NOT NULL DEFAULT 'CUSTOM',
    "description" TEXT,
    "adjustments" JSONB NOT NULL DEFAULT '[]',
    "probability" DECIMAL(18,8),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pursuits" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL,
    "stage" "PursuitStage" NOT NULL DEFAULT 'IDENTIFIED',
    "contractType" "ContractType" NOT NULL,
    "probabilityOfWin" DECIMAL(18,8) NOT NULL DEFAULT 0.3,
    "expectedAwardDate" TIMESTAMP(3),
    "durationMonths" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pursuits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_models" (
    "id" TEXT NOT NULL,
    "pursuitId" TEXT,
    "name" TEXT NOT NULL,
    "contractType" "ContractType" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "years" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "totalPrice" DECIMAL(18,4) NOT NULL,
    "totalCost" DECIMAL(18,4) NOT NULL,
    "grossMargin" DECIMAL(18,8),
    "npv" DECIMAL(18,4),
    "irr" DECIMAL(18,8),
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "RiskCategory" NOT NULL,
    "businessUnitId" TEXT,
    "budgetId" TEXT,
    "pursuitId" TEXT,
    "probability" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "financialImpact" DECIMAL(18,4) NOT NULL,
    "response" "RiskResponse" NOT NULL DEFAULT 'MITIGATE',
    "mitigationPlan" TEXT,
    "residualProbability" INTEGER,
    "residualImpact" INTEGER,
    "ownerId" TEXT,
    "status" "RiskStatus" NOT NULL DEFAULT 'OPEN',
    "reviewDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "budgetId" TEXT,
    "pursuitId" TEXT,
    "iterations" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "baseValue" DECIMAL(18,4) NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "p50" DECIMAL(18,4) NOT NULL,
    "p80" DECIMAL(18,4) NOT NULL,
    "p90" DECIMAL(18,4) NOT NULL,
    "contingency" DECIMAL(18,4) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "changes" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "hash" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_businessUnitId_idx" ON "users"("businessUnitId");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "business_units_code_key" ON "business_units"("code");

-- CreateIndex
CREATE INDEX "business_units_parentId_idx" ON "business_units"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE INDEX "accounts_parentId_idx" ON "accounts"("parentId");

-- CreateIndex
CREATE INDEX "accounts_type_idx" ON "accounts"("type");

-- CreateIndex
CREATE UNIQUE INDEX "strategic_objectives_code_key" ON "strategic_objectives"("code");

-- CreateIndex
CREATE INDEX "budget_cycles_status_idx" ON "budget_cycles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "budget_cycles_fiscalYear_name_key" ON "budget_cycles"("fiscalYear", "name");

-- CreateIndex
CREATE UNIQUE INDEX "budget_assumptions_cycleId_key_key" ON "budget_assumptions"("cycleId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "budget_guidance_cycleId_key" ON "budget_guidance"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "budget_targets_cycleId_businessUnitId_key" ON "budget_targets"("cycleId", "businessUnitId");

-- CreateIndex
CREATE INDEX "budgets_status_idx" ON "budgets"("status");

-- CreateIndex
CREATE INDEX "budgets_businessUnitId_idx" ON "budgets"("businessUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_cycleId_businessUnitId_name_key" ON "budgets"("cycleId", "businessUnitId", "name");

-- CreateIndex
CREATE INDEX "budget_lines_budgetId_idx" ON "budget_lines"("budgetId");

-- CreateIndex
CREATE INDEX "budget_lines_accountId_idx" ON "budget_lines"("accountId");

-- CreateIndex
CREATE INDEX "budget_lines_strategicObjectiveId_idx" ON "budget_lines"("strategicObjectiveId");

-- CreateIndex
CREATE INDEX "budget_line_periods_periodKey_idx" ON "budget_line_periods"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "budget_line_periods_budgetLineId_periodKey_key" ON "budget_line_periods"("budgetLineId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "budget_versions_budgetId_version_key" ON "budget_versions"("budgetId", "version");

-- CreateIndex
CREATE INDEX "approvals_budgetId_idx" ON "approvals"("budgetId");

-- CreateIndex
CREATE INDEX "actuals_periodKey_idx" ON "actuals"("periodKey");

-- CreateIndex
CREATE INDEX "actuals_cycleId_businessUnitId_idx" ON "actuals"("cycleId", "businessUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "actuals_cycleId_businessUnitId_accountId_periodKey_key" ON "actuals"("cycleId", "businessUnitId", "accountId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_code_key" ON "drivers"("code");

-- CreateIndex
CREATE INDEX "forecast_runs_businessUnitId_idx" ON "forecast_runs"("businessUnitId");

-- CreateIndex
CREATE INDEX "forecast_runs_createdAt_idx" ON "forecast_runs"("createdAt");

-- CreateIndex
CREATE INDEX "pursuits_businessUnitId_idx" ON "pursuits"("businessUnitId");

-- CreateIndex
CREATE INDEX "pursuits_stage_idx" ON "pursuits"("stage");

-- CreateIndex
CREATE INDEX "pricing_models_pursuitId_idx" ON "pricing_models"("pursuitId");

-- CreateIndex
CREATE INDEX "risks_status_idx" ON "risks"("status");

-- CreateIndex
CREATE INDEX "risks_businessUnitId_idx" ON "risks"("businessUnitId");

-- CreateIndex
CREATE INDEX "simulations_createdAt_idx" ON "simulations"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_sequence_key" ON "audit_logs"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_hash_key" ON "audit_logs"("hash");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategic_objectives" ADD CONSTRAINT "strategic_objectives_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_assumptions" ADD CONSTRAINT "budget_assumptions_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_guidance" ADD CONSTRAINT "budget_guidance_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_targets" ADD CONSTRAINT "budget_targets_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_targets" ADD CONSTRAINT "budget_targets_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_strategicObjectiveId_fkey" FOREIGN KEY ("strategicObjectiveId") REFERENCES "strategic_objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_line_periods" ADD CONSTRAINT "budget_line_periods_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "budget_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actuals" ADD CONSTRAINT "actuals_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actuals" ADD CONSTRAINT "actuals_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actuals" ADD CONSTRAINT "actuals_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_forecastRunId_fkey" FOREIGN KEY ("forecastRunId") REFERENCES "forecast_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_models" ADD CONSTRAINT "pricing_models_pursuitId_fkey" FOREIGN KEY ("pursuitId") REFERENCES "pursuits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_models" ADD CONSTRAINT "pricing_models_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_pursuitId_fkey" FOREIGN KEY ("pursuitId") REFERENCES "pursuits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
