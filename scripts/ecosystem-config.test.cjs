const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "ecosystem.config.js");
const rootPackage = require("../package.json");
const mainPackage = require("../packages/main/package.json");
const {
  loadGenEnvironment,
} = require("./check-gen-image-worker-ownership.cjs");
const {
  productionAdmissionTargets,
  productionDrainWorkerTargets,
  productionQuiescenceTargets,
  productionRuntimeTargets,
  productionProcessDefinition,
  productionDefinitionPlan,
  productionVideoWorkerCount,
  matchesProductionProcessDefinition,
  resolveCurrentPm2Mode,
  runPm2Ecosystem,
  verifyProductionRuntime,
} = require("./start-pm2-ecosystem.cjs");

function loadConfig(mode, overrides = {}) {
  const originalMode = process.env.IDREAM_PM2_MODE;
  const originalVideoProvider = process.env.GEN_VIDEO_PROVIDER;
  try {
    if (mode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = mode;
    }
    const videoProvider = Object.hasOwn(overrides, "GEN_VIDEO_PROVIDER")
      ? overrides.GEN_VIDEO_PROVIDER
      : mode === "production"
        ? "backend"
        : originalVideoProvider;
    if (videoProvider === undefined) {
      delete process.env.GEN_VIDEO_PROVIDER;
    } else {
      process.env.GEN_VIDEO_PROVIDER = videoProvider;
    }
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  } finally {
    if (originalMode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = originalMode;
    }
    if (originalVideoProvider === undefined) {
      delete process.env.GEN_VIDEO_PROVIDER;
    } else {
      process.env.GEN_VIDEO_PROVIDER = originalVideoProvider;
    }
    delete require.cache[require.resolve(configPath)];
  }
}

function byName(config, name) {
  const app = config.apps.find((candidate) => candidate.name === name);
  assert.ok(app, `missing PM2 app ${name}`);
  return app;
}

function scriptedSpawn(results, calls) {
  let index = 0;
  return (command, args, options) => {
    calls.push({ command, args, options });
    const result = results[index];
    index += 1;
    assert.ok(result, `unexpected spawn call: ${command} ${args.join(" ")}`);
    return result;
  };
}

function pm2Process(name, status) {
  const definition = productionProcessDefinition(name);
  assert.ok(definition, `missing production definition ${name}`);
  return {
    name,
    pm2_env: {
      status,
      pm_cwd: definition.cwd,
      pm_exec_path: definition.execPath,
      args: definition.args,
      exec_mode: definition.execMode,
      watch: false,
      IDREAM_PM2_MODE: "production",
    },
  };
}

function pm2ProcessFromApp(app, status, mode) {
  return {
    name: app.name,
    pm2_env: {
      status,
      pm_cwd: app.cwd,
      pm_exec_path: path.resolve(app.cwd, app.script),
      args: typeof app.args === "string" ? [app.args] : (app.args ?? []),
      exec_mode: `${app.exec_mode}_mode`,
      watch: app.watch,
      IDREAM_PM2_MODE: mode,
    },
  };
}

function productionEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    APP_ENV: "production",
    BULLMQ_PREFIX: "idream:production",
    REDIS_URL: "redis://production-redis:6379/4",
    GEN_VIDEO_PROVIDER: "backend",
    ...overrides,
  };
}

function noisyPm2List(processes) {
  return [
    ">>>> In-memory PM2 is out-of-date, do:",
    ">>>> $ pm2 update",
    "In memory PM2 version: 6.0.14",
    "Local PM2 version: 5.4.3",
    "",
    JSON.stringify(processes),
  ].join("\n");
}

function commandList(calls) {
  return calls.map(({ command, args }) => [command, args]);
}

function onlineProductionProcesses() {
  return productionRuntimeTargets.flatMap((name) =>
    Array.from({ length: name === "gen-image" ? 2 : 1 }, () =>
      pm2Process(name, "online"),
    ),
  );
}

