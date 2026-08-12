const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const genCwd = path.join(repoRoot, "packages/gen");
const genTsxEntrypoint = path.join(genCwd, "node_modules/tsx/dist/cli.mjs");
const requireFromGen = createRequire(path.join(genCwd, "package.json"));
const workerSpecs = {
  image: {
    appName: "gen-image",
    entrypoint: "src/image.ts",
    queue: "ai.image.generate",
    runIdEnv: "GEN_IMAGE_WORKER_RUN_ID",
    identityPattern:
      /^idream\.gen-image\.v1\.([a-zA-Z0-9_-]+)\.(\d+)\.(\d+)$/,
  },
  video: {
    appName: "gen-video",
    entrypoint: "src/video.ts",
    queue: "ai.video.generate",
    runIdEnv: "GEN_VIDEO_WORKER_RUN_ID",
    identityPattern:
      /^idream\.gen-video\.v1\.([a-zA-Z0-9_-]+)\.(\d+)\.(\d+)$/,
  },
};

function parseJsonArraySuffix(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trimStart().startsWith("[")) continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n").trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // PM2 version notices may precede the JSON array. No other payload is safe.
    }
  }
  throw new Error("pm2 jlist did not return a JSON array");
}

function parsePsSnapshot(output) {
  const rows = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/,
    );
    if (!match) throw new Error("ps collector returned an unparseable row");
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: `${match[4]} ${match[5]} ${match[6]} ${match[7]} ${match[8]}`,
      command: match[9].trim(),
    });
  }
  return rows;
}

function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function pm2Identity(process, spec) {
  const env = process?.pm2_env;
  if (!env || typeof env !== "object") return null;
  const slot = Number(env.NODE_APP_INSTANCE);
  const pid = Number(process.pid);
  const pmId = Number(process.pm_id);
  const correct =
    process.name === spec.appName &&
    env.pm_cwd === genCwd &&
    env.pm_exec_path === genTsxEntrypoint &&
    JSON.stringify(normalizeArgs(env.args)) ===
      JSON.stringify([spec.entrypoint]) &&
    Number.isSafeInteger(slot) &&
    slot >= 0 &&
    Number.isSafeInteger(pmId) &&
    pmId >= 0;
  return {
    correct,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
    pmId: Number.isSafeInteger(pmId) && pmId >= 0 ? pmId : null,
    slot: Number.isSafeInteger(slot) && slot >= 0 ? slot : null,
    status: typeof env.status === "string" ? env.status : "unknown",
    runId:
      typeof env[spec.runIdEnv] === "string" &&
      env[spec.runIdEnv].trim()
        ? env[spec.runIdEnv].trim()
        : null,
  };
}

function isWorkerRuntime(row, spec) {
  const escaped = spec.entrypoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(row.command);
}

function isGenTsxWrapper(row) {
  return row.command.includes(genTsxEntrypoint);
}

function redisIdentity(worker, spec = workerSpecs.image) {
  const rawname = typeof worker?.rawname === "string" ? worker.rawname : "";
  const separator = rawname.lastIndexOf(":w:");
  if (separator < 0) return null;
  const identity = rawname.slice(separator + 3);
  const match = identity.match(spec.identityPattern);
  if (!match) return null;
  const slot = canonicalNonnegativeInteger(match[2]);
  const pid = canonicalNonnegativeInteger(match[3]);
  const db = canonicalNonnegativeInteger(String(worker?.db ?? ""));
  if (slot === null || pid === null || pid === 0 || db === null) return null;
  return {
    identity,
    runId: match[1],
    slot,
    pid,
    db,
  };
}

