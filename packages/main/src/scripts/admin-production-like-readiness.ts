import {
  generationJobListResponseSchema,
  generationJobQuerySchema,
  todayProjectionSchema,
  type GenerationJobListResponse,
  type TodayProjection,
} from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import {
  buildTodayProjection,
  type TodaySourceQueryDiagnostic,
} from "@/server/modules/admin-v2/today/query";
import { queryGenerationJobsV2Authority } from "@/server/modules/admin-v2/jobs/query";

const CASES = 100_000;
const JOBS = 100_000;
const EVENTS = 1_000_000;
const INCIDENTS = 100_000;
const ITERATIONS = 7;
const ACTOR_ID = "readiness-today-admin";
const NEEDLE_CASE_ID = `case-${CASES}`;
const EXPECTED_FILTERED_JOBS = 500;
const EVENT_NAMES = [
  "chat.exchange.completed.v2",
  "generation.delivery.completed.v2",
  "subscription.active.v2",
] as const;
const EXPECTED_EVENT_NAME_COUNTS: Readonly<Record<(typeof EVENT_NAMES)[number], number>> = {
  "chat.exchange.completed.v2": 333_333,
  "generation.delivery.completed.v2": 333_334,
  "subscription.active.v2": 333_333,
};
const NOW = new Date("2026-07-11T12:00:00.000Z");

function percentile(values: readonly number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function assertReadiness(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Admin production-like readiness failed: ${message}`);
}

async function createProductionShape(tx: Prisma.TransactionClient) {
  const tables = [
    "admin_cases",
    "ops_incidents",
    "ops_incident_occurrences",
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
      (id, type, "targetType", "targetId", "caseKey", "activeKey", status, priority,
       "ownerId", "slaDueAt", "verificationState", "createdAt", "updatedAt")
    SELECT
      'case-' || i::text,
      CASE WHEN i = 1 THEN 'support_request' ELSE 'content_report' END,
      CASE WHEN i = 1 THEN 'user' ELSE 'character' END,
      CASE WHEN i = 1 THEN 'load-user' ELSE 'target-' || i::text END,
      'load-' || i::text,
      CASE WHEN i % 5 = 4 THEN NULL ELSE
        (CASE WHEN i = 1 THEN 'support_request:user:load-user:' ELSE 'content_report:character:target-' || i::text || ':' END)
        || 'load-' || i::text
      END,
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
    INSERT INTO "ops_incidents"
      (id, signature, "signatureVersion", status, severity, "ownerId", "firstSeen", "lastSeen",
       "slaDueAt", impact, mitigation, "verificationState", "createdAt", "updatedAt")
    SELECT
      'incident-' || i::text,
      'readiness-signature-' || i::text,
      'v1',
      (ARRAY['detected','triaged','mitigating','monitoring'])[1 + (i % 4)],
      (ARRAY['high','medium','low'])[1 + (i % 3)],
      NULL,
      TIMESTAMP '2026-07-10 12:00:00' - (i % 86400) * interval '1 second',
      TIMESTAMP '2026-07-11 12:00:00' - (i % 86400) * interval '1 second',
      TIMESTAMP '2026-07-11 12:00:00' + ((i % 240) - 120) * interval '1 minute',
      '{}'::jsonb, '{}'::jsonb, 'pending',
      TIMESTAMP '2026-07-10 12:00:00' - (i % 86400) * interval '1 second',
      TIMESTAMP '2026-07-11 12:00:00' - (i % 86400) * interval '1 second'
    FROM generate_series(1, ${INCIDENTS}) i
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "ops_incident_occurrences"
      (id, "incidentId", "requestId", "occurrenceKey", "observedAt", "createdAt")
    SELECT
      'occurrence-' || i::text,
      'incident-' || i::text,
      'job-' || i::text,
      'readiness-occurrence-' || i::text,
      TIMESTAMP '2026-07-11 12:00:00' - (i % 86400) * interval '1 second',
      TIMESTAMP '2026-07-11 12:00:00' - (i % 86400) * interval '1 second'
    FROM generate_series(1, ${INCIDENTS}) i
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "analytics_events"
      (id, name, props, "sourceService", "sourceEventId", "occurredAt",
       environment, "dataClass", "trustClass", "createdAt")
    SELECT
      'event-' || i::text,
      (ARRAY['chat.exchange.completed.v2','generation.delivery.completed.v2','subscription.active.v2'])[1 + (i % 3)],
      '{}'::jsonb, 'load-harness', 'event-' || i::text,
      TIMESTAMP '2026-07-11 12:00:00' - (i % 2592000) * interval '1 second',
      'production', 'customer', 'canonical',
      TIMESTAMP '2026-07-11 12:00:00' - (i % 2592000) * interval '1 second'
    FROM generate_series(1, ${EVENTS}) i
  `);
  await tx.$executeRawUnsafe("ANALYZE admin_cases");
  await tx.$executeRawUnsafe("ANALYZE admin_collaboration_activities");
  await tx.$executeRawUnsafe("ANALYZE generation_jobs");
  await tx.$executeRawUnsafe("ANALYZE ops_incidents");
  await tx.$executeRawUnsafe("ANALYZE ops_incident_occurrences");
  await tx.$executeRawUnsafe("ANALYZE analytics_events");
}

