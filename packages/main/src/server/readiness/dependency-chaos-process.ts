import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import Redis from "ioredis";
import { Pool, type PoolClient } from "pg";
import type {
  DependencyChaosHarnessOptions,
  DependencyChaosReport,
  DependencyChaosScenarioReport,
} from "./dependency-chaos";

const execFileAsync = promisify(execFile);
const HOST = "127.0.0.1";

function assertCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve an isolated dependency port"));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(
  probe: () => Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} did not become ready${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function waitForExit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      clearTimeout(giveUp);
      if (error) reject(error);
      else resolve();
    };
    const forceKill = setTimeout(() => {
      process.kill("SIGKILL");
    }, 5_000);
    const giveUp = setTimeout(
      () => done(new Error(`dependency process ${process.pid ?? "unknown"} did not exit after SIGKILL`)),
      5_500,
    );
    process.once("exit", () => done());
    process.once("close", () => done());
    process.once("error", (error) => done(error));
  });
  if (process.exitCode === null && process.signalCode === null) {
    throw new Error(`dependency process ${process.pid ?? "unknown"} exit could not be confirmed`);
  }
}

function spawnDependency(command: string, args: readonly string[]) {
  const process = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  process.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  process.once("error", () => undefined);
  return { process, stderr: () => stderr };
}

const DISPATCHER_CHILD_PROGRAM = String.raw`
  import pg from "pg";
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.CHAOS_DATABASE_URL, max: 1 });
  const commandId = process.env.CHAOS_COMMAND_ID;
  const mode = process.env.CHAOS_DISPATCHER_MODE;
  let outcome = { claimed: false, completed: false };
  try {
    if (mode === "claim-and-crash") {
      const result = await pool.query(
        "UPDATE chaos_commands SET status = 'running', lease_owner = 'worker-a', lease_expires_at = clock_timestamp() - interval '1 second', attempt_count = attempt_count + 1 WHERE id = $1 AND status = 'accepted' RETURNING id",
        [commandId],
      );
      outcome = { claimed: result.rowCount === 1, completed: false };
      if (outcome.claimed) {
        process.stdout.write("READY\n");
        await new Promise(() => undefined);
      }
    } else if (mode === "claim-and-complete") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const claimed = await client.query(
          "UPDATE chaos_commands SET status = 'running', lease_owner = 'worker-b', lease_expires_at = clock_timestamp() + interval '30 seconds', attempt_count = attempt_count + 1 WHERE id = $1 AND status = 'accepted' AND lease_owner IS NULL RETURNING id",
          [commandId],
        );
        const completed = claimed.rowCount === 1 ? await client.query(
          "UPDATE chaos_commands SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, finished_at = clock_timestamp() WHERE id = $1 AND status = 'running' AND lease_owner = 'worker-b' RETURNING id",
          [commandId],
        ) : { rowCount: 0 };
        if (completed.rowCount === 1) {
          await client.query("INSERT INTO chaos_audit (effect_key, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [commandId + '.completed', commandId]);
          await client.query("INSERT INTO chaos_outbox (id, event_type, aggregate_id) VALUES ($1, 'command.completed', $2) ON CONFLICT DO NOTHING", [commandId + '.completed', commandId]);
        }
        await client.query("COMMIT");
        outcome = { claimed: claimed.rowCount === 1, completed: completed.rowCount === 1 };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } else {
      throw new Error("Unknown chaos dispatcher mode");
    }
  } finally {
    await pool.end();
  }
  process.stdout.write(JSON.stringify(outcome));
`;

