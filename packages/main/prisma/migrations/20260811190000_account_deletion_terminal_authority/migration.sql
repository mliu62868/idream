-- Account deletion is terminal only after Chat, Main, and Blob authorities
-- have each produced durable evidence. This migration is intentionally
-- additive; operators apply it through the normal deployment migration gate.

BEGIN;

CREATE TABLE "account_deletions" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subjectHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_chat',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graceEndsAt" TIMESTAMP(3) NOT NULL,
    "chatRequestEventId" TEXT,
    "chatCompletionEventId" TEXT,
    "chatFileMutationId" TEXT,
    "chatCompletedAt" TIMESTAMP(3),
    "blobExpectedCount" INTEGER NOT NULL DEFAULT 0,
    "blobDeletedCount" INTEGER NOT NULL DEFAULT 0,
    "mainPurgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_deletions_status_check"
      CHECK ("status" IN ('awaiting_chat', 'deleting_blobs', 'finalizing', 'completed')),
    CONSTRAINT "account_deletions_grace_period_check"
      CHECK ("graceEndsAt" > "requestedAt"),
    CONSTRAINT "account_deletions_chat_terminal_check"
      CHECK (
        ("status" = 'awaiting_chat' AND "chatCompletionEventId" IS NULL AND "chatFileMutationId" IS NULL AND "chatCompletedAt" IS NULL)
        OR
          ("status" <> 'awaiting_chat' AND "chatCompletionEventId" IS NOT NULL AND "chatFileMutationId" IS NOT NULL AND "chatCompletedAt" IS NOT NULL)
      ),
    CONSTRAINT "account_deletions_chat_request_check"
      CHECK (
        ("status" = 'completed' AND "chatRequestEventId" IS NULL)
        OR
        ("status" <> 'completed' AND "chatRequestEventId" IS NOT NULL)
      ),
    CONSTRAINT "account_deletions_terminal_check"
      CHECK (
        ("status" = 'completed' AND "userId" IS NULL AND "mainPurgedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "blobDeletedCount" = "blobExpectedCount")
        OR
        ("status" <> 'completed' AND "userId" IS NOT NULL AND "mainPurgedAt" IS NULL AND "completedAt" IS NULL)
      ),
    CONSTRAINT "account_deletions_blob_count_check"
      CHECK ("blobExpectedCount" >= 0 AND "blobDeletedCount" >= 0 AND "blobDeletedCount" <= "blobExpectedCount")
);

CREATE TABLE "account_deletion_blob_receipts" (
    "id" TEXT NOT NULL,
    "deletionId" TEXT NOT NULL,
    "storageKey" TEXT,
    "storageKeyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "account_deletion_blob_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_deletion_blob_receipts_status_check"
      CHECK ("status" IN ('pending', 'processing', 'deleted')),
    CONSTRAINT "account_deletion_blob_receipts_terminal_check"
      CHECK (
        ("status" = 'deleted' AND "deletedAt" IS NOT NULL)
        OR
        ("status" <> 'deleted' AND "deletedAt" IS NULL)
      )
);