test("development is the source-backed default", () => {
  const config = loadConfig(undefined);
  assert.equal(config.apps.length, 9);
  for (const app of config.apps) {
    assert.equal(app.env.IDREAM_PM2_MODE, "development");
  }
  const mainWeb = byName(config, "main-web");
  const adminWeb = byName(config, "admin-web");
  const chat = byName(config, "chat");
  const genImage = byName(config, "gen-image");
  const genFinalizer = byName(config, "gen-finalizer");

  assert.equal(mainWeb.cwd, path.join(repoRoot, "packages/main"));
  assert.equal(mainWeb.script, "scripts/start-development.cjs");
  assert.equal(mainWeb.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(mainWeb.env.IDREAM_NEXT_DIST_DIR, ".next-development");
  assert.equal(adminWeb.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(adminWeb.env.IDREAM_NEXT_DIST_DIR, ".next-development");
  assert.equal(mainWeb.args, undefined);
  assert.equal(mainWeb.exec_mode, "fork");
  assert.equal(mainWeb.instances, 1);
  assert.equal(mainWeb.watch, false);

  assert.equal(adminWeb.cwd, path.join(repoRoot, "packages/admin"));
  assert.equal(adminWeb.script, "node_modules/next/dist/bin/next");
  assert.equal(adminWeb.args, "dev");
  assert.equal(adminWeb.exec_mode, "fork");
  assert.equal(adminWeb.watch, false);

  assert.deepEqual(chat.watch, [
    path.join(repoRoot, "packages/chat/src"),
    path.join(repoRoot, "packages/shared/src"),
  ]);
  assert.equal(chat.watch_delay, 500);
  assert.equal(genImage.instances, 2);
  assert.deepEqual(genFinalizer.watch, [
    path.join(repoRoot, "packages/main/src/processes"),
    path.join(repoRoot, "packages/main/src/server"),
    path.join(repoRoot, "packages/shared/src"),
  ]);
});

test("development omits the video process when the effective Gen provider is mock", () => {
  const mockConfig = loadConfig("development", {
    GEN_VIDEO_PROVIDER: "mock",
  });
  const backendConfig = loadConfig("development", {
    GEN_VIDEO_PROVIDER: "backend",
  });
  const pipelineConfig = loadConfig("development", {
    GEN_VIDEO_PROVIDER: "pipeline",
  });

  assert.equal(
    mockConfig.apps.some((app) => app.name === "gen-video"),
    false,
  );
  assert.equal(
    backendConfig.apps.some((app) => app.name === "gen-video"),
    true,
  );
  assert.equal(
    pipelineConfig.apps.some((app) => app.name === "gen-video"),
    true,
  );

  const fileBackedConfig = loadConfig("development", {
    GEN_VIDEO_PROVIDER: undefined,
  });
  const fileBackedProvider =
    loadGenEnvironment({}).GEN_VIDEO_PROVIDER ?? "mock";
  assert.equal(
    fileBackedConfig.apps.some((app) => app.name === "gen-video"),
    fileBackedProvider !== "mock",
  );
});

test("main development and typecheck regenerate Prisma Client before loading application code", () => {
  assert.equal(mainPackage.scripts.dev, "node scripts/start-development.cjs");
  assert.match(mainPackage.scripts.typecheck, /^npm run db:generate && /);
});

test("production keeps immutable standalone web releases and disables watch", () => {
  const config = loadConfig("production");
  const mainWeb = byName(config, "main-web");
  const adminWeb = byName(config, "admin-web");

  for (const web of [mainWeb, adminWeb]) {
    assert.equal(web.cwd, repoRoot);
    assert.equal(web.script, "scripts/start-next-standalone.cjs");
    assert.equal(web.exec_mode, "cluster");
    assert.equal(web.watch, false);
  }
  for (const app of config.apps) {
    assert.equal(app.watch, false);
    assert.equal(app.env.IDREAM_PM2_MODE, "production");
  }
});

test("production omits the video process when the validated launch contract disables video", () => {
  const config = loadConfig("production", { GEN_VIDEO_PROVIDER: "mock" });

  assert.equal(config.apps.some((app) => app.name === "gen-video"), false);
  assert.equal(productionVideoWorkerCount({ GEN_VIDEO_PROVIDER: "mock" }), 0);
  assert.equal(productionVideoWorkerCount({ GEN_VIDEO_PROVIDER: "backend" }), 1);
});

test("production definition authority stays exact for every ecosystem app", () => {
  const config = loadConfig("production");
  for (const app of config.apps) {
    const definition = productionProcessDefinition(app.name);
    assert.ok(definition, `missing definition for ${app.name}`);
    assert.deepEqual(definition, {
      cwd: app.cwd,
      execPath: path.resolve(app.cwd, app.script),
      args: typeof app.args === "string" ? [app.args] : (app.args ?? []),
      execMode: `${app.exec_mode}_mode`,
    });
  }
});

test("every production definition field fails closed on drift", () => {
  const exact = pm2Process("main-web", "online");
  assert.equal(matchesProductionProcessDefinition(exact), true);
  const mutations = [
    { pm_cwd: `${exact.pm2_env.pm_cwd}-stale` },
    { pm_exec_path: `${exact.pm2_env.pm_exec_path}-stale` },
    { args: ["packages/admin"] },
    { exec_mode: "fork_mode" },
    { watch: true },
    { IDREAM_PM2_MODE: "development" },
  ];
  for (const mutation of mutations) {
    assert.equal(
      matchesProductionProcessDefinition({
        ...exact,
        pm2_env: { ...exact.pm2_env, ...mutation },
      }),
      false,
    );
  }
});

test("production stop phases classify every non-voice app exactly once", () => {
  const config = loadConfig("production");
  const expected = config.apps
    .map((app) => app.name)
    .filter((name) => name !== "fish-audio")
    .sort();
  const classified = [...productionQuiescenceTargets].sort();

  assert.deepEqual(classified, expected);
  assert.equal(new Set(classified).size, classified.length);
  assert.equal(
    productionAdmissionTargets.includes("admin-command-worker"),
    true,
  );
  assert.equal(productionDrainWorkerTargets.at(-1), "gen-finalizer");
});

test("generation workers have bounded graceful-stop windows", () => {
  const config = loadConfig("production");
  assert.equal(byName(config, "gen-image").kill_timeout, 5 * 60 * 1_000);
  assert.equal(byName(config, "gen-video").kill_timeout, 35 * 60 * 1_000);
  assert.equal(byName(config, "gen-finalizer").kill_timeout, 5 * 60 * 1_000);
});

test("production readiness requires every process instance and service probe", () => {
  const calls = [];
  const status = verifyProductionRuntime({
    runtimeEnv: productionEnv(),
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: noisyPm2List(onlineProductionProcesses()) },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: noisyPm2List(onlineProductionProcesses()) },
      ],
      calls,
    ),
  });

  assert.equal(status, 0);
  assert.deepEqual(
    commandList(calls).map(([command, args]) => [command, args.at(-1)]),
    [
      ["pm2", "jlist"],
      ["curl", "http://127.0.0.1:3000/"],
      ["curl", "http://127.0.0.1:3001/"],
      ["curl", "http://127.0.0.1:3100/readyz"],
      ["curl", "http://127.0.0.1:8062/health"],
      ["bun", "preflight"],
      ["pm2", "jlist"],
    ],
  );
});

