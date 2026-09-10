const assert = require("node:assert/strict");
const fs = require("node:fs");
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
  developmentProcessDefinition,
  developmentDefinitionPlan,
  productionProcessDefinition,
  productionDefinitionPlan,
  productionVideoWorkerCount,
  matchesProductionProcessDefinition,
  matchesDevelopmentProcessDefinition,
  resolveCurrentPm2Mode,
  runPm2Ecosystem,
  verifyProductionRuntime,
} = require("./start-pm2-ecosystem.cjs");

function loadConfig(mode, overrides = {}) {
  const originalMode = process.env.IDREAM_PM2_MODE;
  const originalVideoProvider = process.env.GEN_VIDEO_PROVIDER;
  const originalVoiceProvider = process.env.VOICE_PROVIDER;
  const originalVoiceIdentityProvider = process.env.VOICE_IDENTITY_PROVIDER;
  try {
    if (mode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = mode;
    }
    const videoProvider = Object.hasOwn(overrides, "GEN_VIDEO_PROVIDER")
      ? overrides.GEN_VIDEO_PROVIDER
      : "backend";
    if (videoProvider === undefined) {
      delete process.env.GEN_VIDEO_PROVIDER;
    } else {
      process.env.GEN_VIDEO_PROVIDER = videoProvider;
    }
    process.env.VOICE_PROVIDER = overrides.VOICE_PROVIDER ?? "pocket-tts";
    // An absent variable intentionally falls back to the operator's .env in
    // production. Fixture defaults must shadow it; individual cases opt in.
    process.env.VOICE_IDENTITY_PROVIDER = overrides.VOICE_IDENTITY_PROVIDER ?? "";
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
    if (originalVoiceProvider === undefined) {
      delete process.env.VOICE_PROVIDER;
    } else {
      process.env.VOICE_PROVIDER = originalVoiceProvider;
    }
    if (originalVoiceIdentityProvider === undefined) {
      delete process.env.VOICE_IDENTITY_PROVIDER;
    } else {
      process.env.VOICE_IDENTITY_PROVIDER = originalVoiceIdentityProvider;
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
      node_args: definition.nodeArgs ?? [],
      exec_interpreter: definition.execInterpreter,
      exec_mode: definition.execMode,
      watch: false,
      IDREAM_PM2_MODE: "production",
      IDREAM_RUNTIME_CERTIFICATION: "revision-bound-immutable",
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
      node_args: app.node_args ?? [],
      exec_interpreter: app.interpreter,
      exec_mode: `${app.exec_mode}_mode`,
      watch: app.watch,
      IDREAM_PM2_MODE: mode,
      IDREAM_RUNTIME_CERTIFICATION: app.env.IDREAM_RUNTIME_CERTIFICATION,
      ...(app.env.IDREAM_SOURCE_REVISION
        ? { IDREAM_SOURCE_REVISION: app.env.IDREAM_SOURCE_REVISION }
        : {}),
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
    VOICE_PROVIDER: "pocket-tts",
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
  return ["pocket-tts", ...productionQuiescenceTargets].flatMap((name) =>
    Array.from({ length: 1 }, () =>
      pm2Process(name, "online"),
    ),
  );
}

test("development is the source-backed default", () => {
  const config = loadConfig();
  assert.equal(config.apps.length, 9);
  for (const app of config.apps) {
    assert.equal(app.env.IDREAM_PM2_MODE, "development");
    assert.equal(
      app.env.IDREAM_RUNTIME_CERTIFICATION,
      "non-certifying-source-watch",
    );
  }
  const mainWeb = byName(config, "main-web");
  const adminWeb = byName(config, "admin-web");
  const chat = byName(config, "chat");
  const genImage = byName(config, "gen-image");
  const genFinalizer = byName(config, "gen-finalizer");

  assert.equal(mainWeb.cwd, path.join(repoRoot, "packages/main"));
  assert.equal(mainWeb.script, "scripts/start-development.cjs");
  assert.equal(path.basename(mainWeb.interpreter), "bun");
  assert.equal(mainWeb.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(mainWeb.env.IDREAM_NEXT_DIST_DIR, ".next-development");
  assert.equal(mainWeb.env.IDREAM_PM2_BUN_ENTRYPOINT, "main-development");
  assert.equal(adminWeb.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(adminWeb.env.IDREAM_NEXT_DIST_DIR, ".next-development");
  assert.equal(adminWeb.env.IDREAM_PM2_BUN_ENTRYPOINT, "admin-development");
  assert.equal(mainWeb.args, undefined);
  assert.equal(mainWeb.exec_mode, "fork");
  assert.equal(mainWeb.instances, 1);
  assert.equal(mainWeb.watch, false);

  assert.equal(adminWeb.cwd, path.join(repoRoot, "packages/admin"));
  assert.equal(adminWeb.script, "scripts/start-development.cjs");
  assert.equal(adminWeb.args, undefined);
  assert.equal(path.basename(adminWeb.interpreter), "bun");
  assert.equal(adminWeb.exec_mode, "fork");
  assert.equal(adminWeb.watch, false);

  assert.deepEqual(chat.watch, [
    path.join(repoRoot, "packages/chat/src"),
    path.join(repoRoot, "packages/shared/src"),
  ]);
  assert.equal(chat.watch_delay, 500);
  assert.equal(genImage.instances, 1);
  assert.equal(
    genImage.env.COMFYUI_IMAGE_API_URL,
    "http://127.0.0.1:8189",
  );
  assert.equal(
    byName(loadConfig("development", { GEN_VIDEO_PROVIDER: "backend" }), "gen-video")
      .env.COMFYUI_VIDEO_API_URL,
    "http://127.0.0.1:8188",
  );
  assert.equal(
    byName(loadConfig("development", { GEN_VIDEO_PROVIDER: "backend" }), "gen-video")
      .env.COMFYUI_H3_API_URL,
    "http://127.0.0.1:8190",
  );
  assert.deepEqual(genFinalizer.watch, [
    path.join(repoRoot, "packages/main/src/processes"),
    path.join(repoRoot, "packages/main/src/server"),
    path.join(repoRoot, "packages/shared/src"),
  ]);
});

test("every first-party JavaScript and TypeScript service is executed by Bun", () => {
  for (const mode of ["development", "production"]) {
    const config = loadConfig(mode);
    for (const app of config.apps) {
      assert.equal(path.basename(app.interpreter), "bun", `${mode}:${app.name}`);
    }
  }
});

test("Fish Audio direct and PM2 launchers use Bun while preserving the Python gateway", () => {
  assert.equal(
    rootPackage.scripts["voice:fish:start"],
    "bun scripts/start-fish-audio.cjs",
  );
  for (const definition of [
    developmentProcessDefinition("fish-audio"),
    productionProcessDefinition("fish-audio"),
  ]) {
    assert.ok(definition);
    assert.equal(path.basename(definition.execInterpreter), "bun");
    assert.equal(
      definition.execPath,
      path.join(repoRoot, "scripts/start-fish-audio.cjs"),
    );
  }
});

test("Pocket TTS runs the pinned official default CPU gateway on 8063", () => {
  assert.equal(
    rootPackage.scripts["voice:pocket:start"],
    "bun scripts/start-pocket-tts.cjs",
  );
  for (const mode of ["development", "production"]) {
    const pocket = byName(loadConfig(mode), "pocket-tts");
    assert.equal(path.basename(pocket.interpreter), "bun");
    assert.equal(pocket.script, "scripts/start-pocket-tts.cjs");
    assert.equal(pocket.env.POCKET_TTS_PORT, "8063");
    assert.equal(pocket.env.POCKET_TTS_MODEL, "pocket-tts");
    assert.equal(pocket.env.POCKET_TTS_LANGUAGE, "english");
    assert.match(pocket.env.POCKET_TTS_MODEL_REVISION, /^[a-f0-9]{40}$/);
  }
});

test("the ecosystem loads Fish only when system or identity configuration requires it", () => {
  const pocketOnly = loadConfig("production");
  const withFishIdentity = loadConfig("production", {
    VOICE_IDENTITY_PROVIDER: "fish-audio",
  });

  assert.equal(
    pocketOnly.apps.some((app) => app.name === "fish-audio"),
    false,
  );
  assert.equal(
    withFishIdentity.apps.some((app) => app.name === "fish-audio"),
    true,
  );
});

test("configuration fixtures isolate their baseline from local Fish identity settings", (t) => {
  const mainEnvPath = path.join(repoRoot, "packages/main/.env");
  const existsSync = fs.existsSync;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "existsSync", (filename) => filename === mainEnvPath || existsSync(filename));
  t.mock.method(fs, "readFileSync", (filename, ...args) => filename === mainEnvPath
    ? "VOICE_PROVIDER=pocket-tts\nVOICE_IDENTITY_PROVIDER=fish-audio\n"
    : readFileSync(filename, ...args));

  assert.equal(loadConfig("development").apps.some((app) => app.name === "fish-audio"), false);
  assert.equal(loadConfig("production").apps.some((app) => app.name === "fish-audio"), false);
  assert.equal(loadConfig("development", { VOICE_IDENTITY_PROVIDER: "fish-audio" }).apps.some((app) => app.name === "fish-audio"), true);
  assert.equal(loadConfig("production", { VOICE_PROVIDER: "fish-audio" }).apps.some((app) => app.name === "fish-audio"), true);
});

test("obsolete rollout flags cannot enter the embedded Chat runtime", () => {
  const obsolete = [
    "DSH_AGENT_ENABLED",
    "COMPANION_EXECUTION_MODE",
    "COMPANION_DSH_PERCENT",
    "COMPANION_SHADOW_ENABLED",
  ];
  const originals = new Map(obsolete.map((key) => [key, process.env[key]]));
  try {
    for (const key of obsolete) process.env[key] = "0";
    const config = loadConfig("production");
    const chat = byName(config, "chat");
    for (const key of obsolete) {
      assert.equal(Object.hasOwn(chat.env, key), false, `chat ${key}`);
    }
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(configPath)];
  }
});

test("every runtime receives the operator-approved source identity", () => {
  const originalRevision = process.env.IDREAM_SOURCE_REVISION;
  const originalRelease = process.env.SENTRY_RELEASE;
  try {
    process.env.IDREAM_SOURCE_REVISION = "idream-worktree-test-revision";
    process.env.SENTRY_RELEASE = "idream-worktree-test-release";
    const config = loadConfig("development");

    for (const app of config.apps) {
      assert.equal(
        app.env.IDREAM_SOURCE_REVISION,
        "idream-worktree-test-revision",
        `${app.name} source revision`,
      );
      assert.equal(
        app.env.SENTRY_RELEASE,
        "idream-worktree-test-release",
        `${app.name} Sentry release`,
      );
      assert.equal(
        app.env.IDREAM_RUNTIME_CERTIFICATION,
        "non-certifying-source-watch",
        `${app.name} development certification boundary`,
      );
    }
  } finally {
    if (originalRevision === undefined) {
      delete process.env.IDREAM_SOURCE_REVISION;
    } else {
      process.env.IDREAM_SOURCE_REVISION = originalRevision;
    }
    if (originalRelease === undefined) {
      delete process.env.SENTRY_RELEASE;
    } else {
      process.env.SENTRY_RELEASE = originalRelease;
    }
    delete require.cache[require.resolve(configPath)];
  }
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
  assert.equal(mainPackage.scripts.dev, "bun scripts/start-development.cjs");
  assert.match(mainPackage.scripts.typecheck, /^bun run db:generate && /);
});

test("production keeps immutable standalone web releases and disables watch", () => {
  const config = loadConfig("production");
  const mainWeb = byName(config, "main-web");
  const adminWeb = byName(config, "admin-web");

  for (const web of [mainWeb, adminWeb]) {
    assert.equal(web.cwd, repoRoot);
    assert.equal(web.script, "scripts/start-next-standalone.cjs");
    assert.equal(web.exec_mode, "cluster");
    assert.equal(path.basename(web.interpreter), "bun");
    assert.equal(web.watch, false);
    assert.equal(web.env.IDREAM_PM2_BUN_ENTRYPOINT, "next-standalone");
  }
  assert.equal(mainWeb.env.IDREAM_NEXT_PACKAGE_PATH, "packages/main");
  assert.equal(adminWeb.env.IDREAM_NEXT_PACKAGE_PATH, "packages/admin");
  for (const app of config.apps) {
    assert.equal(app.watch, false);
    assert.equal(app.env.IDREAM_PM2_MODE, "production");
    assert.equal(
      app.env.IDREAM_RUNTIME_CERTIFICATION,
      "revision-bound-immutable",
    );
  }
});

test("production runs Bun-built worker artifacts instead of TypeScript source", () => {
  const config = loadConfig("production");
  const expectedScripts = new Map([
    ["chat", "dist/main.js"],
    ["gen-image", "dist/image.js"],
    ["gen-video", "dist/video.js"],
    ["gen-finalizer", "dist/finalizer.js"],
    ["main-event-consumer", "dist/event-consumer.js"],
    ["admin-command-worker", "dist/admin-command-worker.js"],
  ]);
  for (const [name, script] of expectedScripts) {
    assert.equal(byName(config, name).script, script);
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
      ...(app.node_args ? { nodeArgs: app.node_args } : {}),
      ...(app.interpreter ? { execInterpreter: app.interpreter } : {}),
      execMode: `${app.exec_mode}_mode`,
    });
  }
});

