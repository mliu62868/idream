const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const {
  classifyOwnership,
  mergeGenEnvironment,
  ownershipRedisOptions,
  parseCliArgs,
  parseJsonArraySuffix,
  parsePsSnapshot,
} = require("./check-gen-image-worker-ownership.cjs");

const repoRoot = path.resolve(__dirname, "..");
const genCwd = path.join(repoRoot, "packages/gen");
const execPath = path.join(genCwd, "node_modules/tsx/dist/cli.mjs");

function pm2(pid, slot, status = "online", runId = "release1") {
  return {
    pid,
    pm_id: 20 + slot,
    name: "gen-image",
    pm2_env: {
      status,
      pm_cwd: genCwd,
      pm_exec_path: execPath,
      args: ["src/image.ts"],
      ...(runId ? { GEN_IMAGE_WORKER_RUN_ID: runId } : {}),
      NODE_APP_INSTANCE: slot,
    },
  };
}

function videoPm2(pid, slot = 0, status = "online", runId = "release1") {
  return {
    pid,
    pm_id: 40 + slot,
    name: "gen-video",
    pm2_env: {
      status,
      pm_cwd: genCwd,
      pm_exec_path: execPath,
      args: ["src/video.ts"],
      ...(runId ? { GEN_VIDEO_WORKER_RUN_ID: runId } : {}),
      NODE_APP_INSTANCE: slot,
    },
  };
}

function row(pid, ppid, pgid, command) {
  return { pid, ppid, pgid, startedAt: "Tue Aug 11 06:00:00 2026", command };
}

function wrapper(pid, daemonPid = 100) {
  return row(pid, daemonPid, pid, `node ${execPath}`);
}

function runtime(pid, wrapperPid) {
  return row(
    pid,
    wrapperPid,
    wrapperPid,
    `node --import tsx/loader.mjs src/image.ts`,
  );
}

function videoRuntime(pid, wrapperPid) {
  return row(
    pid,
    wrapperPid,
    wrapperPid,
    `node --import tsx/loader.mjs src/video.ts`,
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
  assert.deepEqual(
    parseJsonArraySuffix(`warning\n${JSON.stringify([pm2(200, 0)])}`),
    [pm2(200, 0)],
  );
  const parsed = parsePsSnapshot(
    `200 100 200 Tue Aug 11 06:00:00 2026 node ${execPath}\n`,
  );
  assert.equal(parsed[0].pid, 200);
  assert.equal(parsed[0].command, `node ${execPath}`);
  assert.throws(() => parsePsSnapshot("collector format drift"));
});

test("accepts exact PM2, OS and Redis ownership", () => {
  const report = classifyOwnership({
    expected: 2,
    runId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      wrapper(200),
      runtime(201, 200),
      wrapper(300),
      runtime(301, 300),
    ],
    redisWorkers: [redis("release1", 0, 201), redis("release1", 1, 301)],
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
      wrapper(200),
      runtime(201, 200),
      wrapper(300),
      runtime(301, 300),
      wrapper(400),
      videoRuntime(401, 400),
    ],
    redisWorkers: [redis("release1", 0, 201), redis("release1", 1, 301)],
    videoRedisWorkers: [videoRedis("release1", 0, 401)],
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
      wrapper(200),
      runtime(201, 200),
    ],
    redisWorkers: [redis("release1", 0, 201)],
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
      wrapper(200),
      runtime(201, 200),
      wrapper(400),
      videoRuntime(401, 400),
    ],
    redisWorkers: [redis("release1", 0, 201)],
    videoRedisWorkers: [videoRedis("release1", 0, 401)],
  };

  const orphan = classifyOwnership({
    ...base,
    psRows: [
      ...base.psRows,
      wrapper(500),
      videoRuntime(501, 500),
    ],
  });
  assert.equal(orphan.ok, false);
  assert.ok(orphan.issues.includes("video:daemon_orphan"));

  const dormant = classifyOwnership({
    ...base,
    psRows: base.psRows.filter((process) => process.pid !== 401),
  });
  assert.equal(dormant.ok, false);
  assert.ok(dormant.issues.includes("video:ambiguous_worker_group"));

  const wrongRedis = classifyOwnership({
    ...base,
    targetRedisDb: 4,
    redisWorkers: [redis("release1", 0, 201, 4)],
    videoRedisWorkers: [videoRedis("wrong-release", 0, 401, 0)],
  });
  assert.equal(wrongRedis.ok, false);
  assert.ok(wrongRedis.issues.includes("video:redis_database_mismatch"));
  assert.ok(wrongRedis.issues.includes("video:redis_run_id_mismatch"));
});

test("reports daemon orphan groups without counting wrapper and child twice", () => {
  const psRows = [
    row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
    wrapper(200),
    runtime(201, 200),
    wrapper(300),
    runtime(301, 300),
  ];
  for (let index = 0; index < 8; index += 1) {
    const root = 400 + index * 2;
    psRows.push(wrapper(root), runtime(root + 1, root));
  }
  const redisWorkers = [redis("release1", 0, 201), redis("release1", 1, 301)];
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

test("fails closed on a dormant registered image wrapper without a runtime child", () => {
  const report = classifyOwnership({
    expected: 2,
    runId: "release1",
    pm2Processes: [pm2(200, 0), pm2(300, 1)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      wrapper(200),
      runtime(201, 200),
      wrapper(300),
    ],
    redisWorkers: [redis("release1", 0, 201)],
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.includes("ambiguous_worker_group"));
  assert.equal(
    report.groups.find(({ rootPid }) => rootPid === 300)?.classification,
    "ambiguous",
  );
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
      wrapper(200),
      runtime(201, 200),
      wrapper(300),
      runtime(301, 300),
    ],
    redisWorkers: [redis("dev-a", 0, 201), redis("dev-b", 1, 301)],
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
      wrapper(200),
      runtime(201, 200),
      wrapper(300),
      runtime(301, 300),
    ],
  };
  const wrong = classifyOwnership({
    ...base,
    redisWorkers: [redis("release1", 0, 201, 0), redis("release1", 1, 301, 0)],
  });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.issues.includes("redis_database_mismatch"));

  const exact = classifyOwnership({
    ...base,
    redisWorkers: [redis("release1", 0, 201, 4), redis("release1", 1, 301, 4)],
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
      wrapper(200),
      runtime(201, 200),
      wrapper(300),
      runtime(301, 300),
    ],
    redisWorkers: [redis("release1", 0, 201), redis("release1", 1, 301)],
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
      wrapper(400),
      runtime(401, 400),
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