test("production readiness rejects an online process with a development definition", () => {
  const processes = onlineProductionProcesses();
  const mainIndex = processes.findIndex((process) => process.name === "main-web");
  processes[mainIndex] = pm2ProcessFromApp(
    byName(loadConfig("development"), "main-web"),
    "online",
    "development",
  );
  const calls = [];
  const status = verifyProductionRuntime({
    runtimeEnv: productionEnv(),
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn(
      [{ status: 0, stdout: noisyPm2List(processes) }],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("production refuses a non-production product environment before mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: { PATH: process.env.PATH, APP_ENV: "development" },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "[]" };
    },
    verifyProductionRuntime: () => 0,
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, []);
});

test("production requires one explicit Redis and BullMQ authority before mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv({ REDIS_URL: undefined, BULLMQ_PREFIX: undefined }),
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "[]" };
    },
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, []);
});

test("a failed launch gate prevents queue and PM2 mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv({ LAUNCH_SCOPE: "core" }),
    spawnSync: scriptedSpawn([{ status: 47 }], calls),
  });

  assert.equal(status, 47);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
  ]);
  assert.equal(calls[0].options.env.LAUNCH_SCOPE, "core");
});

test("PM2 mode discovery fails closed when warning output has no JSON array", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["current", "restart"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        {
          status: 0,
          stdout:
            ">>>> In-memory PM2 is out-of-date\nLocal PM2 version: 5.4.3\n",
        },
      ],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("an errored production worker keeps Generation queues paused", () => {
  const calls = [];
  const processes = onlineProductionProcesses().map((process) =>
    process.name === "gen-video" ? pm2Process("gen-video", "errored") : process,
  );
  const status = verifyProductionRuntime({
    runtimeEnv: productionEnv(),
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn(
      [{ status: 0, stdout: JSON.stringify(processes) }],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("a missing production process keeps Generation queues paused", () => {
  const calls = [];
  const processes = onlineProductionProcesses().filter(
    (process) => process.name !== "gen-finalizer",
  );
  const status = verifyProductionRuntime({
    runtimeEnv: productionEnv(),
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn(
      [{ status: 0, stdout: JSON.stringify(processes) }],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("a process that crashes during service probes keeps queues paused", () => {
  const calls = [];
  const crashed = onlineProductionProcesses().map((process) =>
    process.name === "gen-video" ? pm2Process("gen-video", "errored") : process,
  );
  const status = verifyProductionRuntime({
    runtimeEnv: productionEnv(),
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: JSON.stringify(onlineProductionProcesses()) },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(crashed) },
      ],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls).at(-1), ["pm2", ["jlist"]]);
});

test("invalid runtime modes fail fast", () => {
  assert.throws(
    () => loadConfig("preview"),
    /Invalid IDREAM_PM2_MODE "preview"/,
  );
});

test("runtime mode resolution is explicit and fail-closed", () => {
  assert.equal(
    resolveCurrentPm2Mode([
      {
        name: "main-web",
        pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
      },
      {
        name: "admin-web",
        pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
      },
    ]),
    "production",
  );
  assert.equal(
    resolveCurrentPm2Mode([
      {
        name: "main-web",
        pm2_env: {
          status: "online",
          pm_exec_path: path.join(
            repoRoot,
            "packages/main/node_modules/next/dist/bin/next",
          ),
          args: ["dev"],
        },
      },
    ]),
    "development",
  );
  assert.equal(
    resolveCurrentPm2Mode([
      {
        name: "main-web",
        pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
      },
      {
        name: "admin-web",
        pm2_env: { status: "online", IDREAM_PM2_MODE: "development" },
      },
    ]),
    null,
  );
});

test("a generic restart of production enters the launch gate before PM2 mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["current", "restart"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        {
          status: 0,
          stdout: JSON.stringify([
            {
              name: "main-web",
              pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
            },
          ]),
        },
        { status: 31 },
      ],
      calls,
    ),
  });

  assert.equal(status, 31);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:launch:direct"]],
  ]);
  assert.equal(calls[1].options.env.IDREAM_PM2_MODE, "production");
});

