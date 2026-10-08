-- Durable completion receipts for every historical private voice store.
ALTER TABLE "account_deletions" ADD COLUMN "voiceErasure" JSONB;
