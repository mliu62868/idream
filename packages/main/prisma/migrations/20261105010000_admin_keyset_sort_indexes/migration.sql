-- Admin keyset pages sort by (createdAt, id) or (updatedAt, id) with no leading filter.
-- Without a matching index every page of these lists sorts the whole table.
CREATE INDEX "admin_audit_logs_createdAt_id_idx" ON "admin_audit_logs"("createdAt", "id");
CREATE INDEX "dreamcoin_ledger_createdAt_id_idx" ON "dreamcoin_ledger"("createdAt", "id");
CREATE INDEX "generation_jobs_createdAt_id_idx" ON "generation_jobs"("createdAt", "id");
CREATE INDEX "generation_jobs_updatedAt_id_idx" ON "generation_jobs"("updatedAt", "id");
