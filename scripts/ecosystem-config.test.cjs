const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "ecosystem.config.js");
const rootPackage = require("../package.json");
const {
  productionAdmissionTargets,
  productionDrainWorkerTargets,
  productionQuiescenceTargets,
  productionRuntimeTargets,
  resolveCurrentPm2Mode,
  runPm2Ecosystem,
  verifyProductionRuntime,
} = require("./start-pm2-ecosystem.cjs");

function loadConfig(mode) {
  const originalMode = process.env.IDREAM_PM2_MODE;
  try {
    if (mode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = mode;
    }
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  } finally {
    if (originalMode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = originalMode;
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
  return { name, pm2_env: { status } };
}

function commandList(calls) {
  return calls.map(({ command, args }) => [command, args]);
}

function onlineProductionProcesses() {
  return productionRuntimeTargets.flatMap((name) =>
    Array.from(
      { length: name === "gen-image" ? 2 : 1 },
      () => pm2Process(name, "online"),
    )
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
  assert.equal(mainWeb.script, "node_modules/next/dist/bin/next");
  assert.equal(mainWeb.args, "dev");
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
  assert.equal(
    productionDrainWorkerTargets.at(-1),
    "gen-finalizer",
  );
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
    runtimeEnv: { PATH: process.env.PATH },
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn([
      { status: 0, stdout: JSON.stringify(onlineProductionProcesses()) },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: JSON.stringify(onlineProductionProcesses()) },
    ], calls),
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls).map(([command, args]) => [
    command,
    args.at(-1),
  ]), [
    ["pm2", "jlist"],
    ["curl", "http://127.0.0.1:3000/"],
    ["curl", "http://127.0.0.1:3001/"],
    ["curl", "http://127.0.0.1:3100/healthz"],
    ["curl", "http://127.0.0.1:8062/health"],
    ["bun", "preflight"],
    ["pm2", "jlist"],
  ]);
});

test("an errored production worker keeps Generation queues paused", () => {
  const calls = [];
  const processes = onlineProductionProcesses().map((process) =>
    process.name === "gen-video"
      ? pm2Process("gen-video", "errored")
      : process
  );
  const status = verifyProductionRuntime({
    runtimeEnv: { PATH: process.env.PATH },
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn([
      { status: 0, stdout: JSON.stringify(processes) },
    ], calls),
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
    runtimeEnv: { PATH: process.env.PATH },
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn([
      { status: 0, stdout: JSON.stringify(processes) },
    ], calls),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("a process that crashes during service probes keeps queues paused", () => {
  const calls = [];
  const crashed = onlineProductionProcesses().map((process) =>
    process.name === "gen-video"
      ? pm2Process("gen-video", "errored")
      : process
  );
  const status = verifyProductionRuntime({
    runtimeEnv: { PATH: process.env.PATH },
    onlineAttempts: 1,
    delay: () => undefined,
    spawnSync: scriptedSpawn([
      { status: 0, stdout: JSON.stringify(onlineProductionProcesses()) },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: JSON.stringify(crashed) },
    ], calls),
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
  assert.equal(resolveCurrentPm2Mode([
    {
      name: "main-web",
      pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
    },
    {
      name: "admin-web",
      pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
    },
  ]), "production");
  assert.equal(resolveCurrentPm2Mode([
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
  ]), "development");
  assert.equal(resolveCurrentPm2Mode([
    {
      name: "main-web",
      pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
    },
    {
      name: "admin-web",
      pm2_env: { status: "online", IDREAM_PM2_MODE: "development" },
    },
  ]), null);
});

test("a generic restart of production enters the cutover gate before PM2 mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["current", "restart"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      {
        status: 0,
        stdout: JSON.stringify([{
          name: "main-web",
          pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
        }]),
      },
      { status: 31 },
    ], calls),
  });

  assert.equal(status, 31);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
  ]);
  assert.equal(calls[1].options.env.IDREAM_PM2_MODE, "production");
});

test("a generic development restart preserves the detected source topology", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["current", "restart"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      {
        status: 0,
        stdout: JSON.stringify([{
          name: "main-web",
          pm2_env: { status: "online", IDREAM_PM2_MODE: "development" },
        }]),
      },
      { status: 0 },
      { status: 0 },
    ], calls),
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["pm2", ["jlist"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["restart", "ecosystem.config.js", "--update-env"]],
  ]);
  assert.equal(calls[2].options.env.IDREAM_PM2_MODE, "development");
});

