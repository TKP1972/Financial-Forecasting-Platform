-- AlterTable
ALTER TABLE "budget_cycles" ADD COLUMN     "actualsThroughPeriod" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "horizonYears" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lastRolledAt" TIMESTAMP(3),
ADD COLUMN     "rollingHorizonPeriods" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "rolling_forecasts" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "businessUnitId" TEXT,
    "accountId" TEXT,
    "anchorPeriodKey" TEXT NOT NULL,
    "anchorPeriodIndex" INTEGER NOT NULL,
    "horizonPeriods" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "method" "ForecastMethod" NOT NULL,
    "points" JSONB NOT NULL,
    "actualToDate" DECIMAL(18,4) NOT NULL,
    "forecastRemainder" DECIMAL(18,4) NOT NULL,
    "fullYearOutturn" DECIMAL(18,4) NOT NULL,
    "baselineTotal" DECIMAL(18,4),
    "varianceToBaseline" DECIMAL(18,4),
    "priorAccuracy" JSONB,
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rolling_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rolling_forecasts_cycleId_supersededAt_idx" ON "rolling_forecasts"("cycleId", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "rolling_forecasts_cycleId_businessUnitId_accountId_generati_key" ON "rolling_forecasts"("cycleId", "businessUnitId", "accountId", "generation");

-- AddForeignKey
ALTER TABLE "rolling_forecasts" ADD CONSTRAINT "rolling_forecasts_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rolling_forecasts" ADD CONSTRAINT "rolling_forecasts_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rolling_forecasts" ADD CONSTRAINT "rolling_forecasts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rolling_forecasts" ADD CONSTRAINT "rolling_forecasts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