const REDIS_CONSUMER_CHILD_PROGRAM = String.raw`
  import pg from "pg";
  import Redis from "ioredis";
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.CHAOS_DATABASE_URL, max: 1 });
  const redis = new Redis({ host: "127.0.0.1", port: Number(process.env.CHAOS_REDIS_PORT), maxRetriesPerRequest: 1 });
  const jobId = process.env.CHAOS_COMMAND_ID;
  const claimed = await redis.rpoplpush(process.env.CHAOS_QUEUE, process.env.CHAOS_PROCESSING);
  if (claimed !== jobId) process.exit(2);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await client.query("INSERT INTO chaos_receipts (source_event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING source_event_id", [jobId]);
    if (receipt.rowCount === 1) {
      await client.query("INSERT INTO chaos_provider_calls (job_id) VALUES ($1) ON CONFLICT DO NOTHING", [jobId]);
      await client.query("INSERT INTO chaos_outbox (id, event_type, aggregate_id) VALUES ($1, 'provider.manifest.persisted', $2) ON CONFLICT DO NOTHING", [jobId + '.manifest', jobId]);
      await client.query("UPDATE chaos_commands SET status = 'succeeded', finished_at = clock_timestamp() WHERE id = $1", [jobId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  // Wait at the exact fault point; the parent harness sends SIGKILL before ACK.
  process.stdout.write("READY\n");
  await new Promise(() => undefined);
`;

const PROJECTOR_CRASH_CHILD_PROGRAM = String.raw`
  import pg from "pg";
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.CHAOS_DATABASE_URL, max: 1 });
  const state = await pool.query("SELECT (SELECT count(*)::int FROM chaos_receipts WHERE source_event_id LIKE 'projector-event-%') AS receipts, (SELECT last_seq::text FROM chaos_projection_watermarks WHERE projection = 'admin-metrics') AS watermark");
  if (state.rows[0]?.receipts === 3 && state.rows[0]?.watermark === '0') {
    process.stdout.write("READY\n");
    await new Promise(() => undefined);
  }
  process.exit(3);
`;

const REDIS_CONSUMER_RECOVERY_PROGRAM = String.raw`
  import pg from "pg";
  import Redis from "ioredis";
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.CHAOS_DATABASE_URL, max: 1 });
  const redis = new Redis({ host: "127.0.0.1", port: Number(process.env.CHAOS_REDIS_PORT), maxRetriesPerRequest: 1 });
  const jobId = process.env.CHAOS_COMMAND_ID;
  const stranded = await redis.lindex(process.env.CHAOS_PROCESSING, 0);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO chaos_receipts (source_event_id) VALUES ($1) ON CONFLICT DO NOTHING", [jobId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const receipt = await pool.query("SELECT count(*)::int AS receipts FROM chaos_receipts WHERE source_event_id = $1", [jobId]);
  const acknowledged = await redis.lrem(process.env.CHAOS_PROCESSING, 1, jobId);
  const queue = await redis.llen(process.env.CHAOS_QUEUE);
  const processing = await redis.llen(process.env.CHAOS_PROCESSING);
  await redis.quit();
  await pool.end();
  process.stdout.write(JSON.stringify({ stranded, receipts: receipt.rows[0]?.receipts, acknowledged, queue, processing }));
`;

const PROJECTOR_RECOVERY_PROGRAM = String.raw`
  import pg from "pg";
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.CHAOS_DATABASE_URL, max: 1 });
  const events = await pool.query("SELECT seq::text, source_event_id, value FROM chaos_canonical_events WHERE seq > (SELECT last_seq FROM chaos_projection_watermarks WHERE projection = 'admin-metrics') ORDER BY seq");
  for (const event of events.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const receipt = await client.query("INSERT INTO chaos_projection_receipts (source_event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING source_event_id", [event.source_event_id]);
      if (receipt.rowCount === 1) await client.query("UPDATE chaos_projection_state SET value = value + $1 WHERE projection = 'admin-metrics'", [event.value]);
      await client.query("UPDATE chaos_projection_watermarks SET last_seq = GREATEST(last_seq, $1::bigint) WHERE projection = 'admin-metrics'", [event.seq]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  await pool.end();
  process.stdout.write(JSON.stringify({ applied: events.rowCount }));
`;

