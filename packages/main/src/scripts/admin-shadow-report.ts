import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "@/server/modules/admin-v2/reconciliation/invariants";

type MismatchRow = { category: string; count: number; sampleIds: string[]; classification: "cutover_blocker" | "legacy_backfill_required" };

async function mismatch(category: string, classification: MismatchRow["classification"], query: Prisma.Sql): Promise<MismatchRow> {
  const rows = await prisma.$queryRaw<Array<{ id: string; total: number }>>(query);
  return { category, count: rows[0]?.total ?? 0, sampleIds: rows.map((row) => row.id), classification };
}

async function main() {
  const [invariants, generationDelivery, legacyTerminalTime, refundedOutcome, settlementOvershoot, creativeCounters, caseCoverage] = await Promise.all([
    auditAdminCutoverInvariants(prisma),
    mismatch("generation_request_delivery_projection", "cutover_blocker", Prisma.sql`
      WITH actual AS (
        SELECT j.id, j."deliveredOutputCount" AS projected, count(d.id)::int AS delivered
        FROM generation_jobs j LEFT JOIN generation_deliveries d ON d."requestId" = j.id AND d.status = 'delivered'
        GROUP BY j.id, j."deliveredOutputCount"
      ), violations AS (SELECT id FROM actual WHERE projected <> delivered)
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `),
    mismatch("legacy_terminal_time_semantics", "legacy_backfill_required", Prisma.sql`
      WITH violations AS (SELECT id FROM generation_jobs WHERE status <> 'completed' AND "completedAt" IS NOT NULL)
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `),
    mismatch("refund_encoded_as_execution_outcome", "legacy_backfill_required", Prisma.sql`
      WITH violations AS (SELECT id FROM generation_jobs WHERE status = 'refunded')
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `),
    mismatch("generation_settlement_overshoot", "cutover_blocker", Prisma.sql`
      WITH totals AS (
        SELECT j.id,
          -coalesce(sum(l.delta) FILTER (WHERE l.reason = 'generation_spend' AND l.delta < 0), 0)::int AS captured,
          coalesce(sum(l.delta) FILTER (WHERE l.reason = 'refund' AND l.delta > 0), 0)::int AS refunded
        FROM generation_jobs j LEFT JOIN dreamcoin_ledger l ON l."sourceId" = j.id
        GROUP BY j.id
      ), violations AS (SELECT id FROM totals WHERE refunded > captured)
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `),
    mismatch("creative_run_counter_projection", "legacy_backfill_required", Prisma.sql`
      WITH actual AS (
        SELECT b.id, b."completedItems", b."failedItems",
          count(i.id) FILTER (WHERE i.status IN ('generated','approved','published'))::int AS actual_completed,
          count(i.id) FILTER (WHERE i.status IN ('failed','cancelled'))::int AS actual_failed
        FROM content_production_batches b LEFT JOIN content_production_items i ON i."batchId" = b.id
        GROUP BY b.id, b."completedItems", b."failedItems"
      ), violations AS (SELECT id FROM actual WHERE "completedItems" <> actual_completed OR "failedItems" <> actual_failed)
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `),
    mismatch("open_source_case_projection", "cutover_blocker", Prisma.sql`
      WITH sources AS (
        SELECT 'support_request' AS source_type, id FROM support_requests WHERE status IN ('received','open','waiting_on_user')
        UNION ALL SELECT 'content_report', id FROM content_reports WHERE status = 'open'
        UNION ALL SELECT 'appeal', id FROM appeals WHERE status = 'open'
      ), violations AS (
        SELECT s.source_type || ':' || s.id AS id FROM sources s WHERE NOT EXISTS (
          SELECT 1 FROM case_evidence e JOIN admin_cases c ON c.id = e."caseId"
          WHERE e."sourceType" = s.source_type AND e."sourceId" = s.id AND c.status NOT IN ('resolved','closed')
        )
      ) SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `),
  ]);
  const mismatches = [generationDelivery, legacyTerminalTime, refundedOutcome, settlementOvershoot, creativeCounters, caseCoverage];
  const mismatchCount = mismatches.reduce((sum, item) => sum + item.count, 0);
  const report = {
    asOf: new Date().toISOString(),
    status: invariants.totalViolations === 0 && invariants.unavailableChecks === 0 && mismatchCount === 0 ? "pass" : "blocked",
    decisionUse: invariants.totalViolations === 0 && invariants.unavailableChecks === 0 && mismatchCount === 0 ? "allowed" : "blocked",
    invariants,
    mismatchCount,
    mismatches,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
