-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "pursuitId" TEXT,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_entries" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "labourCategory" TEXT NOT NULL,
    "location" TEXT,
    "channel" TEXT,
    "complexity" TEXT,
    "rate" DECIMAL(18,6) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_card_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_code_key" ON "rate_cards"("code");

-- CreateIndex
CREATE INDEX "rate_card_entries_rateCardId_labourCategory_idx" ON "rate_card_entries"("rateCardId", "labourCategory");

-- CreateIndex
CREATE INDEX "rate_card_entries_effectiveFrom_idx" ON "rate_card_entries"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_pursuitId_fkey" FOREIGN KEY ("pursuitId") REFERENCES "pursuits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_entries" ADD CONSTRAINT "rate_card_entries_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
