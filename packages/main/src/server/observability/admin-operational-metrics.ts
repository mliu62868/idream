import { incrementCounter, setGauge } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "@/server/modules/admin-v2/reconciliation/invariants";

const outboxQueues = [
  { queue: "chat", eventTypes: Object.values(MAIN_TO_CHAT_EVENTS) },
  { queue: "product_event", eventTypes: ["product.event.persisted.v2"] },
  { queue: "generation_manifest", eventTypes: ["generation.manifest.accepted.v1"] },
] as const;

const activeCaseStatuses = ["new", "triaged", "in_progress", "waiting", "reopened"];
const activeIncidentStatuses = ["detected", "triaged", "mitigating", "monitoring"];

export async function collectAdminOperationalMetrics(
  db: PrismaClient = prisma,
  now = new Date(),
) {
  incrementCounter(
    "admin_audit_transaction_failure_total",
    "Admin domain transactions containing an atomic Audit row that rolled back",
    { operation: "all" },
    0,
  );
  const [
    invariants,
    oldestByQueue,
    incidents,
    openCases,
    openIncidents,
    metricSnapshots,
    failedAttemptCount,
    unknownFailureCount,
    creativeOutcomes,
  ] = await Promise.all([
    auditAdminCutoverInvariants(db, now),
    Promise.all(outboxQueues.map(async ({ queue, eventTypes }) => ({
      queue,
      oldest: await db.mainOutboxEvent.findFirst({
        where: {
          eventType: { in: [...eventTypes] },
          status: { in: ["pending", "dispatched"] },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    }))),
    db.opsIncident.findMany({
      orderBy: { createdAt: "desc" },
      take: 1_000,
      select: { severity: true, firstSeen: true, createdAt: true },
    }),
    db.adminCase.findMany({
      where: { status: { in: activeCaseStatuses } },
      select: { ownerId: true, slaDueAt: true, createdAt: true },
    }),
    db.opsIncident.findMany({
      where: { status: { in: activeIncidentStatuses } },
      select: { ownerId: true, slaDueAt: true, firstSeen: true },
    }),
    db.metricSnapshot.findMany({
      orderBy: [{ asOf: "desc" }, { id: "desc" }],
      take: 5_000,
      select: {
        metricKey: true,
        definitionVersion: true,
        qualityState: true,
        latestDataAt: true,
      },
    }),
    db.generationAttempt.count({ where: { status: { in: ["failed", "unknown"] } } }),
    db.generationAttempt.count({
      where: {
        status: { in: ["failed", "unknown"] },
        OR: [{ status: "unknown" }, { errorClass: null }, { errorClass: "unknown" }],
      },
    }),
    db.$queryRaw<Array<{ outcome: string; count: bigint }>>(Prisma.sql`
      WITH item_facts AS (
        SELECT
          b.id AS batch_id,
          GREATEST(b.count, COUNT(i.id)::int) AS expected_count,
          COUNT(i.id) FILTER (
            WHERE a.id IS NOT NULL AND a."deletedAt" IS NULL AND a."safetyStatus" = 'passed'
          )::int AS successful_count,
          COUNT(i.id) FILTER (
            WHERE NOT (a.id IS NOT NULL AND a."deletedAt" IS NULL AND a."safetyStatus" = 'passed')
              AND (i.status IN ('failed', 'cancelled') OR j.status IN ('failed', 'blocked', 'refunded', 'cancelled'))
          )::int AS failed_count
        FROM content_production_batches b
        LEFT JOIN content_production_items i ON i."batchId" = b.id
        LEFT JOIN generation_jobs j ON j.id = i."jobId"
        LEFT JOIN media_assets a ON a.id = i."mediaAssetId"
        GROUP BY b.id, b.count
      ), outcomes AS (
        SELECT CASE
          WHEN expected_count = 0 THEN 'pending'
          WHEN expected_count - successful_count - failed_count > 0 THEN 'running'
          WHEN successful_count = expected_count THEN 'succeeded'
          WHEN successful_count > 0 THEN 'partially_succeeded'
          ELSE 'failed'
        END AS outcome
        FROM item_facts
      )
      SELECT outcome, COUNT(*)::bigint AS count
      FROM outcomes
      GROUP BY outcome
    `),
  ]);

  for (const { queue, oldest } of oldestByQueue) {
    setGauge(
      "main_outbox_pending_age_seconds",
      "Age of the oldest pending Main outbox event",
      { queue },
      oldest ? Math.max(0, now.getTime() - oldest.createdAt.getTime()) / 1_000 : 0,
    );
  }

  const detectionLagBySeverity = new Map<string, number>();
  for (const incident of incidents) {
    const lag = Math.max(0, incident.createdAt.getTime() - incident.firstSeen.getTime()) / 1_000;
    detectionLagBySeverity.set(
      incident.severity,
      Math.max(detectionLagBySeverity.get(incident.severity) ?? 0, lag),
    );
  }
  setGauge(
    "incident_detection_lag_seconds",
    "Maximum durable Incident detection lag in the latest 1000 Incidents",
    { severity: "all" },
    Math.max(0, ...detectionLagBySeverity.values()),
  );
  for (const [severity, lag] of detectionLagBySeverity) {
    setGauge(
      "incident_detection_lag_seconds",
      "Maximum durable Incident detection lag in the latest 1000 Incidents",
      { severity },
      lag,
    );
  }

  const inboxes = [
    { source: "case", rows: openCases.map((row) => ({ ownerId: row.ownerId, slaDueAt: row.slaDueAt, openedAt: row.createdAt })) },
    { source: "incident", rows: openIncidents.map((row) => ({ ownerId: row.ownerId, slaDueAt: row.slaDueAt, openedAt: row.firstSeen })) },
  ];
  for (const inbox of inboxes) {
    setGauge("admin_inbox_open_total", "Open Admin Inbox work items", { source: inbox.source }, inbox.rows.length);
    setGauge("admin_inbox_unowned_total", "Unowned Admin Inbox work items", { source: inbox.source }, inbox.rows.filter((row) => row.ownerId === null).length);
    setGauge("admin_inbox_sla_breached_total", "Admin Inbox work items past SLA", { source: inbox.source }, inbox.rows.filter((row) => row.slaDueAt !== null && row.slaDueAt < now).length);
    const oldest = inbox.rows.reduce<Date | null>((value, row) => value === null || row.openedAt < value ? row.openedAt : value, null);
    setGauge("admin_inbox_oldest_age_seconds", "Age of the oldest open Admin Inbox work item", { source: inbox.source }, oldest ? Math.max(0, now.getTime() - oldest.getTime()) / 1_000 : 0);
  }

  const latestMetricSnapshots = new Map<string, (typeof metricSnapshots)[number]>();
  for (const snapshot of metricSnapshots) {
    const key = `${snapshot.metricKey}@${snapshot.definitionVersion}`;
    if (!latestMetricSnapshots.has(key)) latestMetricSnapshots.set(key, snapshot);
  }
  for (const snapshot of latestMetricSnapshots.values()) {
    const labels = { metric: snapshot.metricKey, version: snapshot.definitionVersion };
    if (snapshot.latestDataAt) {
      setGauge(
        "metric_freshness_seconds",
        "Age of the newest canonical fact represented by the latest Metric Snapshot",
        labels,
        Math.max(0, now.getTime() - snapshot.latestDataAt.getTime()) / 1_000,
      );
    }
    for (const state of ["certified", "directional", "invalid"] as const) {
      setGauge(
        "metric_data_quality_state",
        "Latest Metric Snapshot data quality state as a one-hot gauge",
        { ...labels, state },
        snapshot.qualityState === state ? 1 : 0,
      );
    }
  }

  setGauge(
    "generation_unknown_failure_rate",
    "Share of failed or unknown Generation Attempts without a classified failure",
    {},
    failedAttemptCount === 0 ? 0 : unknownFailureCount / failedAttemptCount,
  );

  const creativeOutcomeCounts = new Map(creativeOutcomes.map((row) => [row.outcome, Number(row.count)]));
  for (const outcome of ["pending", "running", "succeeded", "partially_succeeded", "failed", "cancelled"]) {
    setGauge(
      "creative_run_outcome_total",
      "Current Creative Runs grouped by canonical execution outcome",
      { outcome },
      creativeOutcomeCounts.get(outcome) ?? 0,
    );
  }

  return invariants;
}