async function runDispatcherChild(
  connectionString: string,
  commandId: string,
  mode: "claim-and-crash" | "claim-and-complete",
): Promise<{ readonly exitCode: number | null; readonly claimed: boolean; readonly completed: boolean; readonly stderr: string }> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", DISPATCHER_CHILD_PROGRAM], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHAOS_DATABASE_URL: connectionString,
      CHAOS_COMMAND_ID: commandId,
      CHAOS_DISPATCHER_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const parsed = stdout.length > 0
    ? JSON.parse(stdout) as { claimed?: unknown; completed?: unknown }
    : {};
  return {
    exitCode,
    claimed: parsed.claimed === true,
    completed: parsed.completed === true,
    stderr,
  };
}

async function runKilledChild(
  program: string,
  environment: Readonly<Record<string, string>>,
): Promise<boolean> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`fault child ${child.pid ?? "unknown"} did not reach READY`)), 5_000);
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const signaled = child.kill("SIGKILL");
  if (!signaled) throw new Error(`failed to SIGKILL fault child ${child.pid ?? "unknown"}`);
  await waitForExit(child);
  if (stderr.length > 0) throw new Error(stderr);
  return child.signalCode === "SIGKILL";
}

async function runJsonChild<T>(
  program: string,
  environment: Readonly<Record<string, string>>,
): Promise<T> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0 || stderr.length > 0) throw new Error(stderr || `recovery child exited ${exitCode}`);
  return JSON.parse(stdout) as T;
}

class IsolatedPostgres {
  readonly port: number;
  readonly dataDir: string;
  readonly url: string;
  restartCount = 0;
  private process: ChildProcess | null = null;
  private stderr = () => "";

  private constructor(
    port: number,
    dataDir: string,
    private readonly postgresBin: string,
  ) {
    this.port = port;
    this.dataDir = dataDir;
    this.url = `postgresql://postgres@${HOST}:${port}/postgres`;
  }

