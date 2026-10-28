-- Random marker keys have no User FK: a timed-out marker may arrive after
-- account erasure and must remain discoverable for periodic fenced deletion.
ALTER TABLE "account_deletion_blob_receipts" ADD COLUMN "storageAuthorityHash" TEXT;

CREATE TABLE "import_marker_reapers" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "authorityHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dormant',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "import_marker_reapers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_marker_reapers_status_check" CHECK ("status" IN ('dormant', 'pending', 'processing'))
);

CREATE UNIQUE INDEX "import_marker_reapers_storageKey_key" ON "import_marker_reapers"("storageKey");
CREATE INDEX "import_marker_reapers_status_nextRunAt_leaseExpiresAt_idx"
  ON "import_marker_reapers"("status", "nextRunAt", "leaseExpiresAt");
