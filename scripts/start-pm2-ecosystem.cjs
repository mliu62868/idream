const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const {
  loadGenEnvironment,
} = require("./check-gen-image-worker-ownership.cjs");

const repoRoot = path.resolve(__dirname, "..");
const productionGateCwd = path.join(repoRoot, "packages/main");
const productionGenCwd = path.join(repoRoot, "packages/gen");
const genImageOwnershipProbe = path.join(
  repoRoot,
  "scripts/check-gen-image-worker-ownership.cjs",
);
const supportedActions = new Set([
  "start",
  "restart",
  "reload",
  "quiesce",
  "stop",
]);
const productionAdmissionTargets = [
  "main-web",
  "admin-web",
  "chat",
  "main-event-consumer",
  "admin-command-worker",
];
const productionDrainWorkerTargets = [
  "gen-image",
  "gen-video",
  // Finalizer stops last so an already-active terminal ingest/finalize
  // transition can settle. New Gen terminal records remain durable in the
  // globally paused relay queue until the verified runtime resumes it.
  "gen-finalizer",
];
const productionQuiescenceTargets = [
  ...productionAdmissionTargets,
  ...productionDrainWorkerTargets,
];
const productionRuntimeTargets = ["fish-audio", ...productionQuiescenceTargets];
const quiescedStatuses = new Set(["stopped", "errored"]);
const runtimeModes = new Set(["development", "production"]);
const productionProcessDefinitions = new Map([
  ["fish-audio", {
    cwd: repoRoot,
    execPath: path.join(repoRoot, "scripts/start-fish-audio.cjs"),
    args: [],
    execMode: "fork_mode",
  }],
  ["main-web", {
    cwd: repoRoot,
    execPath: path.join(repoRoot, "scripts/start-next-standalone.cjs"),
    args: ["packages/main"],
    execMode: "cluster_mode",
  }],
  ["admin-web", {
    cwd: repoRoot,
    execPath: path.join(repoRoot, "scripts/start-next-standalone.cjs"),
    args: ["packages/admin"],
    execMode: "cluster_mode",
  }],
  ["chat", {
    cwd: path.join(repoRoot, "packages/chat"),
    execPath: path.join(repoRoot, "packages/chat/node_modules/tsx/dist/cli.mjs"),
    args: ["src/main.ts"],
    execMode: "fork_mode",
  }],
  ["gen-image", {
    cwd: productionGenCwd,
    execPath: path.join(productionGenCwd, "node_modules/tsx/dist/cli.mjs"),
    args: ["src/image.ts"],
    execMode: "fork_mode",
  }],
  ["gen-video", {
    cwd: productionGenCwd,
    execPath: path.join(productionGenCwd, "node_modules/tsx/dist/cli.mjs"),
    args: ["src/video.ts"],
    execMode: "fork_mode",
  }],
  ["gen-finalizer", {
    cwd: productionGateCwd,
    execPath: path.join(productionGateCwd, "node_modules/tsx/dist/cli.mjs"),
    args: ["src/processes/finalizer.ts"],
    execMode: "fork_mode",
  }],
  ["main-event-consumer", {
    cwd: productionGateCwd,
    execPath: path.join(productionGateCwd, "node_modules/tsx/dist/cli.mjs"),
    args: ["src/processes/event-consumer.ts"],
    execMode: "fork_mode",
  }],
  ["admin-command-worker", {
    cwd: productionGateCwd,
    execPath: path.join(productionGateCwd, "node_modules/tsx/dist/cli.mjs"),
    args: ["src/processes/admin-command-worker.ts"],
    execMode: "fork_mode",
  }],
]);

function productionProcessEnv(env, mode) {
  const redisUrl = env.MAIN_REDIS_URL ?? env.REDIS_URL;
  return {
    ...env,
    ...(mode ? { IDREAM_PM2_MODE: mode } : {}),
    // Production injects both spellings so packages/gen/.env cannot supply a
    // higher-priority GEN_REDIS_URL that diverges from Main's queue authority.
    ...(redisUrl ? { REDIS_URL: redisUrl, GEN_REDIS_URL: redisUrl } : {}),
  };
}

