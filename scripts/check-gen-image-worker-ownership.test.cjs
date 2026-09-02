const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const path = require("node:path");
const { createRuntimeTopology } = require("./runtime-topology.cjs");
const {
  classifyOwnership,
  mergeGenEnvironment,
  ownershipRedisOptions,
  parseCliArgs,
  parseJsonArraySuffix,
  parsePsSnapshot,
} = require("./check-gen-image-worker-ownership.cjs");

const repoRoot = path.resolve(__dirname, "..");
const bunPath = "/runtime/bun";
const runtimeTopologies = Object.freeze(
  Object.fromEntries(
    ["development", "production"].map((mode) => [
      mode,
      createRuntimeTopology({
        repoRoot,
        bunInterpreter: bunPath,
        mode,
        environment: {},
        videoProvider: "backend",
      }),
    ]),
  ),
);

function generationWorkerDefinition(kind, mode = "development") {
  const definition = runtimeTopologies[mode].generationWorkerDefinition(kind);
  assert.ok(definition, `missing ${mode} ${kind} worker definition`);
  return definition;
}

const genCwd = generationWorkerDefinition("image").cwd;
const legacyTsxEntrypoint = path.join(genCwd, "node_modules/tsx/dist/cli.mjs");
const pm2BunProcessContainer = require.resolve(
  "pm2/lib/ProcessContainerForkBun.js",
);

function pm2(
  pid,
  slot,
  status = "online",
  runId = "release1",
  mode = "development",
) {
  const definition = generationWorkerDefinition("image", mode);
  return {
    pid,
    pm_id: 20 + slot,
    name: definition.name,
    pm2_env: {
      status,
      pm_cwd: definition.cwd,
      pm_exec_path: definition.execPath,
      args: [],
      exec_interpreter: bunPath,
      IDREAM_PM2_MODE: mode,
      ...(runId ? { GEN_IMAGE_WORKER_RUN_ID: runId } : {}),
      NODE_APP_INSTANCE: slot,
    },
  };
}

function videoPm2(
  pid,
  slot = 0,
  status = "online",
  runId = "release1",
  mode = "development",
) {
  const definition = generationWorkerDefinition("video", mode);
  return {
    pid,
    pm_id: 40 + slot,
    name: definition.name,
    pm2_env: {
      status,
      pm_cwd: definition.cwd,
      pm_exec_path: definition.execPath,
      args: [],
      exec_interpreter: bunPath,
      IDREAM_PM2_MODE: mode,
      ...(runId ? { GEN_VIDEO_WORKER_RUN_ID: runId } : {}),
      NODE_APP_INSTANCE: slot,
    },
  };
}

function row(pid, ppid, pgid, command) {
  return { pid, ppid, pgid, startedAt: "Tue Aug 11 06:00:00 2026", command };
}

function imageRuntime(pid, daemonPid = 100, mode = "development") {
  const definition = generationWorkerDefinition("image", mode);
  return row(pid, daemonPid, pid, `${bunPath} ${definition.script}`);
}

function videoRuntime(pid, daemonPid = 100, mode = "development") {
  const definition = generationWorkerDefinition("video", mode);
  return row(pid, daemonPid, pid, `${bunPath} ${definition.script}`);
}

function pm2BunRuntime(pid, daemonPid = 100) {
  return row(pid, daemonPid, pid, `${bunPath} ${pm2BunProcessContainer}`);
}

function legacyWrapper(pid, daemonPid = 100) {
  return row(pid, daemonPid, pid, `node ${legacyTsxEntrypoint}`);
}

function legacyImageRuntime(pid, wrapperPid) {
  const definition = generationWorkerDefinition("image");
  return row(
    pid,
    wrapperPid,
    wrapperPid,
    `node --import tsx/loader.mjs ${definition.script}`,
  );
}

function legacyVideoRuntime(pid, wrapperPid) {
  const definition = generationWorkerDefinition("video");
  return row(
    pid,
    wrapperPid,
    wrapperPid,
    `node --import tsx/loader.mjs ${definition.script}`,
  );
}

function redis(runId, slot, pid, db = 0) {
  return {
    rawname: `idream:production:ai.image.generate:w:idream.gen-image.v1.${runId}.${slot}.${pid}`,
    db: String(db),
  };
}

function videoRedis(runId, slot, pid, db = 0) {
  return {
    rawname: `idream:production:ai.video.generate:w:idream.gen-video.v1.${runId}.${slot}.${pid}`,
    db: String(db),
  };
}