test("explicit quiesce pauses and stops owned production processes without launch, start or resume", () => {
  const calls = [];
  const running = [
    pm2Process("main-web", "online"),
    pm2Process("gen-image", "online"),
    pm2Process("gen-finalizer", "online"),
    pm2Process("fish-audio", "online"),
  ];
  const admissionStopped = running.map((process) =>
    process.name === "main-web" ? pm2Process("main-web", "stopped") : process,
  );
  const allStopped = admissionStopped.map((process) =>
    new Set(["gen-image", "gen-finalizer"]).has(process.name)
      ? pm2Process(process.name, "stopped")
      : process,
  );
  const status = runPm2Ecosystem({
    args: ["current", "quiesce"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: JSON.stringify(running) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(running) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(admissionStopped) },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(allStopped) },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: () => {
      throw new Error("quiesce must leave orphan inspection to the recovery plan");
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "gen-image"]],
    ["pm2", ["stop", "gen-finalizer"]],
    ["pm2", ["jlist"]],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("check:launch:direct") ||
      args.includes("ecosystem.config.js") ||
      args.includes("generation-cutover:resume"),
    ),
    false,
  );
});

test("pm2 stop uses the same drain and ownership fence before stopping voice", () => {
  const calls = [];
  const ownershipModes = [];
  const running = [
    pm2Process("main-web", "online"),
    pm2Process("gen-image", "online"),
    pm2Process("gen-finalizer", "online"),
    pm2Process("fish-audio", "online"),
  ];
  const admissionStopped = running.map((process) =>
    process.name === "main-web" ? pm2Process("main-web", "stopped") : process,
  );
  const workersStopped = admissionStopped.map((process) =>
    new Set(["gen-image", "gen-finalizer"]).has(process.name)
      ? pm2Process(process.name, "stopped")
      : process,
  );
  const allStopped = workersStopped.map((process) =>
    process.name === "fish-audio" ? pm2Process("fish-audio", "stopped") : process,
  );
  const status = runPm2Ecosystem({
    args: ["current", "stop"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: JSON.stringify(running) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(running) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(admissionStopped) },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(workersStopped) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(allStopped) },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: ({ mode }) => {
      ownershipModes.push(mode);
      return 0;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(ownershipModes, ["quiescent"]);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "gen-image"]],
    ["pm2", ["stop", "gen-finalizer"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "fish-audio"]],
    ["pm2", ["jlist"]],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("check:launch:direct") ||
      args.includes("check:generation-cutover") ||
      args.includes("ecosystem.config.js") ||
      args.includes("generation-cutover:resume"),
    ),
    false,
  );
});