test("development start refuses to replace a running production topology", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: [],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      {
        status: 0,
        stdout: JSON.stringify([{
          name: "main-web",
          pm2_env: { status: "online", IDREAM_PM2_MODE: "production" },
        }]),
      },
    ], calls),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [["pm2", ["jlist"]]]);
});

test("production pauses and drains before phased stop, gate, restart, and resume", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production", "restart"],
    env: {
      PATH: process.env.PATH,
      MAIN_REDIS_URL: "redis://production-main:6379/4",
    },
    spawnSync: scriptedSpawn([
      { status: 0 },
      {
        status: 0,
        stdout: JSON.stringify([
          pm2Process("main-web", "online"),
          pm2Process("admin-command-worker", "online"),
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
          pm2Process("gen-finalizer", "stopped"),
          pm2Process("fish-audio", "online"),
        ]),
      },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
    ], calls),
    verifyProductionRuntime: () => 0,
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-web"]],
    ["pm2", ["stop", "admin-command-worker"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "gen-image"]],
    ["pm2", ["stop", "gen-finalizer"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["restart", "ecosystem.config.js", "--update-env"]],
    ["bun", ["run", "generation-cutover:resume"]],
  ]);
  for (const index of [0, 8, 11]) {
    assert.equal(calls[index].options.cwd, path.join(repoRoot, "packages/main"));
    assert.equal(calls[index].options.env.IDREAM_PM2_MODE, "production");
    assert.equal(
      calls[index].options.env.REDIS_URL,
      "redis://production-main:6379/4",
    );
  }
});

test("a failed pause/drain prevents every PM2 mutation", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([{ status: 31 }], calls),
  });

  assert.equal(status, 31);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
  ]);
});

test("a failed admission stop prevents worker stop, gate, and restart", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production", "reload"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      {
        status: 0,
        stdout: JSON.stringify([pm2Process("main-event-consumer", "online")]),
      },
      { status: 17 },
    ], calls),
  });

  assert.equal(status, 17);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["stop", "main-event-consumer"]],
  ]);
});

test("a failed admission verification prevents worker stop and gate", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
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
    ], calls),
  });

  assert.equal(status, 1);
  assert.deepEqual(commandList(calls), [
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
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      { status: 0, stdout: onlineWorker },
      { status: 0, stdout: onlineWorker },
      { status: 19 },
    ], calls),
  });

  assert.equal(status, 19);
  assert.deepEqual(commandList(calls), [
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
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 23 },
    ], calls),
  });

  assert.equal(status, 23);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
  ]);
});

test("a failed PM2 start never resumes generation queues", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0 },
      { status: 0 },
      { status: 29 },
    ], calls),
  });

  assert.equal(status, 29);
  assert.deepEqual(commandList(calls).at(-1), [
    "pm2",
    ["start", "ecosystem.config.js"],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("generation-cutover:resume")
    ),
    false,
  );
});

test("a PM2 command accepted before runtime readiness never resumes queues", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0 },
      { status: 0 },
      { status: 0 },
    ], calls),
    verifyProductionRuntime: () => 47,
  });

  assert.equal(status, 47);
  assert.deepEqual(commandList(calls).at(-1), [
    "pm2",
    ["start", "ecosystem.config.js"],
  ]);
  assert.equal(
    commandList(calls).some(([, args]) =>
      args.includes("generation-cutover:resume")
    ),
    false,
  );
});

test("a resume failure is returned after its rollback-to-pause command", () => {
  const calls = [];
  const status = runPm2Ecosystem({
    args: ["production"],
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 41 },
    ], calls),
    verifyProductionRuntime: () => 0,
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
    env: { PATH: process.env.PATH },
    spawnSync: scriptedSpawn([
      { status: 0 },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "[]" },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
    ], calls),
    verifyProductionRuntime: () => 0,
  });

  assert.equal(status, 0);
  assert.deepEqual(commandList(calls), [
    ["bun", ["run", "generation-cutover:pause-and-drain"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["pm2", ["jlist"]],
    ["bun", ["run", "check:generation-cutover"]],
    ["pm2", ["delete", "pocket-tts"]],
    ["pm2", ["start", "ecosystem.config.js"]],
    ["bun", ["run", "generation-cutover:resume"]],
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

test("generic restart and reload resolve the running mode through the wrapper", () => {
  assert.deepEqual(
    {
      restart: rootPackage.scripts["pm2:restart"],
      reload: rootPackage.scripts["pm2:reload"],
    },
    {
      restart: "node scripts/start-pm2-ecosystem.cjs current restart",
      reload: "node scripts/start-pm2-ecosystem.cjs current reload",
    },
  );
});