test("parses PM2 warning prefixes and ps process identity", () => {
  const imageScript = generationWorkerDefinition("image").script;
  assert.deepEqual(
    parseJsonArraySuffix(`warning\n${JSON.stringify([pm2(200, 0)])}`),
    [pm2(200, 0)],
  );
  const parsed = parsePsSnapshot(
    `200 100 200 Tue Aug 11 06:00:00 2026 ${bunPath} ${imageScript}\n`,
  );
  assert.equal(parsed[0].pid, 200);
  assert.equal(parsed[0].command, `${bunPath} ${imageScript}`);
  assert.throws(() => parsePsSnapshot("collector format drift"));
});

test("deletes the ownership check's duplicate process identity map", () => {
  const source = readFileSync(
    path.join(__dirname, "check-gen-image-worker-ownership.cjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:appName|sourceEntrypoint|builtEntrypoint)\b/,
  );
  assert.doesNotMatch(source, /["']gen-(?:image|video)["']/);
  assert.doesNotMatch(
    source,
    /["'](?:src|dist)\/(?:image|video)\.(?:ts|js)["']/,
  );
});

test("accepts exact PM2, OS and Redis ownership", () => {
  const report = classifyOwnership({
    expected: 2,
    runId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
      imageRuntime(300),
    ],
    redisWorkers: [redis("release1", 0, 200), redis("release1", 1, 300)],
  });

  assert.equal(report.ok, true);
  assert.equal(report.groups.length, 2);
});

test("accepts exact image and video PM2, OS and Redis ownership together", () => {
  const ready = classifyOwnership({
    mode: "ready",
    expected: 2,
    expectedVideo: 1,
    runId: "release1",
    videoRunId: "release1",
    pm2Processes: [
      pm2(200, 0),
      pm2(300, 1),
      videoPm2(400),
    ],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
      imageRuntime(300),
      videoRuntime(400),
    ],
    redisWorkers: [redis("release1", 0, 200), redis("release1", 1, 300)],
    videoRedisWorkers: [videoRedis("release1", 0, 400)],
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.image.groups.length, 2);
  assert.equal(ready.video.groups.length, 1);

  const quiescent = classifyOwnership({
    mode: "quiescent",
    expected: 0,
    expectedVideo: 0,
    pm2Processes: [videoPm2(0, 0, "stopped", null)],
    psRows: [row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)")],
    redisWorkers: [],
    videoRedisWorkers: [],
  });
  assert.equal(quiescent.ok, true);
  assert.equal(quiescent.video.groups.length, 0);
});

test("accepts production Generation identities from runtime topology", () => {
  const report = classifyOwnership({
    mode: "ready",
    expected: 1,
    expectedVideo: 1,
    runId: "release1",
    videoRunId: "release1",
    pm2Processes: [
      pm2(200, 0, "online", "release1", "production"),
      videoPm2(400, 0, "online", "release1", "production"),
    ],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200, 100, "production"),
      videoRuntime(400, 100, "production"),
    ],
    redisWorkers: [redis("release1", 0, 200)],
    videoRedisWorkers: [videoRedis("release1", 0, 400)],
  });

  assert.equal(report.ok, true);
  assert.equal(report.image.groups[0].runtimePid, 200);
  assert.equal(report.video.groups[0].runtimePid, 400);
});

test("accepts PM2 ProcessContainerForkBun as the registered Bun runtime", () => {
  const report = classifyOwnership({
    mode: "ready",
    expected: 2,
    expectedVideo: 1,
    runId: "release1",
    videoRunId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1), videoPm2(400)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      pm2BunRuntime(200),
      pm2BunRuntime(300),
      pm2BunRuntime(400),
    ],
    redisWorkers: [redis("release1", 0, 200), redis("release1", 1, 300)],
    videoRedisWorkers: [videoRedis("release1", 0, 400)],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.image.groups.map(({ rootPid, runtimePid, classification }) => ({
      rootPid,
      runtimePid,
      classification,
    })),
    [
      { rootPid: 200, runtimePid: 200, classification: "registered" },
      { rootPid: 300, runtimePid: 300, classification: "registered" },
    ],
  );
  assert.equal(report.video.groups[0].runtimePid, 400);
});

test("uses the Redis identity to recover an unregistered PM2 Bun worker", () => {
  const report = classifyOwnership({
    mode: "quiescent",
    expected: 0,
    pm2Processes: [],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      pm2BunRuntime(200),
    ],
    redisWorkers: [redis("stale-release", 0, 200)],
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.groups, [
    {
      rootPid: 200,
      runtimePid: 200,
      pgid: 200,
      startedAt: "Tue Aug 11 06:00:00 2026",
      classification: "daemon_orphan",
      slot: null,
    },
  ]);
  assert.ok(report.issues.includes("daemon_orphan"));
});