test("a generic development restart preserves the detected source topology", () => {
  const calls = [];
  const ownershipChecks = [];
  const developmentProcess = (name, status) => ({
    name,
    pm2_env: { status, IDREAM_PM2_MODE: "development" },
  });
  const runningProcesses = [
    developmentProcess("main-web", "online"),
    developmentProcess("gen-image", "online"),
    developmentProcess("gen-image", "online"),
    developmentProcess("gen-video", "online"),
    developmentProcess("gen-finalizer", "online"),
  ];
  const admissionStopped = runningProcesses.map((process) =>
    process.name === "main-web"
      ? developmentProcess("main-web", "stopped")
      : process,
  );
  const allStopped = admissionStopped.map((process) =>
    process.name === "main-web"
      ? process
      : developmentProcess(process.name, "stopped"),
  );
  const status = runPm2Ecosystem({
    args: ["current", "restart"],
    env: { PATH: process.env.PATH, GEN_VIDEO_PROVIDER: "backend" },
    spawnSync: scriptedSpawn(
      [
        {
          status: 0,
          stdout: JSON.stringify([
            {
              name: "main-web",
              pm2_env: { status: "online", IDREAM_PM2_MODE: "development" },
            },
          ]),
        },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(runningProcesses) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(admissionStopped) },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify(allStopped) },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: (input) => {
      ownershipChecks.push({
        expected: input.expected,
        expectedVideo: input.expectedVideo,
        mode: input.mode,
        runId: input.runtimeEnv.GEN_IMAGE_WORKER_RUN_ID,
        videoRunId: input.runtimeEnv.GEN_VIDEO_WORKER_RUN_ID,
      });
      return 0;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "gen-image"]],
    ["pm2", ["stop", "gen-video"]],
    ["pm2", ["stop", "gen-finalizer"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["restart", "ecosystem.config.js", "--update-env"]],
    ["bun", ["run", "generation-cutover:resume"]],
  ]);
  assert.equal(calls[11].options.env.IDREAM_PM2_MODE, "development");
  assert.deepEqual(
    ownershipChecks.map(({ expected, expectedVideo, mode }) => ({
      expected,
      expectedVideo,
      mode,
    })),
    [
      { expected: 0, expectedVideo: 0, mode: "quiescent" },
      { expected: 2, expectedVideo: 1, mode: "ready" },
    ],
  );
  assert.match(ownershipChecks[0].runId, /^pm2-[a-f0-9-]+$/);
  assert.equal(ownershipChecks[1].runId, ownershipChecks[0].runId);
  assert.equal(ownershipChecks[0].videoRunId, ownershipChecks[0].runId);
  assert.equal(ownershipChecks[1].videoRunId, ownershipChecks[0].runId);
});

test("pm2:start fails closed before definition handling when quiescence still has an orphan", () => {
  const calls = [];
  const ownershipModes = [];
  const status = runPm2Ecosystem({
    args: [],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: ({ mode }) => {
      ownershipModes.push(mode);
      return 71;
    },
  });

  assert.equal(status, 71);
  assert.deepEqual(ownershipModes, ["quiescent"]);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
  ]);
});