function verifyProjection(projection: TodayProjection) {
  todayProjectionSchema.parse(projection);
  assertReadiness(
    projection.nextBestActions.totalCount === 180_001,
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

function verifySupportProjection(projection: TodayProjection) {
  todayProjectionSchema.parse(projection);
  assertReadiness(
    projection.nextBestActions.totalCount === 100_001,
    `support-linked Incident + scoped Case count must be exact (received ${projection.nextBestActions.totalCount})`,
  );
  assertReadiness(projection.nextBestActions.items.length === 10, "support Today must keep the first page bounded");
  assertReadiness(
    projection.nextBestActions.items.some((item) => item.sourceType === "ops_incident"),
    "support-linked Incidents must be projected through the correlated EXISTS scope",
  );
}

function verifyJobsPage(page: GenerationJobListResponse) {
  generationJobListResponseSchema.parse(page);
  assertReadiness(page.items.length <= 25, "Generation Jobs page must remain bounded by the requested limit");
  assertReadiness(
    page.summary.totalCount === EXPECTED_FILTERED_JOBS,
    `Generation Jobs filtered total must be exact (received ${page.summary.totalCount})`,
  );
  assertReadiness(page.items.every((item) => (
    item.mode === "image"
    && item.legacyStatus === "blocked"
    && item.provider === "provider-3"
    && item.errorCode === "signature-99"
  )), "Generation Jobs server filters/search must constrain every projected DTO item");
}

async function queryAnalyticsEventCoverage(db: Prisma.TransactionClient) {
  const startedAt = performance.now();
  const totalCount = await db.analyticsEvent.count({
    where: { sourceService: "load-harness" },
  });
  const eventNameGroups = await db.analyticsEvent.groupBy({
    by: ["name"],
    where: { sourceService: "load-harness", name: { in: [...EVENT_NAMES] } },
    _count: { _all: true },
    orderBy: { name: "asc" },
    take: 10,
  });
  const authorityGroups = await db.analyticsEvent.groupBy({
    by: ["environment", "dataClass", "trustClass"],
    where: { sourceService: "load-harness" },
    _count: { _all: true },
    orderBy: [
      { environment: "asc" },
      { dataClass: "asc" },
      { trustClass: "asc" },
    ],
    take: 10,
  });
  const groupedCount = eventNameGroups.reduce((sum, row) => sum + row._count._all, 0);
  return {
    durationMs: performance.now() - startedAt,
    totalCount,
    groupedCount,
    eventNameGroups,
    authorityGroups,
    eventNameCoverage: eventNameGroups.length / EVENT_NAMES.length,
  };
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
      const supportSamplesMs: number[] = [];
      const supportDiagnostics: TodaySourceQueryDiagnostic[] = [];
      let projection: TodayProjection | null = null;
      let supportProjection: TodayProjection | null = null;
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
      for (let index = 0; index < ITERATIONS; index += 1) {
        const sampleStartedAt = performance.now();
        supportProjection = await buildTodayProjection({
          db: tx,
          actor: { id: ACTOR_ID, role: "support" },
          permissions: resolvePermissions("support"),
          workMode: "support",
          now: NOW,
          diagnostics: index === 0 ? { onSourceQuery: (event) => supportDiagnostics.push(event) } : undefined,
        });
        supportSamplesMs.push(performance.now() - sampleStartedAt);
        verifySupportProjection(supportProjection);
      }

      const jobsSamplesMs: number[] = [];
      let jobsFirstPage: GenerationJobListResponse | null = null;
      let jobsSecondPage: GenerationJobListResponse | null = null;
      for (let index = 0; index < ITERATIONS; index += 1) {
        const sampleStartedAt = performance.now();
        jobsFirstPage = await queryGenerationJobsV2Authority({
          db: tx,
          query: generationJobQuerySchema.parse({
            search: "signature-99",
            mode: "image",
            legacyStatus: "blocked",
            provider: "provider-3",
            userId: "load-user",
            sort: "created_desc",
            limit: 25,
          }),
          now: NOW,
        });
        verifyJobsPage(jobsFirstPage);
        assertReadiness(jobsFirstPage.pageInfo.hasNextPage, "Generation Jobs first page must expose a next cursor");
        assertReadiness(jobsFirstPage.pageInfo.endCursor, "Generation Jobs first page cursor must be present");
        jobsSecondPage = await queryGenerationJobsV2Authority({
          db: tx,
          query: generationJobQuerySchema.parse({
            search: "signature-99",
            mode: "image",
            legacyStatus: "blocked",
            provider: "provider-3",
            userId: "load-user",
            sort: "created_desc",
            limit: 25,
            cursor: jobsFirstPage.pageInfo.endCursor,
          }),
          now: NOW,
        });
        verifyJobsPage(jobsSecondPage);
        const firstIds = new Set(jobsFirstPage.items.map((item) => item.id));
        assertReadiness(
          jobsSecondPage.items.every((item) => !firstIds.has(item.id)),
          "Generation Jobs composite cursor must not duplicate the first page",
        );
        jobsSamplesMs.push(performance.now() - sampleStartedAt);
      }

      const analyticsSamples = [];
      for (let index = 0; index < ITERATIONS; index += 1) {
        const sample = await queryAnalyticsEventCoverage(tx);
        assertReadiness(sample.totalCount === EVENTS, `analytics event count must be exact (received ${sample.totalCount})`);
        assertReadiness(sample.groupedCount === EVENTS, "analytics bounded name aggregation must cover every inserted event");
        assertReadiness(sample.eventNameGroups.length === EVENT_NAMES.length, "analytics name coverage must include all expected event types");
        assertReadiness(sample.eventNameCoverage === 1, "analytics event-name coverage must be complete");
        assertReadiness(
          sample.eventNameGroups.every((group) => (
            EXPECTED_EVENT_NAME_COUNTS[group.name as keyof typeof EXPECTED_EVENT_NAME_COUNTS] === group._count._all
          )),
          "analytics bounded name aggregation must preserve each exact event count",
        );
        assertReadiness(sample.authorityGroups.length === 1, "analytics authority aggregation must stay bounded to one fixture class");
        assertReadiness(
          sample.authorityGroups[0]?._count._all === EVENTS,
          "analytics authority coverage must account for every inserted event",
        );
        assertReadiness(
          sample.authorityGroups[0]?.environment === "production"
          && sample.authorityGroups[0]?.dataClass === "customer"
          && sample.authorityGroups[0]?.trustClass === "canonical",
          "analytics authority coverage must preserve the production/customer/canonical fixture class",
        );
        analyticsSamples.push(sample);
      }

      const todayP95Ms = percentile(samplesMs, 0.95);
      const supportTodayP95Ms = percentile(supportSamplesMs, 0.95);
      const jobsP95Ms = percentile(jobsSamplesMs, 0.95);
      const analyticsP95Ms = percentile(analyticsSamples.map((sample) => sample.durationMs), 0.95);
      const boundedSqlPath = diagnostics.length > 0 && diagnostics.every(
        (event) => event.returnedRows <= event.limit && event.limit === 10,
      );
      const supportIncidentDiagnostics = supportDiagnostics.filter(
        (event) => event.sourceType === "ops_incident",
      );
      const observedSources = [...new Set(diagnostics.map((event) => event.sourceType))].sort();
      const generationJobsCursorNoDuplicates = Boolean(jobsFirstPage && jobsSecondPage) && (() => {
        const firstIds = new Set(jobsFirstPage!.items.map((item) => item.id));
        return jobsSecondPage!.items.every((item) => !firstIds.has(item.id));
      })();
      const checks = {
        realTodayProjectionDto: projection !== null,
        todayP95Under1000ms: todayP95Ms < 1_000,
        supportTodayP95Under1000ms: supportTodayP95Ms < 1_000,
        generationJobsP95Under1000ms: jobsP95Ms < 1_000,
        generationJobsExactFilteredTotal: jobsFirstPage?.summary.totalCount === EXPECTED_FILTERED_JOBS,
        generationJobsBoundedPages: (jobsFirstPage?.items.length ?? 0) <= 25 && (jobsSecondPage?.items.length ?? 0) <= 25,
        generationJobsCursorNoDuplicates,
        analyticsAggregateP95Under1000ms: analyticsP95Ms < 1_000,
        analyticsEventCountExact: analyticsSamples.at(-1)?.totalCount === EVENTS,
        analyticsEventCoverageComplete: analyticsSamples.at(-1)?.eventNameCoverage === 1,
        analyticsAggregateResultBounded: (analyticsSamples.at(-1)?.eventNameGroups.length ?? 11) <= 10
          && (analyticsSamples.at(-1)?.authorityGroups.length ?? 11) <= 10,
        exactCompleteCounts: projection?.nextBestActions.totalCount === 180_001,
        exactSupportScopeCount: supportProjection?.nextBestActions.totalCount === 100_001,
        rankPreservingOldCriticalNeedle: projection?.nextBestActions.items.some(
          (item) => item.sourceType === "admin_case" && item.sourceId === NEEDLE_CASE_ID,
        ) ?? false,
        boundedSourceSql: boundedSqlPath,
        boundedSupportIncidentSql: supportIncidentDiagnostics.length > 0 && supportIncidentDiagnostics
          .every((event) => event.returnedRows <= event.limit && event.limit === 10),
        realMentionTargetJoin: projection?.nextBestActions.items.some(
          (item) => item.sourceType === "collaboration_mention" && item.sourceId === "readiness-needle-mention",
        ) ?? false,
      };
      const report = {
        status: Object.values(checks).every(Boolean) ? "pass" : "fail",
        schema: "Production PostgreSQL tables and indexes exercised in a rollback-only transaction",
        sqlPath: {
          today: "buildTodayProjection -> exact count + bounded source lanes + Release/Mention join-aware rank queries",
          jobs: "queryGenerationJobsV2Authority -> production Generation Job filters/search/composite cursor/projection DTO",
          analyticsEvents: "AnalyticsEvent count + bounded name and authority-class aggregate coverage queries",
        },
        scale: { cases: CASES, jobs: JOBS, incidents: INCIDENTS, incidentOccurrences: INCIDENTS, events: EVENTS },
        durationMs: performance.now() - startedAt,
        today: {
          samplesMs,
          p95Ms: todayP95Ms,
          diagnostics,
          observedSources,
          support: { samplesMs: supportSamplesMs, p95Ms: supportTodayP95Ms, diagnostics: supportDiagnostics },
        },
        generationJobs: {
          samplesMs: jobsSamplesMs,
          p95Ms: jobsP95Ms,
          query: {
            search: "signature-99",
            mode: "image",
            legacyStatus: "blocked",
            provider: "provider-3",
            userId: "load-user",
            sort: "created_desc",
            limit: 25,
          },
          expectedTotalCount: EXPECTED_FILTERED_JOBS,
          firstPageCount: jobsFirstPage?.items.length ?? 0,
          secondPageCount: jobsSecondPage?.items.length ?? 0,
        },
        analyticsEvents: {
          samplesMs: analyticsSamples.map((sample) => sample.durationMs),
          p95Ms: analyticsP95Ms,
          totalCount: analyticsSamples.at(-1)?.totalCount ?? 0,
          groupedCount: analyticsSamples.at(-1)?.groupedCount ?? 0,
          eventNameCoverage: analyticsSamples.at(-1)?.eventNameCoverage ?? 0,
          eventNameGroups: analyticsSamples.at(-1)?.eventNameGroups ?? [],
          authorityGroups: analyticsSamples.at(-1)?.authorityGroups ?? [],
        },
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
