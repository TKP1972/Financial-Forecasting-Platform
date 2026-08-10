-- CreateEnum
CREATE TYPE "FiscalYearLabel" AS ENUM ('START', 'END');

-- AlterTable
ALTER TABLE "budget_cycles" ADD COLUMN     "fiscalStartMonth" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "fiscalYearLabel" "FiscalYearLabel" NOT NULL DEFAULT 'START';