function canonicalNonnegativeInteger(value) {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function classifySingleOwnership(input, spec) {
  const issues = [];
  if (
    (input.mode === "quiescent" && input.expected !== 0) ||
    (input.mode === "ready" && input.expected === 0 && !input.allowZeroReady)
  ) {
    issues.push("invalid_phase_contract");
  }
  const pm2Rows = input.pm2Processes
    .filter((process) => process?.name === spec.appName)
    .map((process) => pm2Identity(process, spec));
  // A stopped definition may be exactly the stale PM2 registration that the
  // gated delete/recreate phase is responsible for repairing. Quiescence only
  // proves there is no live consumer; ready/steady still require exact PM2
  // identity, and any live mismatched row remains a blocker in every phase.
  if (
    pm2Rows.some(
      (row) =>
        !row?.correct &&
        (input.mode !== "quiescent" || row.status === "online" || row.pid > 0),
    )
  ) {
    issues.push("pm2_identity_mismatch");
  }
  const livePm2 = pm2Rows.filter(
    (row) => row?.correct && row.status === "online" && row.pid > 0,
  );
  if (new Set(livePm2.map((row) => row.slot)).size !== livePm2.length) {
    issues.push("pm2_duplicate_slot");
  }
  if (new Set(livePm2.map((row) => row.pmId)).size !== livePm2.length) {
    issues.push("pm2_duplicate_id");
  }

  const daemonRows = input.psRows.filter((row) =>
    /^PM2 v[^:]*: God Daemon \(/.test(row.command),
  );
  const daemonPid = daemonRows.length === 1 ? daemonRows[0].pid : null;
  const registeredRoots = new Map(livePm2.map((row) => [row.pid, row]));
  const runtimeChildren = input.psRows.filter((row) =>
    isWorkerRuntime(row, spec)
  );
  const assignedRuntimePids = new Set();
  const groups = [];

  for (const wrapper of input.psRows.filter(isGenTsxWrapper)) {
    const children = runtimeChildren.filter(
      (child) => child.ppid === wrapper.pid && child.pgid === wrapper.pgid,
    );
    const registered = registeredRoots.get(wrapper.pid);
    // INTENT: image and video share the same tsx executable. Attribute an
    // unregistered generic wrapper only when its command or runtime child
    // proves this spec's entrypoint; registered roots remain fail-closed even
    // while their runtime child is dormant.
    if (!registered && !isWorkerRuntime(wrapper, spec) && children.length === 0) {
      continue;
    }
    if (children.length !== 1) {
      groups.push({
        rootPid: wrapper.pid,
        runtimePid: null,
        pgid: wrapper.pgid,
        startedAt: wrapper.startedAt,
        classification: "ambiguous",
        slot: registered?.slot ?? null,
      });
      issues.push("ambiguous_worker_group");
      continue;
    }
    const child = children[0];
    assignedRuntimePids.add(child.pid);
    const classification = registered
      ? "registered"
      : daemonPid && wrapper.ppid === daemonPid
        ? "daemon_orphan"
        : "external_unmanaged";
    groups.push({
      rootPid: wrapper.pid,
      runtimePid: child.pid,
      pgid: wrapper.pgid,
      startedAt: wrapper.startedAt,
      classification,
      slot: registered?.slot ?? null,
    });
    if (classification !== "registered") {
      issues.push(classification);
    }
  }

  for (const child of runtimeChildren) {
    if (assignedRuntimePids.has(child.pid)) continue;
    groups.push({
      rootPid: child.ppid,
      runtimePid: child.pid,
      pgid: child.pgid,
      startedAt: child.startedAt,
      classification: "external_unmanaged",
      slot: null,
    });
    issues.push("external_unmanaged");
  }
  for (const row of livePm2) {
    if (!groups.some((group) => group.rootPid === row.pid)) {
      issues.push("registered_root_missing_runtime");
    }
  }

  const redis = input.redisWorkers.map((worker) => redisIdentity(worker, spec));
  if (redis.some((identity) => identity === null)) {
    issues.push("anonymous_or_invalid_redis_worker");
  }
  const namedRedis = redis.filter(Boolean);
  const targetRedisDb = input.targetRedisDb ?? 0;
  if (namedRedis.some((identity) => identity.db !== targetRedisDb)) {
    issues.push("redis_database_mismatch");
  }
  if (
    new Set(namedRedis.map((identity) => `${identity.slot}:${identity.pid}`))
      .size !== namedRedis.length
  ) {
    issues.push("duplicate_redis_identity");
  }

  const registeredGroups = groups.filter(
    (group) => group.classification === "registered",
  );
  const configuredPm2RunIds = livePm2
    .map((row) => row.runId)
    .filter((runId) => runId !== null);
  const distinctPm2RunIds = new Set(configuredPm2RunIds);
  if (
    distinctPm2RunIds.size > 1 ||
    (configuredPm2RunIds.length > 0 &&
      configuredPm2RunIds.length !== livePm2.length)
  ) {
    issues.push("pm2_run_id_mismatch");
  }
  const inferredRunId =
    distinctPm2RunIds.size === 1 &&
    configuredPm2RunIds.length === livePm2.length
      ? configuredPm2RunIds[0]
      : undefined;
  const authoritativeRunId = input.runId ?? inferredRunId;
  if (
    input.runId &&
    livePm2.some((row) => row.runId !== input.runId)
  ) {
    issues.push("pm2_run_id_mismatch");
  }
  const expected = input.expected;
  if (livePm2.length !== expected) issues.push("unexpected_pm2_count");
  if (groups.length !== expected) issues.push("unexpected_os_group_count");
  if (input.redisWorkers.length !== expected) {
    issues.push("unexpected_redis_worker_count");
  }

  if (expected > 0) {
    if (input.requireRunId && !authoritativeRunId) {
      issues.push("expected_run_id_missing");
    }
    for (const identity of namedRedis) {
      if (
        authoritativeRunId &&
        identity.runId !== authoritativeRunId
      ) {
        issues.push("redis_run_id_mismatch");
      }
      const group = registeredGroups.find(
        (candidate) =>
          candidate.slot === identity.slot &&
          candidate.runtimePid === identity.pid,
      );
      if (!group) issues.push("redis_worker_has_no_registered_runtime");
    }
    for (const group of registeredGroups) {
      if (
        !namedRedis.some(
          (identity) =>
            identity.slot === group.slot &&
            identity.pid === group.runtimePid &&
            (!authoritativeRunId ||
              identity.runId === authoritativeRunId),
        )
      ) {
        issues.push("registered_runtime_has_no_redis_worker");
      }
    }
  }

  return {
    ok: new Set(issues).size === 0,
    expected,
    pm2Live: livePm2.map(({ pid, pmId, slot, status }) => ({
      pid,
      pmId,
      slot,
      status,
    })),
    groups,
    redis: namedRedis,
    targetRedisDb,
    invalidRedisWorkers: redis.filter((identity) => identity === null).length,
    issues: [...new Set(issues)].sort(),
  };
}

function classifyOwnership(input) {
  const image = classifySingleOwnership(input, workerSpecs.image);
  if (input.expectedVideo === undefined) return image;
  const video = classifySingleOwnership(
    {
      ...input,
      expected: input.expectedVideo,
      runId: input.videoRunId,
      redisWorkers: input.videoRedisWorkers ?? [],
      // A validated video-disabled production launch has no registered PM2
      // app, OS runtime, or Redis worker. Ready means that exact stable zero.
      allowZeroReady: true,
    },
    workerSpecs.video,
  );
  const issues = [
    ...image.issues.map((issue) => `image:${issue}`),
    ...video.issues.map((issue) => `video:${issue}`),
  ].sort();
  return {
    ok: image.ok && video.ok,
    expected: { image: input.expected, video: input.expectedVideo },
    image,
    video,
    issues,
  };
}

function checkedSpawn(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} collector exited ${result.status ?? 1}`);
  }
  return result.stdout;
}

async function collectRedisWorkers(redisOptions, queueName) {
  const { Queue } = requireFromGen("bullmq");
  const { connection, prefix } = redisOptions;
  const queue = new Queue(queueName, { connection, prefix });
  queue.on("error", () => undefined);
  let timer;
  try {
    return await Promise.race([
      queue.getWorkers(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Redis worker collector timed out")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await queue.disconnect().catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
}

function ownershipRedisOptions(env) {
  const redisUrl = new URL(
    env.GEN_REDIS_URL ?? env.REDIS_URL ?? "redis://127.0.0.1:6379",
  );
  if (!new Set(["redis:", "rediss:"]).has(redisUrl.protocol)) {
    throw new Error("Generation worker ownership requires redis:// or rediss://");
  }
  const database = redisUrl.pathname.replace(/^\//, "");
  if (database && !/^\d+$/.test(database)) {
    throw new Error("Generation Redis database must be a non-negative integer");
  }
  const databaseNumber = database ? Number(database) : 0;
  if (!Number.isSafeInteger(databaseNumber)) {
    throw new Error("Generation Redis database is outside the safe integer range");
  }
  const port = Number(redisUrl.port || 6379);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Generation Redis port is invalid");
  }
  const connection = {
    host: redisUrl.hostname,
    port,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    ...(redisUrl.username
      ? { username: decodeURIComponent(redisUrl.username) }
      : {}),
    ...(redisUrl.password
      ? { password: decodeURIComponent(redisUrl.password) }
      : {}),
    db: databaseNumber,
    ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {}),
  };
  return {
    connection,
    database: databaseNumber,
    prefix: env.BULLMQ_PREFIX ?? `idream:${env.APP_ENV ?? "development"}`,
  };
}

function mergeGenEnvironment(baseEnv, fileEnv) {
  return { ...fileEnv, ...baseEnv };
}

function loadGenEnvironment(baseEnv) {
  let fileEnv = {};
  try {
    const { parse } = requireFromGen("dotenv");
    fileEnv = parse(readFileSync(path.join(genCwd, ".env")));
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }
  return mergeGenEnvironment(baseEnv, fileEnv);
}

async function collectOwnership(
  env,
  expected,
  expectedVideo,
  runId,
  videoRunId,
  requireRunId,
  mode,
) {
  const pm2Processes = parseJsonArraySuffix(
    checkedSpawn("pm2", ["jlist"], env),
  );
  const psRows = parsePsSnapshot(
    checkedSpawn("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], env),
  );
  const redisOptions = ownershipRedisOptions(env);
  const [redisWorkers, videoRedisWorkers] = await Promise.all([
    collectRedisWorkers(redisOptions, workerSpecs.image.queue),
    collectRedisWorkers(redisOptions, workerSpecs.video.queue),
  ]);
  return classifyOwnership({
    expected,
    expectedVideo,
    mode,
    pm2Processes,
    psRows,
    redisWorkers,
    videoRedisWorkers,
    targetRedisDb: redisOptions.database,
    requireRunId,
    runId,
    videoRunId,
  });
}

function parseCliArgs(args) {
  if (args.length % 2 !== 0) {
    throw new Error("ownership options must be --name value pairs");
  }
  const allowed = new Set([
    "--mode",
    "--expected",
    "--expected-video",
    "--attempts",
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index])) {
      throw new Error(`unsupported ownership option: ${args[index]}`);
    }
    if (values.has(args[index])) {
      throw new Error(`duplicate ownership option: ${args[index]}`);
    }
    values.set(args[index], args[index + 1]);
  }
  const mode = values.get("--mode") ?? "steady";
  if (!new Set(["quiescent", "ready", "steady"]).has(mode)) {
    throw new Error(`unsupported ownership mode: ${mode}`);
  }
  const expectedDefault = mode === "quiescent" ? 0 : 2;
  const expectedRaw = values.get("--expected") ?? String(expectedDefault);
  if (!/^\d+$/.test(expectedRaw)) {
    throw new Error("--expected must be a non-negative integer");
  }
  const expected = Number(expectedRaw);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new Error("--expected must be a non-negative integer");
  }
  if (mode === "quiescent" && expected !== 0) {
    throw new Error("quiescent ownership requires --expected 0");
  }
  if (mode === "ready" && expected === 0) {
    throw new Error("ready ownership requires a positive --expected count");
  }
  const expectedVideoDefault = mode === "quiescent" ? 0 : 1;
  const expectedVideoRaw =
    values.get("--expected-video") ?? String(expectedVideoDefault);
  if (!/^\d+$/.test(expectedVideoRaw)) {
    throw new Error("--expected-video must be a non-negative integer");
  }
  const expectedVideo = Number(expectedVideoRaw);
  if (!Number.isSafeInteger(expectedVideo) || expectedVideo < 0) {
    throw new Error("--expected-video must be a non-negative integer");
  }
  if (mode === "quiescent" && expectedVideo !== 0) {
    throw new Error("quiescent ownership requires --expected-video 0");
  }
  const attemptsRaw =
    values.get("--attempts") ?? (mode === "steady" ? "1" : "10");
  if (!/^\d+$/.test(attemptsRaw)) {
    throw new Error("--attempts must be between 1 and 60");
  }
  const attempts = Number(attemptsRaw);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new Error("--attempts must be between 1 and 60");
  }
  if (mode !== "steady" && attempts < 2) {
    throw new Error("ready and quiescent ownership require at least 2 attempts");
  }
  return { mode, expected, expectedVideo, attempts };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const runtimeEnv = loadGenEnvironment(process.env);
  let report;
  let consecutiveMatches = 0;
  let lastFingerprint = null;
  const requiredConsecutiveMatches = options.mode === "steady" ? 1 : 2;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      report = await collectOwnership(
        runtimeEnv,
        options.expected,
        options.expectedVideo,
        runtimeEnv.GEN_IMAGE_WORKER_RUN_ID,
        runtimeEnv.GEN_VIDEO_WORKER_RUN_ID,
        options.mode === "ready",
        options.mode,
      );
    } catch (error) {
      report = {
        ok: false,
        expected: { image: options.expected, video: options.expectedVideo },
        pm2Live: [],
        groups: [],
        redis: [],
        invalidRedisWorkers: 0,
        issues: [
          `collector_failed:${
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : error instanceof Error
                ? error.name
                : "unknown"
          }`,
        ],
      };
    }
    if (report.ok) {
      const fingerprint = JSON.stringify(report);
      consecutiveMatches =
        fingerprint === lastFingerprint ? consecutiveMatches + 1 : 1;
      lastFingerprint = fingerprint;
    } else {
      consecutiveMatches = 0;
      lastFingerprint = null;
    }
    if (consecutiveMatches >= requiredConsecutiveMatches) break;
    if (attempt === options.attempts) {
      if (report.ok) {
        report = {
          ...report,
          ok: false,
          issues: [
            ...new Set([...report.issues, "ownership_not_stable"]),
          ].sort(),
        };
      }
      break;
    }
    await delay(500);
  }
  process.stdout.write(
    `${JSON.stringify({ mode: options.mode, ...report }, null, 2)}\n`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  void main().catch(() => {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "invalid",
          ok: false,
          expected: null,
          pm2Live: [],
          groups: [],
          redis: [],
          invalidRedisWorkers: 0,
          issues: ["invalid_cli_arguments"],
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  classifyOwnership,
  collectOwnership,
  loadGenEnvironment,
  mergeGenEnvironment,
  ownershipRedisOptions,
  parseCliArgs,
  parseJsonArraySuffix,
  parsePsSnapshot,
  redisIdentity,
};