test("ready accepts a validated zero-video topology while image remains live", () => {
  const report = classifyOwnership({
    mode: "ready",
    expected: 1,
    expectedVideo: 0,
    runId: "release1",
    videoRunId: "release1",
    pm2Processes: [pm2(200, 0)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
    ],
    redisWorkers: [redis("release1", 0, 200)],
    videoRedisWorkers: [],
  });

  assert.equal(report.ok, true);
  assert.equal(report.video.pm2Live.length, 0);
  assert.equal(report.video.groups.length, 0);
  assert.equal(report.video.redis.length, 0);
});

test("video orphan, dormant runtime and Redis identity drift all fail closed", () => {
  const base = {
    mode: "ready",
    expected: 1,
    expectedVideo: 1,
    runId: "release1",
    videoRunId: "release1",
    pm2Processes: [pm2(200, 0), videoPm2(400)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
      videoRuntime(400),
    ],
    redisWorkers: [redis("release1", 0, 200)],
    videoRedisWorkers: [videoRedis("release1", 0, 400)],
  };

  const orphan = classifyOwnership({
    ...base,
    psRows: [
      ...base.psRows,
      videoRuntime(500),
    ],
  });
  assert.equal(orphan.ok, false);
  assert.ok(orphan.issues.includes("video:daemon_orphan"));

  const dormant = classifyOwnership({
    ...base,
    psRows: base.psRows.filter((process) => process.pid !== 400),
  });
  assert.equal(dormant.ok, false);
  assert.ok(dormant.issues.includes("video:registered_root_missing_runtime"));

  const wrongRedis = classifyOwnership({
    ...base,
    targetRedisDb: 4,
    redisWorkers: [redis("release1", 0, 200, 4)],
    videoRedisWorkers: [videoRedis("wrong-release", 0, 400, 0)],
  });
  assert.equal(wrongRedis.ok, false);
  assert.ok(wrongRedis.issues.includes("video:redis_database_mismatch"));
  assert.ok(wrongRedis.issues.includes("video:redis_run_id_mismatch"));
});

test("reports daemon orphan groups without counting wrapper and child twice", () => {
  const psRows = [
    row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
    imageRuntime(200),
    imageRuntime(300),
  ];
  for (let index = 0; index < 8; index += 1) {
    const root = 400 + index * 2;
    psRows.push(legacyWrapper(root), legacyImageRuntime(root + 1, root));
  }
  const redisWorkers = [redis("release1", 0, 200), redis("release1", 1, 300)];
  for (let index = 0; index < 8; index += 1) {
    redisWorkers.push({ rawname: "idream:development:ai.image.generate" });
  }
  const report = classifyOwnership({
    expected: 2,
    runId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows,
    redisWorkers,
  });

  assert.equal(report.ok, false);
  assert.equal(
    report.groups.filter(
      ({ classification }) => classification === "daemon_orphan",
    ).length,
    8,
  );
  assert.equal(report.groups.length, 10);
  assert.ok(report.issues.includes("daemon_orphan"));
  assert.ok(report.issues.includes("anonymous_or_invalid_redis_worker"));
});

test("fails closed on a registered Bun worker without an OS runtime", () => {
  const report = classifyOwnership({
    expected: 2,
    runId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
    ],
    redisWorkers: [redis("release1", 0, 200)],
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.includes("registered_root_missing_runtime"));
});

test("steady development ownership maps named workers without a release run id", () => {
  const report = classifyOwnership({
    expected: 2,
    runId: undefined,
    pm2Processes: [
      pm2(200, 0, "online", null),
      pm2(300, 1, "online", null),
    ],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
      imageRuntime(300),
    ],
    redisWorkers: [redis("dev-a", 0, 200), redis("dev-b", 1, 300)],
  });

  assert.equal(report.ok, true);
});

test("rejects workers from a different Redis logical database", () => {
  const base = {
    expected: 2,
    runId: "release1",
    targetRedisDb: 4,
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
      imageRuntime(300),
    ],
  };
  const wrong = classifyOwnership({
    ...base,
    redisWorkers: [redis("release1", 0, 200, 0), redis("release1", 1, 300, 0)],
  });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.issues.includes("redis_database_mismatch"));

  const exact = classifyOwnership({
    ...base,
    redisWorkers: [redis("release1", 0, 200, 4), redis("release1", 1, 300, 4)],
  });
  assert.equal(exact.ok, true);
});

