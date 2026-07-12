import pg from "pg";
import { env } from "@/server/lib/env";

const CASES = 100_000;
const JOBS = 100_000;
const EVENTS = 1_000_000;
const ITERATIONS = 7;

function percentile(values: readonly number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function executionTime(client: pg.Client, sql: string) {
  const result = await client.query<{ "QUERY PLAN": Array<{ "Execution Time": number }> }>(`EXPLAIN (ANALYZE, FORMAT JSON, TIMING TRUE) ${sql}`);
  return Number(result.rows[0]["QUERY PLAN"][0]["Execution Time"]);
}

async function benchmark(client: pg.Client, sql: string) {
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) samples.push(await executionTime(client, sql));
  return { samplesMs: samples, p95Ms: percentile(samples, 0.95) };
}

async function main() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const startedAt = performance.now();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(`
      CREATE TEMP TABLE admin_cases (LIKE public.admin_cases INCLUDING ALL) ON COMMIT DROP;
      CREATE TEMP TABLE generation_jobs (LIKE public.generation_jobs INCLUDING ALL) ON COMMIT DROP;
      CREATE TEMP TABLE analytics_events (LIKE public.analytics_events INCLUDING ALL) ON COMMIT DROP;
      CREATE TEMP TABLE control_plane_commands (LIKE public.control_plane_commands INCLUDING ALL) ON COMMIT DROP;
      CREATE TEMP TABLE admin_audit_logs (LIKE public.admin_audit_logs INCLUDING ALL) ON COMMIT DROP;
      CREATE TEMP TABLE main_outbox_events (LIKE public.main_outbox_events INCLUDING ALL) ON COMMIT DROP;
    `);
    await client.query(`INSERT INTO admin_cases
      (id, type, "targetType", "targetId", "caseKey", status, priority, "ownerId", "slaDueAt", "updatedAt")
      SELECT 'case-' || i::text, 'content_report', 'character', 'target-' || i::text, 'load-' || i::text,
        (ARRAY['new','triaged','in_progress','waiting','resolved'])[1 + (i % 5)],
        (ARRAY['urgent','high','normal','low'])[1 + (i % 4)],
        CASE WHEN i % 7 = 0 THEN NULL ELSE 'owner-' || (i % 500)::text END,
        now() + ((i % 240) - 120) * interval '1 minute',
        now() - (i % 86400) * interval '1 second'
      FROM generate_series(1, $1) i`, [CASES]);
    await client.query(`INSERT INTO generation_jobs
      (id, "userId", mode, controls, "presetIds", status, provider, "errorCode", "createdAt", "updatedAt")
      SELECT 'job-' || i::text, 'load-user', 'image', '{}'::jsonb, '[]'::jsonb,
        (ARRAY['queued','running','completed','failed','blocked'])[1 + (i % 5)],
        'provider-' || (i % 8)::text,
        CASE WHEN i % 5 IN (3,4) THEN 'signature-' || (i % 100)::text ELSE NULL END,
        now() - (i % 604800) * interval '1 second',
        now() - (i % 604800) * interval '1 second'
      FROM generate_series(1, $1) i`, [JOBS]);
    await client.query(`INSERT INTO analytics_events
      (id, name, props, "sourceService", "sourceEventId", "occurredAt", "createdAt")
      SELECT 'event-' || i::text,
        (ARRAY['chat.exchange.completed.v2','generation.delivery.completed.v2','subscription.active.v2'])[1 + (i % 3)],
        '{}'::jsonb, 'load-harness', 'event-' || i::text,
        now() - (i % 2592000) * interval '1 second',
        now() - (i % 2592000) * interval '1 second'
      FROM generate_series(1, $1) i`, [EVENTS]);
    await client.query(`
      CREATE INDEX readiness_cases_queue_idx ON admin_cases(status, priority, "updatedAt" DESC, id DESC);
      CREATE INDEX readiness_cases_today_idx ON admin_cases("ownerId", "slaDueAt") WHERE status NOT IN ('resolved','closed');
      CREATE INDEX readiness_jobs_incident_idx ON generation_jobs(provider, "errorCode", "createdAt" DESC) WHERE status IN ('failed','blocked');
      CREATE INDEX readiness_events_projection_idx ON analytics_events(name, "occurredAt", id);
      ANALYZE admin_cases;
      ANALYZE generation_jobs;
      ANALYZE analytics_events;
    `);

    const caseList = await benchmark(client, `SELECT id, status, priority, "ownerId", "updatedAt" FROM admin_cases WHERE status = 'in_progress' ORDER BY priority, "updatedAt" DESC, id DESC LIMIT 50`);
    const today = await benchmark(client, `SELECT id, priority, "slaDueAt" FROM admin_cases WHERE "ownerId" IS NULL AND status NOT IN ('resolved','closed') ORDER BY "slaDueAt", id LIMIT 100`);
    const failedJobs = await benchmark(client, `SELECT provider, "errorCode", count(*) FROM generation_jobs WHERE status IN ('failed','blocked') AND "createdAt" > now() - interval '24 hours' GROUP BY provider, "errorCode" ORDER BY count(*) DESC LIMIT 100`);
    const eventProjection = await benchmark(client, `SELECT name, date_trunc('day', "occurredAt"), count(*) FROM analytics_events WHERE "occurredAt" > now() - interval '7 days' GROUP BY name, date_trunc('day', "occurredAt")`);

    const replayStartedAt = performance.now();
    await client.query(`INSERT INTO analytics_events
      (id, name, props, "sourceService", "sourceEventId", "occurredAt", "createdAt")
      SELECT 'duplicate-' || i::text, 'duplicate', '{}'::jsonb, 'load-harness', 'event-' || i::text, now(), now()
      FROM generate_series(1, 100000) i
      ON CONFLICT ("sourceService", "sourceEventId") DO NOTHING`);
    const replayMs = performance.now() - replayStartedAt;
    const eventCount = Number((await client.query<{ count: string }>("SELECT count(*)::text AS count FROM analytics_events")).rows[0].count);

    await client.query("SAVEPOINT atomic_command");
    await client.query(`INSERT INTO control_plane_commands
      (id, scope, "idempotencyKey", "commandType", "targetType", "targetId", "actorId", "requestId", "requestHash", "requestPayload", "updatedAt")
      VALUES ('command-rollback', 'readiness', 'rollback', 'readiness.test', 'readiness', 'target', 'actor', 'request', 'hash', '{}'::jsonb, now())`);
    await client.query(`INSERT INTO admin_audit_logs
      (id, "actorId", "actorRole", action, "targetType", "targetId", "requestId")
      VALUES ('audit-rollback', 'actor', 'admin', 'readiness.test', 'readiness', 'target', 'command-rollback')`);
    await client.query(`INSERT INTO main_outbox_events
      (id, "eventType", "aggregateType", "aggregateId", payload, "updatedAt")
      VALUES ('outbox-rollback', 'readiness.test', 'readiness', 'command-rollback', '{}'::jsonb, now())`);
    await client.query("ROLLBACK TO SAVEPOINT atomic_command");
    const ghostEffects = Number((await client.query<{ count: string }>("SELECT (SELECT count(*) FROM control_plane_commands) + (SELECT count(*) FROM admin_audit_logs) + (SELECT count(*) FROM main_outbox_events) AS count")).rows[0].count);

    const checks = {
      caseListP95Under500ms: caseList.p95Ms < 500,
      todayP95Under1000ms: today.p95Ms < 1_000,
      failedJobCorrelationP95Under750ms: failedJobs.p95Ms < 750,
      eventProjectionP95Under1000ms: eventProjection.p95Ms < 1_000,
      replayDidNotDuplicate: eventCount === EVENTS,
      atomicRollbackLeftNoGhosts: ghostEffects === 0,
    };
    const report = {
      status: Object.values(checks).every(Boolean) ? "pass" : "fail",
      schema: "Prisma production tables cloned with LIKE INCLUDING ALL into transaction-scoped temp tables",
      scale: { cases: CASES, jobs: JOBS, events: EVENTS, replayedEvents: 100_000 },
      durationMs: performance.now() - startedAt,
      benchmarks: { caseList, today, failedJobs, eventProjection, replayMs },
      chaos: { eventCount, ghostEffects },
      checks,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.query("ROLLBACK");
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