test("development definition authority stays exact for every ecosystem app", () => {
  const config = loadConfig("development");
  for (const app of config.apps) {
    const definition = developmentProcessDefinition(app.name);
    assert.ok(definition, `missing development definition ${app.name}`);
    assert.deepEqual(definition, {
      cwd: app.cwd,
      execPath: path.resolve(app.cwd, app.script),
      args: typeof app.args === "string" ? [app.args] : (app.args ?? []),
      ...(app.interpreter ? { execInterpreter: app.interpreter } : {}),
      execMode: `${app.exec_mode}_mode`,
    });
    assert.equal(
      matchesDevelopmentProcessDefinition(
        pm2ProcessFromApp(app, "stopped", "development"),
      ),
      true,
    );
  }
});

test("development recreates a registered Node/tsx definition for the Bun migration", () => {
  const app = byName(loadConfig("development"), "gen-image");
  const legacy = pm2ProcessFromApp(app, "stopped", "development");
  legacy.pm2_env.pm_exec_path = path.join(
    repoRoot,
    "packages/gen/node_modules/tsx/dist/cli.mjs",
  );
  legacy.pm2_env.args = ["src/image.ts"];
  legacy.pm2_env.exec_interpreter = process.execPath;

  assert.deepEqual(developmentDefinitionPlan([legacy]), {
    deleteNames: ["gen-image"],
    requiresStart: true,
  });
});