test("development mock video topology requires zero video consumers", () => {
  const calls = [];
  const ownershipExpectations = [];
  const status = runPm2Ecosystem({
    args: [],
    env: {
      PATH: process.env.PATH,
      GEN_VIDEO_PROVIDER: "mock",
    },
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: ({ expectedVideo, mode }) => {
      ownershipExpectations.push({ expectedVideo, mode });
      return 0;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(ownershipExpectations, [
    { expectedVideo: 0, mode: "quiescent" },
    { expectedVideo: 0, mode: "ready" },
  ]);
  assert.deepEqual(commandList(calls).at(-1), [
    "bun",
    ["run", "generation-cutover:resume"],
  ]);
});

for (const scenario of [
  {
    name: "pm2:start",
    args: [],
    initialProcesses: [],
    action: ["start", "ecosystem.config.js"],
  },
  {
    name: "pm2:restart",
    args: ["current", "restart"],
    initialProcesses: [
      {
        name: "main-web",
        pm2_env: { status: "online", IDREAM_PM2_MODE: "development" },
      },
    ],
    action: ["restart", "ecosystem.config.js", "--update-env"],
  },
  {
    name: "pm2:reload",
    args: ["current", "reload"],
    initialProcesses: [
      {
        name: "main-web",
        pm2_env: { status: "online", IDREAM_PM2_MODE: "development" },
      },
    ],
    action: ["reload", "ecosystem.config.js", "--update-env"],
  },
]) {
  test(`${scenario.name} cannot report success or resume after a ready ownership failure`, () => {
    const calls = [];
    const ownershipModes = [];
    const status = runPm2Ecosystem({
      args: scenario.args,
      env: { PATH: process.env.PATH, GEN_VIDEO_PROVIDER: "backend" },
      spawnSync: scriptedSpawn(
        [
          { status: 0, stdout: JSON.stringify(scenario.initialProcesses) },
          { status: 0 },
          { status: 0, stdout: "[]" },
          { status: 0, stdout: "[]" },
          { status: 0, stdout: "[]" },
          { status: 0 },
          { status: 0 },
          { status: 0 },
        ],
        calls,
      ),
      verifyGenImageWorkerOwnership: ({ mode }) => {
        ownershipModes.push(mode);
        return mode === "quiescent" ? 0 : 73;
      },
    });

    assert.equal(status, 73);
    assert.deepEqual(ownershipModes, ["quiescent", "ready"]);
    assert.deepEqual(commandList(calls), [
      ["pm2", ["jlist"]],
      ["bun", ["run", "generation-cutover:pause-and-drain"]],
      ["pm2", ["jlist"]],
      ["pm2", ["jlist"]],
      ["pm2", ["jlist"]],
      ["bun", ["run", "check:generation-cutover"]],
      ["pm2", ["delete", "pocket-tts"]],
      ["pm2", scenario.action],
    ]);
  });
}

test("development start refuses to replace a running production topology", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: [],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn(
      [
        {
          status: 0,
          stdout: JSON.stringify([
            {
              name: "main-web",
              pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
            },
          ]),
        },
      ],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("production pauses and drains before phased stop, gate, restart, and resume", () => {
  const calls = [];
  const ownershipChecks = [];
  const status = runPm2Ecosystem({
    args: ["production", "restart"],
    env: {
      ...productionEnv(),
      MAIN_REDIS_URL: "redis://production-main:6379/4",
    },
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        {
          status: 0,
          stdout: JSON.stringify([
            pm2Process("main-web", "online"),
            pm2Process("admin-command-worker", "online"),
            pm2Process("gen-image", "online"),
            pm2Process("gen-image", "online"),
            pm2Process("gen-finalizer", "online"),
            pm2Process("fish-audio", "online"),
          ]),
        },
        { status: 0 },
        { status: 0 },
        {
          status: 0,
          stdout: JSON.stringify([
            pm2Process("main-web", "stopped"),
            pm2Process("admin-command-worker", "stopped"),
            pm2Process("gen-image", "online"),
            pm2Process("gen-image", "online"),
            pm2Process("gen-finalizer", "online"),
            pm2Process("fish-audio", "online"),
          ]),
        },
        { status: 0 },
        { status: 0 },
        {
          status: 0,
          stdout: JSON.stringify([
            pm2Process("main-web", "stopped"),
            pm2Process("admin-command-worker", "stopped"),
            pm2Process("gen-image", "stopped"),
            pm2Process("gen-image", "stopped"),
            pm2Process("gen-finalizer", "stopped"),
            pm2Process("fish-audio", "online"),
          ]),
        },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 0,
    verifyGenImageWorkerOwnership: (input) => {
      ownershipChecks.push({
        expected: input.expected,
        expectedVideo: input.expectedVideo,
        mode: input.mode,
        runId: input.runtimeEnv.GEN_IMAGE_WORKER_RUN_ID,
        videoRunId: input.runtimeEnv.GEN_VIDEO_WORKER_RUN_ID,
      });
      return 0;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["stop", "admin-command-worker"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "gen-image"]],
    ["pm2", ["stop", "gen-finalizer"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
    ["pm2", ["delete", "fish-audio"]],
    ["pm2", ["delete", "main-web"]],
    ["pm2", ["delete", "admin-command-worker"]],
    ["pm2", ["delete", "gen-image"]],
    ["pm2", ["delete", "gen-finalizer"]],
    ["pm2", ["jlist"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["start", "ecosystem.config.js"]],
    ["bun", ["run", "generation-cutover:resume"]],
  ]);
  assert.equal(calls[0].options.cwd, repoRoot);
  assert.deepEqual(
    ownershipChecks.map(({ expected, expectedVideo, mode }) => ({
      expected,
      expectedVideo,
      mode,
    })),
    [
      { expected: 0, expectedVideo: 0, mode: "quiescent" },
      { expected: 2, expectedVideo: 1, mode: "ready" },
    ],
  );
  assert.match(ownershipChecks[0].runId, /^pm2-[a-f0-9-]+$/);
  assert.equal(ownershipChecks[1].runId, ownershipChecks[0].runId);
  assert.equal(ownershipChecks[0].videoRunId, ownershipChecks[0].runId);
  assert.equal(ownershipChecks[1].videoRunId, ownershipChecks[0].runId);
  for (const index of [1, 9, 18]) {
    assert.equal(
      calls[index].options.cwd,
      path.join(repoRoot, "packages/main"),
    );
    assert.equal(calls[index].options.env.IDREAM_PM2_MODE, "production");
    assert.equal(
      calls[index].options.env.REDIS_URL,
      "redis://production-main:6379/4",
    );
    assert.equal(
      calls[index].options.env.GEN_REDIS_URL,
      "redis://production-main:6379/4",
    );
    assert.equal(calls[index].options.env.BULLMQ_PREFIX, "idream:production");
  }
});

test("development definitions are deleted and recreated before production resumes", () => {
  const calls = [];
  const developmentMain = byName(loadConfig("development"), "main-web");
  const online = pm2ProcessFromApp(
    developmentMain,
    "online",
    "development",
  );
  const stopped = pm2ProcessFromApp(
    developmentMain,
    "stopped",
    "development",
  );
  const status = runPm2Ecosystem({
    args: ["production", "restart"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([online]) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([stopped]) },
        { status: 0, stdout: JSON.stringify([stopped]) },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 0,
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
    ["pm2", ["delete", "main-web"]],
    ["pm2", ["jlist"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["start", "ecosystem.config.js"]],
    ["bun", ["run", "generation-cutover:resume"]],
  ]);
});

test("an exact production definition is recreated to drop stale optional env", () => {
  const exactChat = pm2Process("chat", "stopped");
  exactChat.pm2_env.CHAT_MODEL_API_KEY = "stale-provider-key";

  assert.deepEqual(productionDefinitionPlan([exactChat]), {
    deleteNames: ["chat"],
    requiresStart: true,
  });
});

test("a failed owned-app delete never starts or resumes the topology", () => {
  const calls = [];
  const online = pm2Process("main-web", "online");
  const stopped = pm2Process("main-web", "stopped");
  const status = runPm2Ecosystem({
    args: ["production", "restart"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([online]) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([stopped]) },
        { status: 0, stdout: JSON.stringify([stopped]) },
        { status: 0 },
        { status: 23 },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 23);
  assert.deepEqual(commandList(calls).at(-1), ["pm2", ["delete", "main-web"]]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("ecosystem.config.js") ||
      args.includes("generation-cutover:resume")
    ),
    false,
  );
});

test("a drifted definition that survives delete keeps queues paused", () => {
  const calls = [];
  const developmentMain = byName(loadConfig("development"), "main-web");
  const online = pm2ProcessFromApp(
    developmentMain,
    "online",
    "development",
  );
  const stopped = pm2ProcessFromApp(
    developmentMain,
    "stopped",
    "development",
  );
  const status = runPm2Ecosystem({
    args: ["production", "restart"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([online]) },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([stopped]) },
        { status: 0, stdout: JSON.stringify([stopped]) },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([stopped]) },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls).at(-1), ["pm2", ["jlist"]]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("ecosystem.config.js") ||
      args.includes("generation-cutover:resume")
    ),
    false,
  );
});

test("an owned app appearing after the quiesced snapshot blocks fresh creation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: JSON.stringify([pm2Process("chat", "stopped")]) },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls).at(-1), ["pm2", ["jlist"]]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("ecosystem.config.js") ||
      args.includes("generation-cutover:resume")
    ),
    false,
  );
});

test("a failed pause/drain prevents every PM2 mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn([{ status: 0 }, { status: 31 }], calls),
  });

  assert.equal(status, 31);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
  ]);
});

