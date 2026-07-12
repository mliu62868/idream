import { todayProjectionSchema, type TodayProjection } from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import {
  buildTodayProjection,
  type TodaySourceQueryDiagnostic,
} from "@/server/modules/admin-v2/today/query";

const CASES = 100_000;
const JOBS = 100_000;
const EVENTS = 1_000_000;
const ITERATIONS = 7;
const ACTOR_ID = "readiness-today-admin";
const NEEDLE_CASE_ID = `case-${CASES}`;
const NOW = new Date("2026-07-11T12:00:00.000Z");

function percentile(values: readonly number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function assertReadiness(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Today readiness failed: ${message}`);
}

async function createProductionShape(tx: Prisma.TransactionClient) {
  const tables = [
    "admin_cases",
    "ops_incidents",
    "control_plane_commands",
    "character_projects",
    "character_releases",
    "release_monitors",
    "character_serving",
    "content_production_batches",
    "admin_collaboration_activities",
    "operational_work_preferences",
    "generation_jobs",
    "analytics_events",
  ] as const;
  await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(", ")} CASCADE`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "users" (id, email, role, status, "createdAt", "updatedAt")
    VALUES ('load-user', 'readiness-load-user@example.test', 'user', 'active', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "admin_cases"
      (id, type, "targetType", "targetId", "caseKey", status, priority,
       "ownerId", "slaDueAt", "verificationState", "createdAt", "updatedAt")
    SELECT
      'case-' || i::text,
      'content_report',
      'character',
      'target-' || i::text,
      'load-' || i::text,
      (ARRAY['new','triaged','in_progress','waiting','resolved'])[1 + (i % 5)],
      CASE WHEN i = ${CASES} THEN 'urgent'
        ELSE (ARRAY['urgent','high','normal','low'])[1 + (i % 4)] END,
      CASE WHEN i % 7 = 0 THEN NULL ELSE ${ACTOR_ID} END,
      CASE WHEN i = ${CASES} THEN TIMESTAMP '2020-01-01 00:00:00'
        ELSE TIMESTAMP '2026-07-11 12:00:00' + ((i % 240) - 120) * interval '1 minute' END,
      'pending',
      CASE WHEN i = ${CASES} THEN TIMESTAMP '2020-01-01 00:00:00'
        ELSE TIMESTAMP '2026-07-11 12:00:00' - (i % 86400) * interval '1 second' END,
      CASE WHEN i = ${CASES} THEN TIMESTAMP '2020-01-01 00:00:00'
        ELSE TIMESTAMP '2026-07-11 12:00:00' - (i % 86400) * interval '1 second' END
    FROM generate_series(1, ${CASES}) i
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "admin_collaboration_activities"
      (id, "targetType", "targetId", kind, "actorId", body, "mentionedIds", metadata, "idempotencyKey", "createdAt")
    VALUES (
      'readiness-needle-mention', 'case', ${NEEDLE_CASE_ID}, 'mention', 'readiness-peer',
      'Production-like critical-case mention', ARRAY[${ACTOR_ID}]::text[], '{}'::jsonb,
      'readiness-needle-mention', TIMESTAMP '2026-07-11 12:00:00'
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "generation_jobs"
      (id, "userId", mode, controls, "presetIds", status, provider, "errorCode", "createdAt", "updatedAt")
    SELECT
      'job-' || i::text, 'load-user', 'image', '{}'::jsonb, '[]'::jsonb,
      (ARRAY['queued','running','completed','failed','blocked'])[1 + (i % 5)],
      'provider-' || (i % 8)::text,
      CASE WHEN i % 5 IN (3,4) THEN 'signature-' || (i % 100)::text ELSE NULL END,
      TIMESTAMP '2026-07-11 12:00:00' - (i % 604800) * interval '1 second',
      TIMESTAMP '2026-07-11 12:00:00' - (i % 604800) * interval '1 second'
    FROM generate_series(1, ${JOBS}) i
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "analytics_events"
      (id, name, props, "sourceService", "sourceEventId", "occurredAt", "createdAt")
    SELECT
      'event-' || i::text,
      (ARRAY['chat.exchange.completed.v2','generation.delivery.completed.v2','subscription.active.v2'])[1 + (i % 3)],
      '{}'::jsonb, 'load-harness', 'event-' || i::text,
      TIMESTAMP '2026-07-11 12:00:00' - (i % 2592000) * interval '1 second',
      TIMESTAMP '2026-07-11 12:00:00' - (i % 2592000) * interval '1 second'
    FROM generate_series(1, ${EVENTS}) i
  `);
  await tx.$executeRawUnsafe("ANALYZE admin_cases");
  await tx.$executeRawUnsafe("ANALYZE admin_collaboration_activities");
  await tx.$executeRawUnsafe("ANALYZE generation_jobs");
  await tx.$executeRawUnsafe("ANALYZE analytics_events");
}

function verifyProjection(projection: TodayProjection) {
  todayProjectionSchema.parse(projection);
  assertReadiness(
    projection.nextBestActions.totalCount === 80_001,
    `active Case + Mention count must be exact (received ${projection.nextBestActions.totalCount})`,
  );
  assertReadiness(projection.nextBestActions.items.length === 10, "Today must return exactly the bounded first page");
  assertReadiness(
    projection.nextBestActions.items.some((item) => item.sourceType === "admin_case" && item.sourceId === NEEDLE_CASE_ID),
    "an old critical/SLA-breached Case must not be lost behind newer rows",
  );
  assertReadiness(
    projection.nextBestActions.items.some((item) => item.sourceType === "collaboration_mention" && item.sourceId === "readiness-needle-mention"),
    "the real mention-to-Case SQL join must feed the Today DTO",
  );
}

async function main() {
  let reportOutput: string | undefined;
  let reportPassed = false;
  class ReadinessRollback extends Error {}
  try {
    await prisma.$transaction(async (tx) => {
      const startedAt = performance.now();
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '60s'");
      await createProductionShape(tx);

      const samplesMs: number[] = [];
      const diagnostics: TodaySourceQueryDiagnostic[] = [];
      let projection: TodayProjection | null = null;
      for (let index = 0; index < ITERATIONS; index += 1) {
        const sampleStartedAt = performance.now();
        projection = await buildTodayProjection({
          db: tx,
          actor: { id: ACTOR_ID, role: "admin" },
          permissions: resolvePermissions("admin"),
          workMode: "admin",
          now: NOW,
          diagnostics: index === 0 ? { onSourceQuery: (event) => diagnostics.push(event) } : undefined,
        });
        samplesMs.push(performance.now() - sampleStartedAt);
        verifyProjection(projection);
      }

      const todayP95Ms = percentile(samplesMs, 0.95);
      const boundedSqlPath = diagnostics.length > 0 && diagnostics.every(
        (event) => event.returnedRows <= event.limit && event.limit === 10,
      );
      const observedSources = [...new Set(diagnostics.map((event) => event.sourceType))].sort();
      const checks = {
        realTodayProjectionDto: projection !== null,
        todayP95Under1000ms: todayP95Ms < 1_000,
        exactCompleteCounts: projection?.nextBestActions.totalCount === 80_001,
        rankPreservingOldCriticalNeedle: projection?.nextBestActions.items.some(
          (item) => item.sourceType === "admin_case" && item.sourceId === NEEDLE_CASE_ID,
        ) ?? false,
        boundedSourceSql: boundedSqlPath,
        realMentionTargetJoin: projection?.nextBestActions.items.some(
          (item) => item.sourceType === "collaboration_mention" && item.sourceId === "readiness-needle-mention",
        ) ?? false,
      };
      const report = {
        status: Object.values(checks).every(Boolean) ? "pass" : "fail",
        schema: "Production PostgreSQL tables and indexes exercised in a rollback-only transaction",
        sqlPath: "buildTodayProjection -> exact count + bounded source lanes + Release/Mention join-aware rank queries",
        scale: { cases: CASES, jobs: JOBS, events: EVENTS },
        durationMs: performance.now() - startedAt,
        today: { samplesMs, p95Ms: todayP95Ms, diagnostics, observedSources },
        checks,
      };
      reportOutput = JSON.stringify(report, null, 2);
      reportPassed = report.status === "pass";
      throw new ReadinessRollback();
    }, { maxWait: 10_000, timeout: 180_000 });
  } catch (error) {
    if (!(error instanceof ReadinessRollback)) throw error;
  }

  assertReadiness(reportOutput, "rollback-only report was not produced");
  process.stdout.write(`${reportOutput}\n`);
  if (!reportPassed) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
