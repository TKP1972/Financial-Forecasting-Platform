-- CreateTable
CREATE TABLE "published_reports" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "throughPeriod" INTEGER,
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "published_reports_cycleId_publishedAt_idx" ON "published_reports"("cycleId", "publishedAt");

-- AddForeignKey
ALTER TABLE "published_reports" ADD CONSTRAINT "published_reports_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "budget_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_reports" ADD CONSTRAINT "published_reports_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