test("a failed admission stop prevents worker stop, gate, and restart", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production", "reload"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        {
          status: 0,
          stdout: JSON.stringify([pm2Process("main-event-consumer", "online")]),
        },
        { status: 17 },
      ],
      calls,
    ),
  });

  assert.equal(status, 17);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-event-consumer"]],
  ]);
});

test("a failed admission verification prevents worker stop and gate", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        {
          status: 0,
          stdout: JSON.stringify([pm2Process("main-web", "online")]),
        },
        { status: 0 },
        {
          status: 0,
          stdout: JSON.stringify([pm2Process("main-web", "online")]),
        },
      ],
      calls,
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["jlist"]],
  ]);
});

test("a failed drain-worker stop prevents the gate and restart", () => {
  const calls = [];
  const onlineWorker = JSON.stringify([pm2Process("gen-video", "online")]);
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: onlineWorker },
        { status: 0, stdout: onlineWorker },
        { status: 19 },
      ],
      calls,
    ),
  });

  assert.equal(status, 19);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "gen-video"]],
  ]);
});

test("a failed authority gate leaves processes stopped and queues paused", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 23 },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 23);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
  ]);
});

test("an orphan after PM2 stop blocks authority gate, start, and resume", () => {
  const calls = [];
  const ownershipModes = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: ({ mode }) => {
      ownershipModes.push(mode);
      return 53;
    },
  });

  assert.equal(status, 53);
  assert.deepEqual(ownershipModes, ["quiescent"]);
  assert.equal(
    commandList(calls).some(
      ([, args]) =>
        args.includes("check:generation-cutover") ||
        args.includes("generation-cutover:resume") ||
        args.includes("ecosystem.config.js"),
    ),
    false,
  );
});

