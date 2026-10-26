const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const path = require("node:path");
const { createRuntimeTopology } = require("./runtime-topology.cjs");
const {
  assertPm2SocketPaths,
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

function separatePm2Container(t) {
  const root = mkdtempSync(path.join(tmpdir(), "idream-pm2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const container = path.join(
    root,
    "node_modules/pm2/lib/ProcessContainerForkBun.js",
  );
  mkdirSync(path.dirname(container), { recursive: true });
  copyFileSync(pm2BunProcessContainer, container);
  return container;
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

// Run the production collector in a fresh module graph, substituting only its
// OS/Redis I/O. This keeps env forwarding and snapshot parsing in the regression.
function collectFixtureOwnership(input) {
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const Module = require("node:module");
    const input = JSON.parse(readFileSync(0, "utf8"));
    const originalLoad = Module._load;
    Module._load = function (name, ...args) {
      if (name === "node:child_process") return {
        spawnSync(command, commandArgs, options) {
          assert.equal(input.rejectBeforeIO, undefined, "Invalid socket paths must not invoke PM2 or ps");
          assert.equal(options.env.PM2_HOME, input.env.PM2_HOME);
          if (command === "pm2") {
            assert.deepEqual(commandArgs, ["jlist"]);
            return { status: 0, stdout: JSON.stringify(input.pm2Processes) };
          }
          assert.equal(command, "ps");
          assert.deepEqual(commandArgs, ["-axo", "pid=,ppid=,pgid=,lstart=,command="]);
          return { status: 0, stdout: input.psRows.map((row) =>
            [row.pid, row.ppid, row.pgid, row.startedAt, row.command].join(" ")
          ).join("\\n") };
        },
      };
      if (name === "bullmq") return {
        Queue: class {
          constructor(name, options) {
            this.name = name;
            assert.equal(options.connection.db, 14);
            assert.equal(options.prefix, input.env.BULLMQ_PREFIX);
          }
          on() {}
          async getWorkers() {
            return this.name === "ai.image.generate"
              ? input.redisWorkers : input.videoRedisWorkers;
          }
          async disconnect() {}
          async close() {}
        },
      };
      return originalLoad.call(this, name, ...args);
    };
    const { collectOwnership } = require(input.modulePath);
    collectOwnership(input.env, 1, 1, "release1", "release1", true, "ready")
      .then((report) => process.stdout.write(JSON.stringify(report)))
      .catch((error) => {
        if (input.rejectBeforeIO && error.code === "PM2_SOCKET_PATH_TOO_LONG") {
          process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
        } else { console.error(error); process.exitCode = 1; }
      });
  `], {
    input: JSON.stringify({
      modulePath: path.join(__dirname, "check-gen-image-worker-ownership.cjs"),
      ...input,
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function isolatedCollectorFixture() {
  return {
    env: {
      PM2_HOME: "/tmp/idream audit/.pm2",
      HOME: "/tmp/other home",
      GEN_REDIS_URL: "redis://127.0.0.1:6379/14",
      BULLMQ_PREFIX: "idream:audit:isolated",
    },
    pm2Processes: [pm2(200, 0), videoPm2(400)],
    psRows: [
      row(900, 1, 900, "PM2 v6.0.14: God Daemon (/tmp/shared runtime/.pm2)"),
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/idream audit/.pm2)"),
      pm2BunRuntime(200),
      pm2BunRuntime(400),
      pm2BunRuntime(901, 900),
    ],
    redisWorkers: [redis("release1", 0, 200, 14)],
    videoRedisWorkers: [videoRedis("release1", 0, 400, 14)],
  };
}

test("collector rejects oversized PM2 sockets before any PM2 or queue collection", () => {
  const input = isolatedCollectorFixture();
  input.env.PM2_HOME = `/tmp/${"long-home-".repeat(20)}`;
  input.rejectBeforeIO = true;
  const report = collectFixtureOwnership(input);
  assert.equal(report.code, "PM2_SOCKET_PATH_TOO_LONG");
  assert.match(report.message, /PM2_DAEMON_RPC_PORT.*bytes.*PM2_HOME/su);
});

test("collector permits explicit valid sockets under a long PM2_HOME", () => {
  const input = isolatedCollectorFixture();
  const pm2Home = `/tmp/${"long-home-".repeat(20)}`;
  Object.assign(input.env, {
    PM2_HOME: pm2Home,
    PM2_DAEMON_RPC_PORT: "/tmp/idream-rpc.sock",
    PM2_DAEMON_PUB_PORT: "/tmp/idream-pub.sock",
    PM2_INTERACTOR_RPC_PORT: "/tmp/idream-interactor.sock",
  });
  input.psRows = input.psRows.map((process) => process.pid === 100
    ? { ...process, command: `PM2 v6.0.14: God Daemon (${pm2Home})` } : process);
  assert.equal(collectFixtureOwnership(input).ok, true);
});

test("PM2 socket validation counts UTF-8 bytes and checks every effective path", () => {
  const env = {
    PM2_HOME: "/tmp/.pm2",
    PM2_DAEMON_RPC_PORT: `/tmp/${"a".repeat(99)}`,
  };
  assert.doesNotThrow(() => assertPm2SocketPaths(env, "darwin"));
  assert.throws(() => assertPm2SocketPaths({ ...env, PM2_DAEMON_RPC_PORT: `${env.PM2_DAEMON_RPC_PORT}a` }, "darwin"), /105 bytes.*104/su);
  for (const key of ["PM2_DAEMON_RPC_PORT", "PM2_DAEMON_PUB_PORT", "PM2_INTERACTOR_RPC_PORT"]) {
    assert.throws(() => assertPm2SocketPaths({ ...env, [key]: `/tmp/${"长".repeat(34)}` }, "darwin"), new RegExp(`${key}.*107 bytes`, "su"));
  }
});

test("collector accepts its exact PM2_HOME among daemons with spaces and equal basenames", () => {
  const input = isolatedCollectorFixture();
  const singleDaemon = collectFixtureOwnership({
    ...input,
    psRows: input.psRows.filter((process) => process.pid !== 900),
  });
  assert.equal(singleDaemon.ok, true, JSON.stringify(singleDaemon.issues));
  const report = collectFixtureOwnership(input);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.deepEqual(report.image.groups.map((group) => group.rootPid), [200]);
  assert.deepEqual(report.video.groups.map((group) => group.rootPid), [400]);
});

test("collector rejects a registered worker parented by another PM2_HOME", () => {
  const input = isolatedCollectorFixture();
  input.psRows = input.psRows.map((process) =>
    process.pid === 200 ? { ...process, ppid: 900 } : process
  );
  const report = collectFixtureOwnership(input);
  assert.equal(report.ok, false);
  assert.ok(report.image.issues.includes("registered_runtime_process_identity_mismatch"));
});

test("collector derives the default home and rejects ambiguous matching daemons", () => {
  const input = isolatedCollectorFixture();
  delete input.env.PM2_HOME;
  input.env.HOME = "/tmp/idream audit";
  assert.equal(collectFixtureOwnership(input).ok, true);

  input.psRows.push(row(800, 1, 800, "PM2 v6.0.14: God Daemon (/tmp/idream audit/.pm2)"));
  const ambiguous = collectFixtureOwnership(input);
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.image.issues.includes("registered_runtime_process_identity_mismatch"));
});

test("collector retains orphan and foreign-consumer rejection with multiple PM2 daemons", () => {
  const orphan = isolatedCollectorFixture();
  orphan.psRows.push(pm2BunRuntime(500));
  orphan.redisWorkers.push(redis("release1", 1, 500, 14));
  const orphanReport = collectFixtureOwnership(orphan);
  assert.equal(orphanReport.ok, false);
  assert.ok(orphanReport.image.issues.includes("daemon_orphan"));

  const foreign = isolatedCollectorFixture();
  foreign.redisWorkers.push(redis("release1", 1, 901, 14));
  const foreignReport = collectFixtureOwnership(foreign);
  assert.equal(foreignReport.ok, false);
  assert.ok(foreignReport.image.issues.includes("external_unmanaged"));
});

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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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

test("accepts matching PM2 Bun containers from a separate global installation", (t) => {
  const container = separatePm2Container(t);
  const report = classifyOwnership({
    pm2Home: "/tmp/.pm2",
    mode: "ready",
    expected: 1,
    expectedVideo: 1,
    runId: "release1",
    videoRunId: "release1",
    pm2Processes: [pm2(200, 0), videoPm2(400)],
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      row(200, 100, 200, `${bunPath} ${container}`),
      row(400, 100, 400, `${bunPath} ${container}`),
    ],
    redisWorkers: [redis("release1", 0, 200)],
    videoRedisWorkers: [videoRedis("release1", 0, 400)],
  });

  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.image.groups[0].runtimePid, 200);
  assert.equal(report.video.groups[0].runtimePid, 400);
});

test("rejects an arbitrary same-name PM2 Bun container and extra arguments", (t) => {
  const container = separatePm2Container(t);
  const base = {
    mode: "ready",
    expected: 1,
    runId: "release1",
    pm2Processes: [pm2(200, 0)],
    redisWorkers: [redis("release1", 0, 200)],
  };
  const reportFor = (command) => classifyOwnership({
    pm2Home: "/tmp/.pm2",
    ...base,
    psRows: [
      row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
      row(200, 100, 200, command),
    ],
  });

  assert.equal(reportFor(`${bunPath} ${container} --untrusted`).ok, false);
  writeFileSync(container, "process.exit(0);\n");
  const fake = reportFor(`${bunPath} ${container}`);
  assert.equal(fake.ok, false);
  assert.ok(fake.issues.includes("registered_root_missing_runtime"));
});

test("registered PM2 Bun containers require daemon parent and their own process group", () => {
  const base = {
    mode: "ready",
    expected: 1,
    runId: "release1",
    pm2Processes: [pm2(200, 0)],
    redisWorkers: [redis("release1", 0, 200)],
  };
  for (const [ppid, pgid] of [[999, 200], [100, 999]]) {
    const report = classifyOwnership({
    pm2Home: "/tmp/.pm2",
      ...base,
      psRows: [
        row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)"),
        row(200, ppid, pgid, `${bunPath} ${pm2BunProcessContainer}`),
      ],
    });
    assert.equal(report.ok, false, `ppid=${ppid}, pgid=${pgid}`);
  }
});

test("uses the Redis identity to recover an unregistered PM2 Bun worker", () => {
  const report = classifyOwnership({
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
    ...base,
    psRows: [
      ...base.psRows,
      videoRuntime(500),
    ],
  });
  assert.equal(orphan.ok, false);
  assert.ok(orphan.issues.includes("video:daemon_orphan"));

  const dormant = classifyOwnership({
    pm2Home: "/tmp/.pm2",
    ...base,
    psRows: base.psRows.filter((process) => process.pid !== 400),
  });
  assert.equal(dormant.ok, false);
  assert.ok(dormant.issues.includes("video:registered_root_missing_runtime"));

  const wrongRedis = classifyOwnership({
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
    ...base,
    redisWorkers: [redis("release1", 0, 200, 0), redis("release1", 1, 300, 0)],
  });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.issues.includes("redis_database_mismatch"));

  const exact = classifyOwnership({
    pm2Home: "/tmp/.pm2",
    ...base,
    redisWorkers: [redis("release1", 0, 200, 4), redis("release1", 1, 300, 4)],
  });
  assert.equal(exact.ok, true);
});

test("classifier rejects a contradictory ownership phase even without the CLI", () => {
  const report = classifyOwnership({
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
    expected: 0,
    runId: undefined,
    pm2Processes: [pm2(0, 0, "stopped"), pm2(0, 1, "stopped")],
    psRows: [row(100, 1, 100, "PM2 v6.0.14: God Daemon (/tmp/.pm2)")],
    redisWorkers: [],
  });
  assert.equal(clean.ok, true);

  const dirty = classifyOwnership({
    pm2Home: "/tmp/.pm2",
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
    pm2Home: "/tmp/.pm2",
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