  static async create(options: DependencyChaosHarnessOptions): Promise<IsolatedPostgres> {
    const port = await freePort();
    const root = await mkdtemp(join(tmpdir(), "idream-admin-chaos-pg-"));
    const dataDir = join(root, "data");
    try {
      await execFileAsync(options.initdbBin ?? "initdb", [
        "-D", dataDir,
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--username=postgres",
      ]);
      return new IsolatedPostgres(port, dataDir, options.postgresBin ?? "postgres");
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async start(): Promise<void> {
    assertCheck(this.process === null, "isolated Postgres is already running");
    const spawned = spawnDependency(this.postgresBin, [
      "-D", this.dataDir,
      "-h", HOST,
      "-p", String(this.port),
    ]);
    this.process = spawned.process;
    this.stderr = spawned.stderr;
    await waitFor(async () => {
      if (this.process?.exitCode !== null) {
        throw new Error(this.stderr() || "isolated Postgres exited");
      }
      const pool = createPool(this.url);
      try {
        await pool.query("SELECT 1");
        return true;
      } finally {
        await pool.end().catch(() => undefined);
      }
    }, "isolated Postgres");
  }

  private async terminate(signal: NodeJS.Signals): Promise<void> {
    const process = this.process;
    if (!process) return;
    const signaled = process.kill(signal);
    if (!signaled && process.exitCode === null && process.signalCode === null) {
      throw new Error(`failed to signal isolated Postgres process ${process.pid ?? "unknown"}`);
    }
    await waitForExit(process);
    this.process = null;
  }

  async stop(): Promise<void> {
    await this.terminate("SIGINT");
  }

  async crash(): Promise<void> {
    await this.terminate("SIGKILL");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.restartCount += 1;
  }

  async cleanup(): Promise<void> {
    await this.stop();
    await rm(join(this.dataDir, ".."), { recursive: true, force: true });
  }
}

class IsolatedRedis {
  readonly port: number;
  restartCount = 0;
  private process: ChildProcess | null = null;
  private stderr = () => "";

  private constructor(port: number, private readonly redisServerBin: string) {
    this.port = port;
  }

  static async create(options: DependencyChaosHarnessOptions): Promise<IsolatedRedis> {
    return new IsolatedRedis(await freePort(), options.redisServerBin ?? "redis-server");
  }

  connect(): Redis {
    const redis = new Redis({
      host: HOST,
      port: this.port,
      lazyConnect: true,
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    return redis;
  }

  async start(): Promise<void> {
    assertCheck(this.process === null, "isolated Redis is already running");
    const spawned = spawnDependency(this.redisServerBin, [
      "--bind", HOST,
      "--port", String(this.port),
      "--save", "",
      "--appendonly", "no",
      "--protected-mode", "no",
    ]);
    this.process = spawned.process;
    this.stderr = spawned.stderr;
    await waitFor(async () => {
      if (this.process?.exitCode !== null) throw new Error(this.stderr() || "isolated Redis exited");
      const client = this.connect();
      try {
        await client.connect();
        return await client.ping() === "PONG";
      } finally {
        client.disconnect();
      }
    }, "isolated Redis");
  }

  private async terminate(signal: NodeJS.Signals): Promise<void> {
    const process = this.process;
    if (!process) return;
    const signaled = process.kill(signal);
    if (!signaled && process.exitCode === null && process.signalCode === null) {
      throw new Error(`failed to signal isolated Redis process ${process.pid ?? "unknown"}`);
    }
    await waitForExit(process);
    this.process = null;
  }

  async stop(): Promise<void> {
    await this.terminate("SIGTERM");
  }

  async crash(): Promise<void> {
    await this.terminate("SIGKILL");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.restartCount += 1;
  }

  async cleanup(): Promise<void> {
    await this.stop();
  }
}

function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 1_000,
    query_timeout: 1_000,
    max: 4,
  });
  // A deliberate server stop terminates idle clients asynchronously. The
  // harness records the failed query as evidence; the pool error event must
  // not turn that expected fault into an unhandled process crash.
  pool.on("error", () => undefined);
  return pool;
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE chaos_commands (
      id text PRIMARY KEY,
      status text NOT NULL,
      lease_owner text,
      lease_expires_at timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      finished_at timestamptz
    );
    CREATE TABLE chaos_audit (
      effect_key text PRIMARY KEY,
      target_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE chaos_outbox (
      id text PRIMARY KEY,
      event_type text NOT NULL,
      aggregate_id text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      dispatched_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE chaos_receipts (
      source_event_id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE chaos_provider_calls (
      job_id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE chaos_canonical_events (
      seq bigserial PRIMARY KEY,
      source_event_id text UNIQUE NOT NULL,
      value integer NOT NULL
    );
    CREATE TABLE chaos_projection_receipts (
      source_event_id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE chaos_projection_state (
      projection text PRIMARY KEY,
      value integer NOT NULL DEFAULT 0
    );
    CREATE TABLE chaos_projection_watermarks (
      projection text PRIMARY KEY,
      last_seq bigint NOT NULL DEFAULT 0
    );
    INSERT INTO chaos_projection_state (projection, value) VALUES ('admin-metrics', 0);
    INSERT INTO chaos_projection_watermarks (projection, last_seq) VALUES ('admin-metrics', 0);
  `);
}

async function runScenario(
  run: () => Promise<Readonly<Record<string, boolean>>>,
): Promise<DependencyChaosScenarioReport> {
  const startedAt = performance.now();
  try {
    const checks = await run();
    return {
      status: Object.values(checks).every(Boolean) ? "pass" : "fail",
      durationMs: performance.now() - startedAt,
      checks,
    };
  } catch (error) {
    return {
      status: "fail",
      durationMs: performance.now() - startedAt,
      checks: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function databaseReconnectScenario(
  postgres: IsolatedPostgres,
  getPool: () => Pool,
  replacePool: () => Promise<Pool>,
): Promise<Readonly<Record<string, boolean>>> {
  await transaction(getPool(), async (client) => {
    await client.query("INSERT INTO chaos_commands (id, status) VALUES ('db-command', 'accepted')");
    await client.query("INSERT INTO chaos_audit (effect_key, target_id) VALUES ('db-command.accepted', 'db-command')");
    await client.query("INSERT INTO chaos_outbox (id, event_type, aggregate_id) VALUES ('db-command.accepted', 'command.accepted', 'db-command')");
  });
  await postgres.crash();
  let interruptionObserved = false;
  try {
    await getPool().query("SELECT 1");
  } catch {
    interruptionObserved = true;
  }
  await postgres.start();
  postgres.restartCount += 1;
  const pool = await replacePool();
  const result = await pool.query<{ command_count: number; audit_count: number; outbox_count: number }>(`
    SELECT
      (SELECT count(*)::int FROM chaos_commands WHERE id = 'db-command') AS command_count,
      (SELECT count(*)::int FROM chaos_audit WHERE effect_key = 'db-command.accepted') AS audit_count,
      (SELECT count(*)::int FROM chaos_outbox WHERE id = 'db-command.accepted') AS outbox_count
  `);
  const row = result.rows[0];
  return {
    interruptionObserved,
    reconnected: true,
    committedCommandSurvived: row?.command_count === 1,
    singleAuditAfterReconnect: row?.audit_count === 1,
    singleOutboxAfterReconnect: row?.outbox_count === 1,
  };
}

async function redisConsumerRecoveryScenario(
  pool: Pool,
  redisService: IsolatedRedis,
): Promise<Readonly<Record<string, boolean>>> {
  const queue = "idream:chaos:ready";
  const processing = "idream:chaos:processing";
  const jobId = "redis-job";
  await transaction(pool, async (client) => {
    await client.query("INSERT INTO chaos_commands (id, status) VALUES ($1, 'accepted')", [jobId]);
    await client.query("INSERT INTO chaos_audit (effect_key, target_id) VALUES ($1, $2)", [`${jobId}.accepted`, jobId]);
    await client.query("INSERT INTO chaos_outbox (id, event_type, aggregate_id) VALUES ($1, 'provider.requested', $2)", [`${jobId}.requested`, jobId]);
  });

  await redisService.crash();
  const unavailable = redisService.connect();
  let enqueueLossObserved = false;
  try {
    await unavailable.connect();
    await unavailable.lpush(queue, jobId);
  } catch {
    enqueueLossObserved = true;
  } finally {
    unavailable.disconnect();
  }
  const beforeRestart = await pool.query<{ status: string; outbox_status: string }>(`
    SELECT command.status, outbox.status AS outbox_status
    FROM chaos_commands command
    JOIN chaos_outbox outbox ON outbox.aggregate_id = command.id
    WHERE command.id = $1 AND outbox.id = $2
  `, [jobId, `${jobId}.requested`]);

  await redisService.start();
  redisService.restartCount += 1;
  const dispatcher = redisService.connect();
  await dispatcher.connect();
  const queueWasEmptyAfterRestart = await dispatcher.llen(queue) === 0;
  const queued = await dispatcher.eval(
    "if redis.call('SET', KEYS[1], '1', 'NX') then redis.call('LPUSH', KEYS[2], ARGV[1]); return 1 else return 0 end",
    2,
    `idream:chaos:dedupe:${jobId}`,
    queue,
    jobId,
  );
  assertCheck(Number(queued) === 1, "dispatcher did not enqueue the durable outbox row");
  await pool.query(
    "UPDATE chaos_outbox SET status = 'dispatched', dispatched_at = clock_timestamp() WHERE id = $1 AND status = 'pending'",
    [`${jobId}.requested`],
  );

  dispatcher.disconnect();
  const consumerKilled = await runKilledChild(REDIS_CONSUMER_CHILD_PROGRAM, {
    CHAOS_DATABASE_URL: pool.options.connectionString ?? "",
    CHAOS_REDIS_PORT: String(redisService.port),
    CHAOS_COMMAND_ID: jobId,
    CHAOS_QUEUE: queue,
    CHAOS_PROCESSING: processing,
  });
  const recovery = await runJsonChild<{
    stranded: string | null;
    receipts: number;
    acknowledged: number;
    queue: number;
    processing: number;
  }>(REDIS_CONSUMER_RECOVERY_PROGRAM, {
    CHAOS_DATABASE_URL: pool.options.connectionString ?? "",
    CHAOS_REDIS_PORT: String(redisService.port),
    CHAOS_COMMAND_ID: jobId,
    CHAOS_QUEUE: queue,
    CHAOS_PROCESSING: processing,
  });

  const counts = await pool.query<{
    receipts: number;
    providers: number;
    audit: number;
    request_outbox: number;
    manifest_outbox: number;
    command_commit_before_dispatch: boolean;
  }>(`
    SELECT
      (SELECT count(*)::int FROM chaos_receipts WHERE source_event_id = $1) AS receipts,
      (SELECT count(*)::int FROM chaos_provider_calls WHERE job_id = $1) AS providers,
      (SELECT count(*)::int FROM chaos_audit WHERE effect_key = $2) AS audit,
      (SELECT count(*)::int FROM chaos_outbox WHERE id = $3) AS request_outbox,
      (SELECT count(*)::int FROM chaos_outbox WHERE id = $4) AS manifest_outbox,
      (SELECT command.committed_at <= outbox.dispatched_at
        FROM chaos_commands command JOIN chaos_outbox outbox ON outbox.id = $3
        WHERE command.id = $1) AS command_commit_before_dispatch
  `, [jobId, `${jobId}.accepted`, `${jobId}.requested`, `${jobId}.manifest`]);
  const row = counts.rows[0];
  return {
    redisEnqueueLossObserved: enqueueLossObserved,
    consumerProcessCrashObserved: consumerKilled,
    consumerRestartObserved: recovery.stranded === jobId,
    durableStateStayedAccepted: beforeRestart.rows[0]?.status === "accepted",
    outboxStayedPending: beforeRestart.rows[0]?.outbox_status === "pending",
    noGhostQueued: queueWasEmptyAfterRestart && recovery.queue === 0 && recovery.processing === 0,
    commandCommittedBeforeDispatch: row?.command_commit_before_dispatch === true,
    commitBeforeAck: recovery.receipts === 1 && recovery.acknowledged === 1,
    providerNotRepeated: row?.providers === 1,
    singleReceipt: row?.receipts === 1,
    singleAudit: row?.audit === 1,
    singleRequestOutbox: row?.request_outbox === 1,
    singleManifestOutbox: row?.manifest_outbox === 1,
  };
}

async function dispatcherLeaseRecoveryScenario(
  pool: Pool,
  connectionString: string,
): Promise<Readonly<Record<string, boolean>>> {
  const commandId = "dispatcher-command";
  await pool.query("INSERT INTO chaos_commands (id, status) VALUES ($1, 'accepted')", [commandId]);
  const dispatcherKilled = await runKilledChild(DISPATCHER_CHILD_PROGRAM, {
    CHAOS_DATABASE_URL: connectionString,
    CHAOS_COMMAND_ID: commandId,
    CHAOS_DISPATCHER_MODE: "claim-and-crash",
  });
  const crashedClaim = await pool.query<{ lease_owner: string }>(
    "SELECT lease_owner FROM chaos_commands WHERE id = $1 AND status = 'running'",
    [commandId],
  );
  const recovered = await pool.query(`
    UPDATE chaos_commands
    SET status = 'accepted', lease_owner = NULL, lease_expires_at = NULL
    WHERE id = $1 AND status = 'running' AND lease_expires_at < clock_timestamp()
    RETURNING id
  `, [commandId]);
  const restartedDispatcher = await runDispatcherChild(connectionString, commandId, "claim-and-complete");
  const replayedCompletion = await runDispatcherChild(connectionString, commandId, "claim-and-complete");
  const result = await pool.query<{ status: string; attempt_count: number; audits: number; outboxes: number }>(`
    SELECT command.status, command.attempt_count,
      (SELECT count(*)::int FROM chaos_audit WHERE effect_key = $2) AS audits,
      (SELECT count(*)::int FROM chaos_outbox WHERE id = $2) AS outboxes
    FROM chaos_commands command WHERE command.id = $1
  `, [commandId, `${commandId}.completed`]);
  const row = result.rows[0];
  return {
    processCrashObserved:
      dispatcherKilled && crashedClaim.rows[0]?.lease_owner === "worker-a",
    expiredLeaseRecovered: recovered.rowCount === 1,
    restartedDispatcherClaimed: restartedDispatcher.exitCode === 0 && restartedDispatcher.claimed,
    commandCompletedOnce:
      restartedDispatcher.completed &&
      !replayedCompletion.claimed &&
      !replayedCompletion.completed &&
      row?.status === "succeeded",
    attemptAdvanced: row?.attempt_count === 2,
    singleAudit: row?.audits === 1,
    singleOutbox: row?.outboxes === 1,
  };
}

async function projectorWatermarkRecoveryScenario(pool: Pool): Promise<Readonly<Record<string, boolean>>> {
  for (const [sourceEventId, value] of [["projector-event-1", 2], ["projector-event-2", 3], ["projector-event-3", 5]] as const) {
    await transaction(pool, async (client) => {
      await client.query("INSERT INTO chaos_receipts (source_event_id) VALUES ($1) ON CONFLICT DO NOTHING", [sourceEventId]);
      await client.query(
        "INSERT INTO chaos_canonical_events (source_event_id, value) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [sourceEventId, value],
      );
    });
  }
  // Projector exits after durable ingest receipts commit and before advancing its watermark.
  const before = await pool.query<{ receipts: number; watermark: string }>(`
    SELECT
      (SELECT count(*)::int FROM chaos_receipts WHERE source_event_id LIKE 'projector-event-%') AS receipts,
      (SELECT last_seq::text FROM chaos_projection_watermarks WHERE projection = 'admin-metrics') AS watermark
  `);
  const projectorKilled = await runKilledChild(PROJECTOR_CRASH_CHILD_PROGRAM, {
    CHAOS_DATABASE_URL: pool.options.connectionString ?? "",
  });
  const firstCatchUp = await runJsonChild<{ applied: number }>(PROJECTOR_RECOVERY_PROGRAM, {
    CHAOS_DATABASE_URL: pool.options.connectionString ?? "",
  });
  const replayCatchUp = await runJsonChild<{ applied: number }>(PROJECTOR_RECOVERY_PROGRAM, {
    CHAOS_DATABASE_URL: pool.options.connectionString ?? "",
  });
  const after = await pool.query<{ projection_value: number; projection_receipts: number; watermark: string; max_seq: string }>(`
    SELECT
      (SELECT value FROM chaos_projection_state WHERE projection = 'admin-metrics') AS projection_value,
      (SELECT count(*)::int FROM chaos_projection_receipts WHERE source_event_id LIKE 'projector-event-%') AS projection_receipts,
      (SELECT last_seq::text FROM chaos_projection_watermarks WHERE projection = 'admin-metrics') AS watermark,
      (SELECT max(seq)::text FROM chaos_canonical_events WHERE source_event_id LIKE 'projector-event-%') AS max_seq
  `);
  const row = after.rows[0];
  return {
    projectorProcessCrashObserved: projectorKilled,
    projectorRestartObserved: firstCatchUp.applied === 3,
    receiptCommittedBeforeCrash: before.rows[0]?.receipts === 3 && before.rows[0]?.watermark === "0",
    projectorLagObserved: firstCatchUp.applied === 3,
    watermarkCaughtUp: row?.watermark === row?.max_seq,
    canonicalValueExact: row?.projection_value === 10,
    singleProjectionReceipt: row?.projection_receipts === 3,
    replayNoOp: replayCatchUp.applied === 0,
  };
}

function check(scenario: DependencyChaosScenarioReport, key: string): boolean {
  return scenario.status === "pass" && scenario.checks[key] === true;
}

export async function runDependencyChaosHarness(
  options: DependencyChaosHarnessOptions = {},
): Promise<DependencyChaosReport> {
  const runId = randomUUID();
  const startedAt = new Date();
  let postgres: IsolatedPostgres | null = null;
  let redis: IsolatedRedis | null = null;
  let pool: Pool | null = null;
  let databaseReconnect: DependencyChaosScenarioReport = { status: "fail", durationMs: 0, checks: {}, error: "not_run" };
  let redisConsumerRecovery: DependencyChaosScenarioReport = { status: "fail", durationMs: 0, checks: {}, error: "not_run" };
  let dispatcherLeaseRecovery: DependencyChaosScenarioReport = { status: "fail", durationMs: 0, checks: {}, error: "not_run" };
  let projectorWatermarkRecovery: DependencyChaosScenarioReport = { status: "fail", durationMs: 0, checks: {}, error: "not_run" };
  const cleanupErrors: string[] = [];
  try {
    postgres = await IsolatedPostgres.create(options);
    redis = await IsolatedRedis.create(options);
    await Promise.all([postgres.start(), redis.start()]);
    pool = createPool(postgres.url);
    await createSchema(pool);

    const postgresRef = postgres;
    databaseReconnect = await runScenario(() => databaseReconnectScenario(
      postgresRef,
      () => {
        assertCheck(pool !== null, "Postgres pool is unavailable");
        return pool;
      },
      async () => {
        if (pool) await pool.end().catch(() => undefined);
        pool = createPool(postgresRef.url);
        await pool.query("SELECT 1");
        return pool;
      },
    ));
    if (pool) {
      redisConsumerRecovery = await runScenario(() => redisConsumerRecoveryScenario(pool as Pool, redis as IsolatedRedis));
      dispatcherLeaseRecovery = await runScenario(() => dispatcherLeaseRecoveryScenario(pool as Pool, postgresRef.url));
      projectorWatermarkRecovery = await runScenario(() => projectorWatermarkRecoveryScenario(pool as Pool));
    }
  } catch (error) {
    const setupError = error instanceof Error ? error.message : String(error);
    if (databaseReconnect.error === "not_run") {
      databaseReconnect = { status: "fail", durationMs: 0, checks: {}, error: `infrastructure_setup_failed: ${setupError}` };
    } else if (redisConsumerRecovery.error === "not_run") {
      redisConsumerRecovery = { status: "fail", durationMs: 0, checks: {}, error: `infrastructure_setup_failed: ${setupError}` };
    }
  } finally {
    const cleanupResults = await Promise.allSettled([
      pool?.end(),
      postgres?.cleanup(),
      redis?.cleanup(),
    ]);
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }
  }

  if (cleanupErrors.length > 0) {
    databaseReconnect = {
      ...databaseReconnect,
      status: "fail",
      error: `${databaseReconnect.error ? `${databaseReconnect.error}; ` : ""}cleanup_failed: ${cleanupErrors.join("; ")}`,
    };
  }

  const scenarios = {
    databaseReconnect,
    redisConsumerRecovery,
    dispatcherLeaseRecovery,
    projectorWatermarkRecovery,
  };
  const assertions = {
    commitBeforeAck: check(redisConsumerRecovery, "commitBeforeAck"),
    noGhostQueued: check(redisConsumerRecovery, "noGhostQueued"),
    providerNotRepeated: check(redisConsumerRecovery, "providerNotRepeated"),
    singleAudit:
      check(databaseReconnect, "singleAuditAfterReconnect") &&
      check(redisConsumerRecovery, "singleAudit") &&
      check(dispatcherLeaseRecovery, "singleAudit"),
    singleOutbox:
      check(databaseReconnect, "singleOutboxAfterReconnect") &&
      check(redisConsumerRecovery, "singleRequestOutbox") &&
      check(redisConsumerRecovery, "singleManifestOutbox") &&
      check(dispatcherLeaseRecovery, "singleOutbox"),
    singleReceipt:
      check(redisConsumerRecovery, "singleReceipt") &&
      check(projectorWatermarkRecovery, "singleProjectionReceipt"),
    projectorCaughtUp: check(projectorWatermarkRecovery, "watermarkCaughtUp"),
  };
  const endedAt = new Date();
  const passed = Object.values(scenarios).every((scenario) => scenario.status === "pass") &&
    Object.values(assertions).every(Boolean);
  return {
    schemaVersion: 1,
    runId,
    environment: "isolated-production-like",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    status: passed ? "pass" : "fail",
    infrastructure: {
      postgres: { isolated: true, restartCount: postgres?.restartCount ?? 0 },
      redis: { isolated: true, restartCount: redis?.restartCount ?? 0 },
    },
    scenarios,
    assertions,
  };
}