CREATE TABLE "erased_dreamcoin_ledger_entries" (
    "id" TEXT NOT NULL,
    "deletionId" TEXT NOT NULL,
    "sourceEntryHash" TEXT NOT NULL,
    "sourceIdHash" TEXT,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "erased_dreamcoin_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_deletions_userId_key" ON "account_deletions"("userId");
CREATE UNIQUE INDEX "account_deletions_subjectHash_key" ON "account_deletions"("subjectHash");
CREATE UNIQUE INDEX "account_deletions_chatRequestEventId_key" ON "account_deletions"("chatRequestEventId");
CREATE UNIQUE INDEX "account_deletions_chatCompletionEventId_key" ON "account_deletions"("chatCompletionEventId");
CREATE INDEX "account_deletions_status_updatedAt_idx" ON "account_deletions"("status", "updatedAt");
CREATE UNIQUE INDEX "account_deletion_blob_receipts_deletionId_storageKeyHash_key" ON "account_deletion_blob_receipts"("deletionId", "storageKeyHash");
CREATE INDEX "account_deletion_blob_receipts_status_nextAttemptAt_leaseExpiresAt_idx" ON "account_deletion_blob_receipts"("status", "nextAttemptAt", "leaseExpiresAt");
CREATE UNIQUE INDEX "erased_dreamcoin_ledger_entries_deletionId_sourceEntryHash_key" ON "erased_dreamcoin_ledger_entries"("deletionId", "sourceEntryHash");
CREATE INDEX "erased_dreamcoin_ledger_entries_reason_occurredAt_idx" ON "erased_dreamcoin_ledger_entries"("reason", "occurredAt");

ALTER TABLE "account_deletion_blob_receipts"
  ADD CONSTRAINT "account_deletion_blob_receipts_deletionId_fkey"
  FOREIGN KEY ("deletionId") REFERENCES "account_deletions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "erased_dreamcoin_ledger_entries"
  ADD CONSTRAINT "erased_dreamcoin_ledger_entries_deletionId_fkey"
  FOREIGN KEY ("deletionId") REFERENCES "account_deletions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Legacy delete-request completed only a soft-delete plus the first Chat
-- exchange. Re-enter customer rows through a new event identity so Chat's
-- durable inbox does not treat the post-grace erasure request as a replay.
WITH legacy AS (
  SELECT
    u.id AS "userId",
    encode(sha256(convert_to(u.id, 'UTF8')), 'hex') AS "subjectHash",
    COALESCE(u."deletedAt", u."updatedAt", CURRENT_TIMESTAMP) AS "requestedAt"
  FROM "users" u
  WHERE u."dataClass" = 'customer'
    AND (u.status = 'deleted' OR u."deletedAt" IS NOT NULL)
)
INSERT INTO "account_deletions" (
  "id", "userId", "subjectHash", status, "requestedAt", "graceEndsAt",
  "chatRequestEventId", "updatedAt"
)
SELECT
  'account_deletion_' || left(legacy."subjectHash", 32),
  legacy."userId",
  legacy."subjectHash",
  'awaiting_chat',
  legacy."requestedAt",
  legacy."requestedAt" + INTERVAL '30 days',
  'user_deleted_account_deletion_' || left(legacy."subjectHash", 32),
  CURRENT_TIMESTAMP
FROM legacy
ON CONFLICT DO NOTHING;

INSERT INTO "main_outbox_events" (
  "id", "eventType", "aggregateType", "aggregateId", payload, status,
  attempts, "nextRunAt", "createdAt", "updatedAt"
)
SELECT
  ad."chatRequestEventId",
  'user.account_deletion.requested.v2',
  'user',
  ad."userId",
  jsonb_build_object(
    'sourceService', 'main',
    'sourceEventId', ad."chatRequestEventId",
    'eventType', 'user.account_deletion.requested.v2',
    'schemaVersion', 2,
    -- Prisma DateTime is stored as a UTC timestamp without time zone. Format
    -- that value directly; converting to timestamptz would re-apply the
    -- database session zone and mislabel it as Z on non-UTC production DBs.
    'occurredAt', to_char(ad."requestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'aggregateType', 'user',
    'aggregateId', ad."userId",
    'payload', jsonb_build_object('userId', ad."userId")
  ),
  'pending',
  0,
  ad."graceEndsAt",
  ad."requestedAt",
  CURRENT_TIMESTAMP
FROM "account_deletions" ad
WHERE ad.status = 'awaiting_chat'
  AND ad."chatRequestEventId" LIKE 'user_deleted_account_deletion_%'
ON CONFLICT ("id") DO NOTHING;

-- Rollback safety: once this migration is present, no customer may enter the
-- deleted state without the durable workflow row that the current application
-- creates in the same transaction. The deferred check permits that write
-- order, while an older soft-delete-only binary fails closed at COMMIT.
CREATE FUNCTION "enforce_customer_account_deletion_authority"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."dataClass" = 'customer'
     AND (NEW.status = 'deleted' OR NEW."deletedAt" IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
       FROM "account_deletions" ad
       WHERE ad."userId" = NEW.id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'customer_account_deletion_authority_required',
      MESSAGE = 'deleted customer requires AccountDeletion authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "customer_account_deletion_authority_required"
AFTER INSERT OR UPDATE ON "users"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_customer_account_deletion_authority"();

COMMIT;
