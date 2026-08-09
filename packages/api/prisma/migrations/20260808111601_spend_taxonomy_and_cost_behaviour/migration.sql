-- CreateEnum
CREATE TYPE "SpendCategory" AS ENUM ('ACCESS', 'TRANSPORT', 'EQUIPMENT', 'SOFTWARE_SAAS', 'FACILITIES', 'LABOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "CostBehaviour" AS ENUM ('FIXED', 'VARIABLE', 'SEMI_VARIABLE');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "costBehaviour" "CostBehaviour",
ADD COLUMN     "spendCategory" "SpendCategory",
ADD COLUMN     "variableShare" DECIMAL(18,8);

-- AlterTable
ALTER TABLE "budget_lines" ADD COLUMN     "costBehaviour" "CostBehaviour",
ADD COLUMN     "spendCategory" "SpendCategory",
ADD COLUMN     "variableShare" DECIMAL(18,8);