test("classifier rejects a contradictory ownership phase even without the CLI", () => {
  const report = classifyOwnership({
    mode: "quiescent",
    expected: 2,
    runId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(200),
      imageRuntime(300),
    ],
    redisWorkers: [redis("release1", 0, 200), redis("release1", 1, 300)],
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.includes("invalid_phase_contract"));
});

test("quiescent requires zero identity in every source", () => {
  const clean = classifyOwnership({
    expected: 0,
    runId: undefined,
    pm2Processes: [pm2(0, 0, "stopped"), pm2(0, 1, "stopped")],
    psRows: [row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)")],
    redisWorkers: [],
  });
  assert.equal(clean.ok, true);

  const dirty = classifyOwnership({
    expected: 0,
    runId: undefined,
    pm2Processes: [pm2(0, 0, "stopped")],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      imageRuntime(400),
    ],
    redisWorkers: [
      { rawname: "idream:development:ai.image.generate", db: "0" },
    ],
  });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.issues.includes("daemon_orphan"));
  assert.ok(dirty.issues.includes("unexpected_redis_worker_count"));
});

test("quiescent permits stopped stale definitions so gated recreation can repair them", () => {
  const staleImage = pm2(0, 0, "stopped", null);
  staleImage.pm2_env.pm_cwd = path.join(repoRoot, "stale-gen");
  const staleVideo = videoPm2(0, 0, "stopped", null);
  staleVideo.pm2_env.args = ["src/legacy-video.ts"];

  const report = classifyOwnership({
    mode: "quiescent",
    expected: 0,
    expectedVideo: 0,
    pm2Processes: [staleImage, staleVideo],
    psRows: [row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)")],
    redisWorkers: [],
    videoRedisWorkers: [],
  });

  assert.equal(report.ok, true);
});

test("CLI options and Redis authority fail closed on malformed input", () => {
  assert.deepEqual(parseCliArgs([]), {
    mode: "steady",
    expected: 1,
    expectedVideo: 1,
    attempts: 1,
  });
  assert.deepEqual(parseCliArgs(["--mode", "ready", "--expected", "2"]), {
    mode: "ready",
    expected: 2,
    expectedVideo: 1,
    attempts: 10,
  });
  assert.throws(() => parseCliArgs(["--expected", "2workers"]));
  assert.throws(() => parseCliArgs(["--expected"]));
  assert.throws(() => parseCliArgs(["--unknown", "2"]));
  assert.throws(() =>
    parseCliArgs(["--mode", "quiescent", "--expected", "2"]),
  );
  assert.throws(() =>
    parseCliArgs(["--mode", "ready", "--expected", "0"]),
  );
  assert.throws(() =>
    parseCliArgs(["--mode", "ready", "--attempts", "1"]),
  );
  assert.deepEqual(
    parseCliArgs([
      "--mode",
      "ready",
      "--expected",
      "2",
      "--expected-video",
      "0",
    ]),
    { mode: "ready", expected: 2, expectedVideo: 0, attempts: 10 },
  );
  assert.throws(() =>
    ownershipRedisOptions({ REDIS_URL: "redis://127.0.0.1:6379/not-a-db" }),
  );
  assert.throws(() =>
    ownershipRedisOptions({ REDIS_URL: "http://127.0.0.1:6379/0" }),
  );
  const options = ownershipRedisOptions({
    APP_ENV: "production",
    BULLMQ_PREFIX: "idream:production",
    REDIS_URL: "rediss://user:secret@example.test:6380/12",
  });
  assert.deepEqual(
    options,
    {
      connection: {
        host: "example.test",
        port: 6380,
        connectTimeout: 2_000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: options.connection.retryStrategy,
        username: "user",
        password: "secret",
        db: 12,
        tls: {},
      },
      database: 12,
      prefix: "idream:production",
    },
  );
  assert.equal(options.connection.retryStrategy(), null);
  assert.deepEqual(
    mergeGenEnvironment(
      { BULLMQ_PREFIX: "from-shell", REDIS_URL: "redis://shell/4" },
      { BULLMQ_PREFIX: "from-file", GEN_REDIS_URL: "redis://file/2" },
    ),
    {
      BULLMQ_PREFIX: "from-shell",
      GEN_REDIS_URL: "redis://file/2",
      REDIS_URL: "redis://shell/4",
    },
  );
});