test("a failed PM2 start never resumes generation queues", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 29 },
      ],
      calls,
    ),
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 29);
  assert.deepEqual(commandList(calls).at(-1), [
    "pm2",
    ["start", "ecosystem.config.js"],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("generation-cutover:resume"),
    ),
    false,
  );
});

test("a PM2 command accepted before runtime readiness never resumes queues", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 47,
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 47);
  assert.deepEqual(commandList(calls).at(-1), [
    "pm2",
    ["start", "ecosystem.config.js"],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("generation-cutover:resume"),
    ),
    false,
  );
});

test("a post-start ownership mismatch blocks queue resume", () => {
  const calls = [];
  const ownershipModes = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 0,
    verifyGenImageWorkerOwnership: ({ mode }) => {
      ownershipModes.push(mode);
      return mode === "quiescent" ? 0 : 61;
    },
  });

  assert.equal(status, 61);
  assert.deepEqual(ownershipModes, ["quiescent", "ready"]);
  assert.deepEqual(commandList(calls).at(-1), [
    "pm2",
    ["start", "ecosystem.config.js"],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("generation-cutover:resume"),
    ),
    false,
  );
});

test("a resume failure is returned after its rollback-to-pause command", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
        { status: 41 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 0,
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 41);
  assert.deepEqual(commandList(calls).at(-1), [
    "bun",
    ["run", "generation-cutover:resume"],
  ]);
});

test("a first production deploy with no existing PM2 apps still closes the full gate", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv(),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 0,
    verifyGenImageWorkerOwnership: () => 0,
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "check:launch:direct"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
    ["pm2", ["jlist"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["start", "ecosystem.config.js"]],
    ["bun", ["run", "generation-cutover:resume"]],
  ]);
});

test("a video-disabled production deploy requires zero video consumers", () => {
  const calls = [];
  const ownershipExpectations = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: productionEnv({ GEN_VIDEO_PROVIDER: "mock" }),
    spawnSync: scriptedSpawn(
      [
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0, stdout: "[]" },
        { status: 0 },
        { status: 0 },
        { status: 0 },
      ],
      calls,
    ),
    verifyProductionRuntime: () => 0,
    verifyGenImageWorkerOwnership: ({ expectedVideo, mode }) => {
      ownershipExpectations.push({ expectedVideo, mode });
      return 0;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(ownershipExpectations, [
    { expectedVideo: 0, mode: "quiescent" },
    { expectedVideo: 0, mode: "ready" },
  ]);
});

test("every production PM2 package script uses the gated wrapper", () => {
  assert.deepEqual(
    {
      start: rootPackage.scripts["pm2:start:production"],
      restart: rootPackage.scripts["pm2:restart:production"],
      reload: rootPackage.scripts["pm2:reload:production"],
    },
    {
      start: "node scripts/start-pm2-ecosystem.cjs production",
      restart: "node scripts/start-pm2-ecosystem.cjs production restart",
      reload: "node scripts/start-pm2-ecosystem.cjs production reload",
    },
  );
});

test("generic start, stop, restart and reload all use the gated wrapper", () => {
  assert.deepEqual(
    {
      start: rootPackage.scripts["pm2:start"],
      stop: rootPackage.scripts["pm2:stop"],
      restart: rootPackage.scripts["pm2:restart"],
      reload: rootPackage.scripts["pm2:reload"],
    },
    {
      start: "node scripts/start-pm2-ecosystem.cjs",
      stop: "node scripts/start-pm2-ecosystem.cjs current stop",
      restart: "node scripts/start-pm2-ecosystem.cjs current restart",
      reload: "node scripts/start-pm2-ecosystem.cjs current reload",
    },
  );
});

test("orphan recovery package scripts preserve explicit quiesce, plan and apply phases", () => {
  assert.deepEqual(
    {
      quiesce:
        rootPackage.scripts["generation:quiesce-for-orphan-recovery"],
      plan: rootPackage.scripts["generation:plan-orphan-recovery"],
      apply: rootPackage.scripts["generation:apply-orphan-recovery"],
    },
    {
      quiesce: "node scripts/start-pm2-ecosystem.cjs current quiesce",
      plan: "node scripts/recover-gen-worker-orphans.cjs plan",
      apply: "node scripts/recover-gen-worker-orphans.cjs apply",
    },
  );
});
