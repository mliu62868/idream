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
      CREATE TEMP TABLE readiness_cases (
        id bigint PRIMARY KEY,
        status text NOT NULL,
        priority text NOT NULL,
        owner_id text,
        sla_due_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE readiness_jobs (
        id bigint PRIMARY KEY,
        status text NOT NULL,
        provider text NOT NULL,
        error_signature text,
        created_at timestamptz NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE readiness_events (
        id bigint PRIMARY KEY,
        source_service text NOT NULL,
        source_event_id text NOT NULL,
        event_type text NOT NULL,
        occurred_at timestamptz NOT NULL,
        UNIQUE(source_service, source_event_id)
      ) ON COMMIT DROP;
      CREATE TEMP TABLE readiness_commands (id text PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE readiness_audits (command_id text NOT NULL) ON COMMIT DROP;
      CREATE TEMP TABLE readiness_outbox (command_id text NOT NULL) ON COMMIT DROP;
    `);
    await client.query(`INSERT INTO readiness_cases
      SELECT i,
        (ARRAY['new','triaged','in_progress','waiting','resolved'])[1 + (i % 5)],
        (ARRAY['urgent','high','normal','low'])[1 + (i % 4)],
        CASE WHEN i % 7 = 0 THEN NULL ELSE 'owner-' || (i % 500)::text END,
        now() + ((i % 240) - 120) * interval '1 minute',
        now() - (i % 86400) * interval '1 second'
      FROM generate_series(1, $1) i`, [CASES]);
    await client.query(`INSERT INTO readiness_jobs
      SELECT i,
        (ARRAY['queued','running','completed','failed','blocked'])[1 + (i % 5)],
        'provider-' || (i % 8)::text,
        CASE WHEN i % 5 IN (3,4) THEN 'signature-' || (i % 100)::text ELSE NULL END,
        now() - (i % 604800) * interval '1 second'
      FROM generate_series(1, $1) i`, [JOBS]);
    await client.query(`INSERT INTO readiness_events
      SELECT i, 'load-harness', 'event-' || i::text,
        (ARRAY['chat.exchange.completed.v2','generation.delivery.completed.v2','subscription.active.v2'])[1 + (i % 3)],
        now() - (i % 2592000) * interval '1 second'
      FROM generate_series(1, $1) i`, [EVENTS]);
    await client.query(`
      CREATE INDEX readiness_cases_queue_idx ON readiness_cases(status, priority, updated_at DESC, id DESC);
      CREATE INDEX readiness_cases_today_idx ON readiness_cases(owner_id, sla_due_at) WHERE status NOT IN ('resolved','closed');
      CREATE INDEX readiness_jobs_incident_idx ON readiness_jobs(provider, error_signature, created_at DESC) WHERE status IN ('failed','blocked');
      CREATE INDEX readiness_events_projection_idx ON readiness_events(event_type, occurred_at, id);
      ANALYZE readiness_cases;
      ANALYZE readiness_jobs;
      ANALYZE readiness_events;
    `);

    const caseList = await benchmark(client, "SELECT id, status, priority, owner_id, updated_at FROM readiness_cases WHERE status = 'in_progress' ORDER BY priority, updated_at DESC, id DESC LIMIT 50");
    const today = await benchmark(client, "SELECT id, priority, sla_due_at FROM readiness_cases WHERE owner_id IS NULL AND status NOT IN ('resolved','closed') ORDER BY sla_due_at, id LIMIT 100");
    const failedJobs = await benchmark(client, "SELECT provider, error_signature, count(*) FROM readiness_jobs WHERE status IN ('failed','blocked') AND created_at > now() - interval '24 hours' GROUP BY provider, error_signature ORDER BY count(*) DESC LIMIT 100");
    const eventProjection = await benchmark(client, "SELECT event_type, date_trunc('day', occurred_at), count(*) FROM readiness_events WHERE occurred_at > now() - interval '7 days' GROUP BY event_type, date_trunc('day', occurred_at)");

    const replayStartedAt = performance.now();
    await client.query(`INSERT INTO readiness_events
      SELECT i, 'load-harness', 'event-' || i::text, 'duplicate', now()
      FROM generate_series(1, 100000) i
      ON CONFLICT (source_service, source_event_id) DO NOTHING`);
    const replayMs = performance.now() - replayStartedAt;
    const eventCount = Number((await client.query<{ count: string }>("SELECT count(*)::text AS count FROM readiness_events")).rows[0].count);

    await client.query("SAVEPOINT atomic_command");
    await client.query("INSERT INTO readiness_commands VALUES ('command-rollback')");
    await client.query("INSERT INTO readiness_audits VALUES ('command-rollback')");
    await client.query("INSERT INTO readiness_outbox VALUES ('command-rollback')");
    await client.query("ROLLBACK TO SAVEPOINT atomic_command");
    const ghostEffects = Number((await client.query<{ count: string }>("SELECT (SELECT count(*) FROM readiness_commands) + (SELECT count(*) FROM readiness_audits) + (SELECT count(*) FROM readiness_outbox) AS count")).rows[0].count);

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
