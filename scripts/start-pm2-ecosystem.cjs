const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const productionGateCwd = path.join(repoRoot, "packages/main");
const productionGenCwd = path.join(repoRoot, "packages/gen");
const supportedActions = new Set(["start", "restart", "reload"]);
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
const productionRuntimeTargets = [
  "fish-audio",
  ...productionQuiescenceTargets,
];
const quiescedStatuses = new Set(["stopped", "errored"]);
const runtimeModes = new Set(["development", "production"]);

function productionProcessEnv(env, mode) {
  const redisUrl = env.MAIN_REDIS_URL ?? env.REDIS_URL;
  return {
    ...env,
    ...(mode ? { IDREAM_PM2_MODE: mode } : {}),
    ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
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
  try {
    const parsed = JSON.parse(listed.stdout || "[]");
    if (!Array.isArray(parsed)) return { ok: false, status: 1, processes: [] };
    return { ok: true, status: 0, processes: parsed };
  } catch {
    return { ok: false, status: 1, processes: [] };
  }
}

function processStatus(process) {
  return process && typeof process === "object" &&
    process.pm2_env && typeof process.pm2_env === "object" &&
    typeof process.pm2_env.status === "string"
    ? process.pm2_env.status
    : null;
}

function processRuntimeMarker(process) {
  const pm2Env = process && typeof process === "object"
    ? process.pm2_env
    : null;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  const marker = pm2Env.IDREAM_PM2_MODE ?? pm2Env.env?.IDREAM_PM2_MODE;
  return runtimeModes.has(marker) ? marker : null;
}

function legacyWebRuntimeMode(process) {
  if (!process || !["main-web", "admin-web"].includes(process.name)) {
    return null;
  }
  const pm2Env = process.pm2_env;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  const executable = typeof pm2Env.pm_exec_path === "string"
    ? pm2Env.pm_exec_path
    : "";
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
    productionRuntimeTargets.includes(process?.name)
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

function productionExpectedInstances(runtimeEnv) {
  return new Map(productionRuntimeTargets.map((name) => [
    name,
    name === "main-web"
      ? positiveInstanceCount(runtimeEnv.MAIN_WEB_INSTANCES, 1)
      : name === "gen-image"
        ? positiveInstanceCount(runtimeEnv.GEN_IMAGE_INSTANCES, 2)
        : 1,
  ]));
}

function runtimeIsOnline(processes, expectedInstances) {
  for (const [name, expected] of expectedInstances) {
    const instances = processes.filter((process) => process?.name === name);
    if (
      instances.length !== expected ||
      instances.some((process) => processStatus(process) !== "online")
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
    }));
    process.stderr.write(
      `Production runtime is not online; Generation queues remain paused: ${JSON.stringify(observed)}\n`,
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
      `http://127.0.0.1:${runtimeEnv.CHAT_PORT ?? "3100"}/healthz`,
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
  return processes.some((process) =>
    targets.includes(process?.name) &&
    !quiescedStatuses.has(processStatus(process))
  );
}

function quiesceProductionProcesses(spawn, runtimeEnv) {
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
  return hasUnsafeProductionTarget(
    after.processes,
    productionQuiescenceTargets,
  ) ? 1 : 0;
}

function runPm2Ecosystem(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const spawn = options.spawnSync ?? spawnSync;
  const requestedMode = args[0] ?? "development";
  const action = args[1] ?? "start";
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

  const runtimeEnv = productionProcessEnv(env, mode);
  if (mode === "production") {
    // INVARIANT: global BullMQ pause happens while Main/Gen/finalizer are still
    // online. Active provider work may finish and enqueue an immutable record
    // into the paused relay; already-ingested terminal Outbox may reach the
    // paused finalize queue. Only then are admission processes and workers
    // stopped. Every failure before the final resume remains fail-closed.
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
    const quiesced = quiesceProductionProcesses(spawn, runtimeEnv);
    if (quiesced !== 0) return quiesced;
    const gate = spawn("bun", ["run", "check:generation-cutover"], {
      cwd: productionGateCwd,
      env: runtimeEnv,
      stdio: "inherit",
    });
    if (gate.error) throw gate.error;
    if (gate.status !== 0) return gate.status ?? 1;
  }

  // The retired Pocket process used the same 8062 listener as Fish Audio. PM2
  // otherwise keeps orphaned apps across ecosystem renames, so remove it before
  // starting the current topology. A missing legacy process is the normal case.
  spawn("pm2", ["delete", "pocket-tts"], {
    cwd: repoRoot,
    env: runtimeEnv,
    stdio: "ignore",
  });

  const pm2Args = action === "start"
    ? ["start", "ecosystem.config.js"]
    : [action, "ecosystem.config.js", "--update-env"];
  const result = spawn("pm2", pm2Args, {
    cwd: repoRoot,
    env: runtimeEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || mode !== "production") {
    return result.status ?? 1;
  }

  const verifyRuntime = options.verifyProductionRuntime ??
    ((input) => verifyProductionRuntime(input));
  const runtimeReady = verifyRuntime({
    spawnSync: spawn,
    runtimeEnv,
  });
  if (runtimeReady !== 0) return runtimeReady;

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
  repoRoot,
  resolveCurrentPm2Mode,
  runPm2Ecosystem,
  verifyProductionRuntime,
};