function readPm2ProcessList(spawn, runtimeEnv) {
  const listed = spawn("pm2", ["jlist"], {
    cwd: repoRoot,
    env: runtimeEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    return { ok: false, status: listed.status ?? 1, processes: [] };
  }
  const lines = String(listed.stdout ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trimStart().startsWith("[")) continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n").trim());
      if (Array.isArray(parsed)) {
        return { ok: true, status: 0, processes: parsed };
      }
    } catch {
      // PM2 may print version-skew notices before the JSON payload. Keep
      // scanning candidate suffixes, but never accept non-array output.
    }
  }
  return { ok: false, status: 1, processes: [] };
}

function processStatus(process) {
  return process &&
    typeof process === "object" &&
    process.pm2_env &&
    typeof process.pm2_env === "object" &&
    typeof process.pm2_env.status === "string"
    ? process.pm2_env.status
    : null;
}

function processRuntimeMarker(process) {
  const pm2Env =
    process && typeof process === "object" ? process.pm2_env : null;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  const marker = pm2Env.IDREAM_PM2_MODE ?? pm2Env.env?.IDREAM_PM2_MODE;
  return runtimeModes.has(marker) ? marker : null;
}

function normalizePm2Args(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function productionProcessDefinition(name) {
  return productionProcessDefinitions.get(name) ?? null;
}

function matchesProductionProcessDefinition(process) {
  const definition = productionProcessDefinition(process?.name);
  const pm2Env = process?.pm2_env;
  return Boolean(
    definition &&
      pm2Env &&
      typeof pm2Env === "object" &&
      pm2Env.pm_cwd === definition.cwd &&
      pm2Env.pm_exec_path === definition.execPath &&
      JSON.stringify(normalizePm2Args(pm2Env.args)) ===
        JSON.stringify(definition.args) &&
      pm2Env.exec_mode === definition.execMode &&
      pm2Env.watch === false &&
      processRuntimeMarker(process) === "production",
  );
}

function productionDefinitionPlan(processes) {
  // INVARIANT: PM2 `--update-env` merges variables and cannot delete stale
  // optional provider credentials. After the global queue fence every owned
  // production app is therefore recreated, even when its structural definition
  // already matches. This is the only small boundary that proves both definition
  // and environment replacement rather than inheritance from an older daemon.
  const deleteNames = productionRuntimeTargets.filter((name) =>
    processes.some((process) => process?.name === name)
  );
  return { deleteNames, requiresStart: true };
}

function legacyWebRuntimeMode(process) {
  if (!process || !["main-web", "admin-web"].includes(process.name)) {
    return null;
  }
  const pm2Env = process.pm2_env;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  const executable =
    typeof pm2Env.pm_exec_path === "string" ? pm2Env.pm_exec_path : "";
  const args = Array.isArray(pm2Env.args) ? pm2Env.args.map(String) : [];
  if (executable.endsWith("/scripts/start-next-standalone.cjs")) {
    return "production";
  }
  if (
    executable.includes("/node_modules/next/dist/bin/next") &&
    args.includes("dev")
  ) {
    return "development";
  }
  return null;
}

// SPEC: Mode-less restart/reload commands must continue the running topology;
// they may never make ecosystem.config.js silently fall back to development.
// Legacy processes created before the marker existed are recognized only by
// the two unambiguous web entrypoints. Mixed or unknown evidence fails closed.
function resolveCurrentPm2Mode(processes) {
  const owned = processes.filter((process) =>
    productionRuntimeTargets.includes(process?.name),
  );
  if (owned.length === 0) return null;
  const evidence = owned.flatMap((process) => {
    const marker = processRuntimeMarker(process);
    if (marker) return [marker];
    const legacy = legacyWebRuntimeMode(process);
    return legacy ? [legacy] : [];
  });
  if (evidence.length === 0) return null;
  const modes = new Set(evidence);
  return modes.size === 1 ? evidence[0] : null;
}

function positiveInstanceCount(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function productionVideoWorkerCount(runtimeEnv) {
  const provider = runtimeEnv.GEN_VIDEO_PROVIDER ?? "mock";
  if (provider === "mock") return 0;
  if (provider === "backend") return 1;
  throw new Error(
    `Production video worker topology requires GEN_VIDEO_PROVIDER=mock or backend, received ${provider}`,
  );
}

function developmentVideoWorkerCount(runtimeEnv) {
  // Gen loads packages/gen/.env non-overridingly. Use the same resolver as the
  // ownership collector so the expected topology matches the worker's actual
  // provider after shell-over-file precedence, including a default mock exit.
  const provider = loadGenEnvironment(runtimeEnv).GEN_VIDEO_PROVIDER ?? "mock";
  if (provider === "mock") return 0;
  if (provider === "backend" || provider === "pipeline") return 1;
  throw new Error(
    `Development video worker topology requires GEN_VIDEO_PROVIDER=mock, backend or pipeline, received ${provider}`,
  );
}

function productionExpectedInstances(runtimeEnv) {
  return new Map(
    productionRuntimeTargets.map((name) => [
      name,
      name === "main-web"
        ? positiveInstanceCount(runtimeEnv.MAIN_WEB_INSTANCES, 1)
        : name === "gen-image"
          ? positiveInstanceCount(runtimeEnv.GEN_IMAGE_INSTANCES, 2)
          : name === "gen-video"
            ? productionVideoWorkerCount(runtimeEnv)
            : 1,
    ]),
  );
}

function runtimeIsOnline(processes, expectedInstances) {
  for (const [name, expected] of expectedInstances) {
    const instances = processes.filter((process) => process?.name === name);
    if (
      instances.length !== expected ||
      instances.some(
        (process) =>
          processStatus(process) !== "online" ||
          !matchesProductionProcessDefinition(process),
      )
    ) {
      return false;
    }
  }
  return true;
}

function blockingDelay(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// INVARIANT: accepting a PM2 mutation is not deployment success. Every expected
// process instance and its minimum service dependency must be ready before the
// globally paused Generation queues are admitted again.
function verifyProductionRuntime(options) {
  const spawn = options.spawnSync;
  const runtimeEnv = options.runtimeEnv;
  const expectedInstances = productionExpectedInstances(runtimeEnv);
  const attempts = positiveInstanceCount(options.onlineAttempts, 30);
  const delay = options.delay ?? blockingDelay;
  let lastProcesses = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const listed = readPm2ProcessList(spawn, runtimeEnv);
    if (listed.ok) {
      lastProcesses = listed.processes;
      if (runtimeIsOnline(lastProcesses, expectedInstances)) break;
    }
    if (attempt < attempts) delay(500);
  }
  if (!runtimeIsOnline(lastProcesses, expectedInstances)) {
    const observed = productionRuntimeTargets.map((name) => ({
      name,
      statuses: lastProcesses
        .filter((process) => process?.name === name)
        .map(processStatus),
      definitionMatches: lastProcesses
        .filter((process) => process?.name === name)
        .map(matchesProductionProcessDefinition),
    }));
    process.stderr.write(
      `Production runtime definition/readiness is invalid; Generation queues remain paused: ${JSON.stringify(observed)}\n`,
    );
    return 1;
  }

  const curlProbe = (name, url) => ({
    name,
    command: "curl",
    args: [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--output",
      "/dev/null",
      url,
    ],
    cwd: repoRoot,
  });
  const probes = [
    curlProbe(
      "main-web",
      `http://127.0.0.1:${runtimeEnv.MAIN_WEB_PORT ?? "3000"}/`,
    ),
    curlProbe(
      "admin-web",
      `http://127.0.0.1:${runtimeEnv.ADMIN_WEB_PORT ?? "3001"}/`,
    ),
    curlProbe(
      "chat",
      `http://127.0.0.1:${runtimeEnv.CHAT_PORT ?? "3100"}/readyz`,
    ),
    curlProbe(
      "fish-audio",
      `http://127.0.0.1:${runtimeEnv.FISH_AUDIO_PORT ?? "8062"}/health`,
    ),
    {
      name: "gen-backend",
      command: "bun",
      args: ["run", "preflight"],
      cwd: productionGenCwd,
    },
  ];
  for (const probe of probes) {
    const result = spawn(probe.command, probe.args, {
      cwd: probe.cwd,
      env: runtimeEnv,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(
        `Production readiness failed for ${probe.name}; Generation queues remain paused\n`,
      );
      return result.status ?? 1;
    }
  }
  const confirmed = readPm2ProcessList(spawn, runtimeEnv);
  if (
    !confirmed.ok ||
    !runtimeIsOnline(confirmed.processes, expectedInstances)
  ) {
    process.stderr.write(
      "Production runtime changed during readiness probes; Generation queues remain paused\n",
    );
    return confirmed.ok ? 1 : confirmed.status;
  }
  return 0;
}

function stopProductionTargets(spawn, runtimeEnv, processes, targets) {
  for (const name of targets) {
    const instances = processes.filter((process) => process?.name === name);
    if (
      instances.length === 0 ||
      instances.every((process) => quiescedStatuses.has(processStatus(process)))
    ) {
      continue;
    }
    const stopped = spawn("pm2", ["stop", name], {
      cwd: repoRoot,
      env: runtimeEnv,
      stdio: "inherit",
    });
    if (stopped.error) throw stopped.error;
    if (stopped.status !== 0) return stopped.status ?? 1;
  }
  return 0;
}

function hasUnsafeProductionTarget(processes, targets) {
  return processes.some(
    (process) =>
      targets.includes(process?.name) &&
      !quiescedStatuses.has(processStatus(process)),
  );
}

function quiesceProductionProcesses(spawn, runtimeEnv, onSnapshot) {
  const before = readPm2ProcessList(spawn, runtimeEnv);
  if (!before.ok) return before.status;

  const admissionStop = stopProductionTargets(
    spawn,
    runtimeEnv,
    before.processes,
    productionAdmissionTargets,
  );
  if (admissionStop !== 0) return admissionStop;
  const afterAdmission = readPm2ProcessList(spawn, runtimeEnv);
  if (!afterAdmission.ok) return afterAdmission.status;
  if (
    hasUnsafeProductionTarget(
      afterAdmission.processes,
      productionAdmissionTargets,
    )
  ) {
    return 1;
  }

  const workerStop = stopProductionTargets(
    spawn,
    runtimeEnv,
    afterAdmission.processes,
    productionDrainWorkerTargets,
  );
  if (workerStop !== 0) return workerStop;

  // A final daemon snapshot closes PM2's stop transition window. Absent apps
  // are the normal first-deploy case; every present non-voice app must now be
  // durably stopped before the immutable authority gate is evaluated.
  const after = readPm2ProcessList(spawn, runtimeEnv);
  if (!after.ok) return after.status;
  onSnapshot?.(after.processes);
  return hasUnsafeProductionTarget(after.processes, productionQuiescenceTargets)
    ? 1
    : 0;
}

function verifyGenImageWorkerOwnership({
  expected,
  expectedVideo,
  mode,
  runtimeEnv,
  spawnSync: spawn,
}) {
  const result = spawn(
    "node",
    [
      genImageOwnershipProbe,
      "--mode",
      mode,
      "--expected",
      String(expected),
      "--expected-video",
      String(expectedVideo),
    ],
    {
      cwd: repoRoot,
      env: runtimeEnv,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(
      `Generation worker ownership is not ${mode}; Generation queues remain paused\n`,
    );
  }
  return result.status ?? 1;
}

function runPm2Ecosystem(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const spawn = options.spawnSync ?? spawnSync;
  const requestedMode = args[0] ?? "development";
  const action = args[1] ?? "start";
  let definitionRecreated = false;
  if (![...runtimeModes, "current"].includes(requestedMode)) {
    throw new Error(`Unsupported PM2 ecosystem mode: ${requestedMode}`);
  }
  if (!supportedActions.has(action)) {
    throw new Error(`Unsupported PM2 ecosystem action: ${action}`);
  }

  let mode = requestedMode;
  if (requestedMode === "current" || requestedMode === "development") {
    const listed = readPm2ProcessList(spawn, productionProcessEnv(env));
    if (!listed.ok) return listed.status;
    const currentMode = resolveCurrentPm2Mode(listed.processes);
    if (requestedMode === "current") {
      if (!currentMode) {
        process.stderr.write(
          "Cannot resolve the current PM2 runtime mode; use an explicit start command\n",
        );
        return 1;
      }
      mode = currentMode;
    } else if (currentMode === "production") {
      process.stderr.write(
        "Refusing to replace a production PM2 topology with development mode\n",
      );
      return 1;
    }
  }

  // One invocation owns one Generation worker generation in every PM2 mode.
  // Development needs the same post-start proof as production; otherwise a
  // successful PM2 exit can coexist with an older anonymous/orphan consumer.
  const workerRunId = `pm2-${randomUUID()}`;
  const runtimeEnv = {
    ...productionProcessEnv(env, mode),
    GEN_IMAGE_WORKER_RUN_ID: workerRunId,
    GEN_VIDEO_WORKER_RUN_ID: workerRunId,
  };
  if (mode === "production") {
    if (runtimeEnv.APP_ENV !== "production") {
      process.stderr.write(
        "Production PM2 topology requires APP_ENV=production before any mutation\n",
      );
      return 1;
    }
    if (
      typeof runtimeEnv.REDIS_URL !== "string" ||
      !runtimeEnv.REDIS_URL.trim() ||
      typeof runtimeEnv.BULLMQ_PREFIX !== "string" ||
      !runtimeEnv.BULLMQ_PREFIX.trim()
    ) {
      process.stderr.write(
        "Production PM2 topology requires explicit REDIS_URL and BULLMQ_PREFIX before any mutation\n",
      );
      return 1;
    }
    if (!new Set(["quiesce", "stop"]).has(action)) {
      const launchGate = spawn("bun", ["run", "check:launch:direct"], {
        cwd: repoRoot,
        env: runtimeEnv,
        stdio: "inherit",
      });
      if (launchGate.error) throw launchGate.error;
      if (launchGate.status !== 0) return launchGate.status ?? 1;
    }
  }

  // INVARIANT: every PM2 mode uses the same queue fence. Global BullMQ pause
  // happens while Main/Gen/finalizer are still online; registered processes
  // then quiesce before the three-source checker proves that no image or video
  // consumer remains. Any failure leaves queues paused and never cleans or
  // signals an unowned process.
  const pausedAndDrained = spawn(
    "bun",
    ["run", "generation-cutover:pause-and-drain"],
    {
      cwd: productionGateCwd,
      env: runtimeEnv,
      stdio: "inherit",
    },
  );
  if (pausedAndDrained.error) throw pausedAndDrained.error;
  if (pausedAndDrained.status !== 0) {
    return pausedAndDrained.status ?? 1;
  }
  let quiescedProcesses = [];
  const quiesced = quiesceProductionProcesses(
    spawn,
    runtimeEnv,
    (processes) => {
      quiescedProcesses = processes;
    },
  );
  if (quiesced !== 0) return quiesced;
  // SPEC: orphan recovery is an explicit maintenance state. It stops after
  // queue drain and registered-process quiescence, never starts a definition,
  // runs a release action, or resumes queues. The separate recovery planner
  // must still prove exact OS process groups before an operator can signal.
  if (action === "quiesce") {
    process.stdout.write(
      "Registered PM2 quiescence established; Generation queues remain paused\n",
    );
    return 0;
  }
  const ownershipProbe =
    options.verifyGenImageWorkerOwnership ?? verifyGenImageWorkerOwnership;
  const noImageWorkers = ownershipProbe({
    expected: 0,
    expectedVideo: 0,
    mode: "quiescent",
    runtimeEnv,
    spawnSync: spawn,
  });
  if (noImageWorkers !== 0) return noImageWorkers;
  if (action === "stop") {
    const voiceStopped = stopProductionTargets(
      spawn,
      runtimeEnv,
      quiescedProcesses,
      ["fish-audio"],
    );
    if (voiceStopped !== 0) return voiceStopped;
    const finalSnapshot = readPm2ProcessList(spawn, runtimeEnv);
    if (!finalSnapshot.ok) return finalSnapshot.status;
    if (
      hasUnsafeProductionTarget(
        finalSnapshot.processes,
        productionRuntimeTargets,
      )
    ) {
      return 1;
    }
    process.stdout.write(
      "PM2 runtime stopped after Generation drain and ownership proof; queues remain paused\n",
    );
    return 0;
  }
  const gate = spawn("bun", ["run", "check:generation-cutover"], {
    cwd: productionGateCwd,
    env: runtimeEnv,
    stdio: "inherit",
  });
  if (gate.error) throw gate.error;
  if (gate.status !== 0) return gate.status ?? 1;

  if (mode === "production") {
    const definitionPlan = productionDefinitionPlan(quiescedProcesses);
    for (const name of definitionPlan.deleteNames) {
      const deleted = spawn("pm2", ["delete", name], {
        cwd: repoRoot,
        env: runtimeEnv,
        stdio: "inherit",
      });
      if (deleted.error) throw deleted.error;
      if (deleted.status !== 0) return deleted.status ?? 1;
    }
    // Snapshot-to-delete is intentionally not trusted: an app absent from the
    // quiesced snapshot could be registered concurrently and make `pm2 start`
    // reuse/merge stale definition or env. Fresh authority requires the whole
    // owned namespace to be empty immediately before ecosystem creation.
    const confirmedDeleted = readPm2ProcessList(spawn, runtimeEnv);
    if (!confirmedDeleted.ok) return confirmedDeleted.status;
    if (
      confirmedDeleted.processes.some((process) =>
        productionRuntimeTargets.includes(process?.name)
      )
    ) {
      process.stderr.write(
        "PM2 owned runtime namespace is not empty; Generation queues remain paused\n",
      );
      return 1;
    }
    definitionRecreated = definitionPlan.requiresStart;
  }

  // The retired Pocket process used the same 8062 listener as Fish Audio. PM2
  // otherwise keeps orphaned apps across ecosystem renames, so remove it before
  // starting the current topology. A missing legacy process is the normal case.
  spawn("pm2", ["delete", "pocket-tts"], {
    cwd: repoRoot,
    env: runtimeEnv,
    stdio: "ignore",
  });

  const pm2Args =
    action === "start" || definitionRecreated
      ? ["start", "ecosystem.config.js"]
      : [action, "ecosystem.config.js", "--update-env"];
  const result = spawn("pm2", pm2Args, {
    cwd: repoRoot,
    env: runtimeEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    return result.status ?? 1;
  }

  if (mode === "production") {
    const verifyRuntime =
      options.verifyProductionRuntime ??
      ((input) => verifyProductionRuntime(input));
    const runtimeReady = verifyRuntime({
      spawnSync: spawn,
      runtimeEnv,
    });
    if (runtimeReady !== 0) return runtimeReady;
  }

  const ownedImageWorkers = ownershipProbe({
    expected: positiveInstanceCount(runtimeEnv.GEN_IMAGE_INSTANCES, 2),
    // Development registers the PM2 app, but mock exits before creating a Bull
    // consumer. Production may likewise validate an exact zero-video topology.
    expectedVideo:
      mode === "development"
        ? developmentVideoWorkerCount(runtimeEnv)
        : productionVideoWorkerCount(runtimeEnv),
    mode: "ready",
    runtimeEnv,
    spawnSync: spawn,
  });
  if (ownedImageWorkers !== 0) return ownedImageWorkers;

  const resumed = spawn("bun", ["run", "generation-cutover:resume"], {
    cwd: productionGateCwd,
    env: runtimeEnv,
    stdio: "inherit",
  });
  if (resumed.error) throw resumed.error;
  return resumed.status ?? 1;
}

if (require.main === module) {
  process.exitCode = runPm2Ecosystem();
}

module.exports = {
  productionAdmissionTargets,
  productionDrainWorkerTargets,
  productionQuiescenceTargets,
  productionRuntimeTargets,
  productionGateCwd,
  productionGenCwd,
  productionProcessDefinition,
  productionDefinitionPlan,
  productionVideoWorkerCount,
  repoRoot,
  matchesProductionProcessDefinition,
  resolveCurrentPm2Mode,
  runPm2Ecosystem,
  verifyGenImageWorkerOwnership,
  verifyProductionRuntime,
};