test("development recreates gen-image when the requested instance count shrinks", () => {
  const app = byName(loadConfig("development"), "gen-image");
  const first = pm2ProcessFromApp(app, "stopped", "development");
  const second = pm2ProcessFromApp(app, "stopped", "development");
  second.pm2_env.NODE_APP_INSTANCE = 1;

  assert.deepEqual(
    developmentDefinitionPlan(
      [first, second],
      { GEN_IMAGE_INSTANCES: "1", GEN_VIDEO_PROVIDER: "mock" },
    ),
    { deleteNames: ["gen-image"], requiresStart: true },
  );
});

test("development replaces an inactive Fish runtime with the Pocket default", () => {
  const fish = pm2ProcessFromApp(
    byName(
      loadConfig("development", {
        VOICE_IDENTITY_PROVIDER: "fish-audio",
      }),
      "fish-audio",
    ),
    "online",
    "development",
  );

  assert.deepEqual(
    developmentDefinitionPlan([fish], {
      VOICE_PROVIDER: "pocket-tts",
      GEN_VIDEO_PROVIDER: "mock",
    }),
    { deleteNames: ["fish-audio"], requiresStart: true },
  );
});

test("every production definition field fails closed on drift", () => {
  const exact = pm2Process("main-web", "online");
  assert.equal(matchesProductionProcessDefinition(exact), true);
  const mutations = [
    { pm_cwd: `${exact.pm2_env.pm_cwd}-stale` },
    { pm_exec_path: `${exact.pm2_env.pm_exec_path}-stale` },
    { args: ["packages/admin"] },
    { node_args: ["--inspect"] },
    { exec_mode: "fork_mode" },
    { watch: true },
    { IDREAM_PM2_MODE: "development" },
    { IDREAM_RUNTIME_CERTIFICATION: "non-certifying-source-watch" },
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

test("production definition certification is bound to one source revision", () => {
  const exact = pm2Process("main-web", "online");
  exact.pm2_env.IDREAM_SOURCE_REVISION = "idream-worktree-revision-a";

  assert.equal(
    matchesProductionProcessDefinition(exact, {
      GEN_VIDEO_PROVIDER: "backend",
      IDREAM_SOURCE_REVISION: "idream-worktree-revision-a",
    }),
    true,
  );
  assert.equal(
    matchesProductionProcessDefinition(exact, {
      GEN_VIDEO_PROVIDER: "backend",
      IDREAM_SOURCE_REVISION: "idream-worktree-revision-b",
    }),
    false,
  );
});

test("production stop phases classify every non-voice app exactly once", () => {
  const config = loadConfig("production");
  const expected = config.apps
    .map((app) => app.name)
    .filter((name) => name !== "fish-audio" && name !== "pocket-tts")
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

test("the durable event consumer can finish its bounded drain before PM2 forces termination", () => {
  for (const mode of ["development", "production"]) {
    assert.equal(byName(loadConfig(mode), "main-event-consumer").kill_timeout, 35_000);
  }
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
      ["curl", "http://127.0.0.1:8063/health"],
      ["bun", "preflight"],
      ["pm2", "jlist"],
    ],
  );
});

test("production readiness conditionally owns the Fish identity runtime", () => {
  const calls = [];
  const fish = pm2Process("fish-audio", "online");
  const processes = [...onlineProductionProcesses(), fish];
  const status = verifyProductionRuntime({
    runtimeEnv: productionEnv({ VOICE_IDENTITY_PROVIDER: "fish-audio" }),
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn(
      [
        { status: 0, stdout: noisyPm2List(processes) },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0, stdout: noisyPm2List(processes) },
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
      ["curl", "http://127.0.0.1:8063/health"],
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
            "packages/main/scripts/start-development.cjs",
          ),
          args: [],
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
    pm2Process("pocket-tts", "online"),
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
    new Set(["fish-audio", "pocket-tts"]).has(process.name)
      ? pm2Process(process.name, "stopped")
      : process,
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
    ["pm2", ["stop", "pocket-tts"]],
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
    computeSourceRevision: () => "idream-worktree-current-revision",
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
  assert.equal(
    calls[11].options.env.IDREAM_SOURCE_REVISION,
    "idream-worktree-current-revision",
  );
  assert.deepEqual(
    ownershipChecks.map(({ expected, expectedVideo, mode }) => ({
      expected,
      expectedVideo,
      mode,
    })),
    [
      { expected: 0, expectedVideo: 0, mode: "quiescent" },
      { expected: 1, expectedVideo: 1, mode: "ready" },
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
      { expected: 1, expectedVideo: 1, mode: "ready" },
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
      start: "bun scripts/start-pm2-ecosystem.cjs production",
      restart: "bun scripts/start-pm2-ecosystem.cjs production restart",
      reload: "bun scripts/start-pm2-ecosystem.cjs production reload",
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
      start: "bun scripts/start-pm2-ecosystem.cjs",
      stop: "bun scripts/start-pm2-ecosystem.cjs current stop",
      restart: "bun scripts/start-pm2-ecosystem.cjs current restart",
      reload: "bun scripts/start-pm2-ecosystem.cjs current reload",
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
      quiesce: "bun scripts/start-pm2-ecosystem.cjs current quiesce",
      plan: "bun scripts/recover-gen-worker-orphans.cjs plan",
      apply: "bun scripts/recover-gen-worker-orphans.cjs apply",
    },
  );
});
