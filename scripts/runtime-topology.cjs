const path = require("node:path");

const RUNTIME_CERTIFICATION = Object.freeze({
  development: "non-certifying-source-watch",
  production: "revision-bound-immutable",
});

const runtimeModes = new Set(Object.keys(RUNTIME_CERTIFICATION));

// SPEC: This table is the sole structural authority for first-party PM2
// processes. ecosystem.config.js materializes it; the gated wrapper verifies
// the same facts before it is allowed to resume Generation queues.
const processSpecs = Object.freeze([
  {
    name: "fish-audio",
    roles: ["voice"],
    definitionPlan: true,
    modes: {
      development: { cwd: ".", script: "scripts/start-fish-audio.cjs", execMode: "fork" },
      production: { cwd: ".", script: "scripts/start-fish-audio.cjs", execMode: "fork" },
    },
    watchPaths: ["scripts/start-fish-audio.cjs", "scripts/fish_audio_gateway.py"],
  },
  {
    name: "pocket-tts",
    roles: ["voice"],
    // Pocket is recreated after every fenced transition so model credentials
    // cannot remain inherited from the PM2 daemon.
    definitionPlan: false,
    modes: {
      development: { cwd: ".", script: "scripts/start-pocket-tts.cjs", execMode: "fork" },
      production: { cwd: ".", script: "scripts/start-pocket-tts.cjs", execMode: "fork" },
    },
    watchPaths: [
      "scripts/start-pocket-tts.cjs",
      "scripts/pocket_tts_gateway.py",
      "scripts/pocket-tts-requirements.in",
      "scripts/pocket-tts-requirements.lock",
    ],
    killTimeout: 60_000,
  },
  {
    name: "main-web",
    roles: ["admission"],
    definitionPlan: true,
    instancePolicy: "main-web",
    modes: {
      development: { cwd: "packages/main", script: "scripts/start-development.cjs", execMode: "fork" },
      production: { cwd: ".", script: "scripts/start-next-standalone.cjs", args: ["packages/main"], execMode: "cluster" },
    },
  },
  {
    name: "admin-web",
    roles: ["admission"],
    definitionPlan: true,
    modes: {
      development: { cwd: "packages/admin", script: "scripts/start-development.cjs", execMode: "fork" },
      production: { cwd: ".", script: "scripts/start-next-standalone.cjs", args: ["packages/admin"], execMode: "cluster" },
    },
  },
  {
    name: "chat",
    roles: ["admission"],
    definitionPlan: true,
    modes: {
      development: { cwd: "packages/chat", script: "src/main.ts", execMode: "fork" },
      production: { cwd: "packages/chat", script: "dist/main.js", execMode: "fork" },
    },
    watchPaths: ["packages/chat/src", "packages/shared/src"],
    killTimeout: 5 * 60 * 1_000,
  },
  {
    name: "gen-image",
    roles: ["drain"],
    generationWorkerKind: "image",
    definitionPlan: true,
    instancePolicy: "gen-image",
    modes: {
      development: { cwd: "packages/gen", script: "src/image.ts", execMode: "fork" },
      production: { cwd: "packages/gen", script: "dist/image.js", execMode: "fork" },
    },
    watchPaths: ["packages/gen/src", "packages/gen/workflows", "packages/shared/src"],
    killTimeout: 5 * 60 * 1_000,
  },
  {
    name: "gen-video",
    roles: ["drain"],
    generationWorkerKind: "video",
    definitionPlan: true,
    instancePolicy: "gen-video",
    modes: {
      development: { cwd: "packages/gen", script: "src/video.ts", execMode: "fork" },
      production: { cwd: "packages/gen", script: "dist/video.js", execMode: "fork" },
    },
    // A source watch can interrupt a 10-30 minute provider invocation.
    watchPaths: [],
    killTimeout: 35 * 60 * 1_000,
  },
  {
    name: "gen-finalizer",
    roles: ["drain"],
    definitionPlan: true,
    modes: {
      development: { cwd: "packages/main", script: "src/processes/finalizer.ts", execMode: "fork" },
      production: { cwd: "packages/main", script: "dist/finalizer.js", execMode: "fork" },
    },
    watchPaths: ["packages/main/src/processes", "packages/main/src/server", "packages/shared/src"],
    killTimeout: 5 * 60 * 1_000,
  },
  {
    name: "main-event-consumer",
    roles: ["admission"],
    definitionPlan: true,
    modes: {
      development: { cwd: "packages/main", script: "src/processes/event-consumer.ts", execMode: "fork" },
      production: { cwd: "packages/main", script: "dist/event-consumer.js", execMode: "fork" },
    },
    watchPaths: ["packages/main/src/processes", "packages/main/src/server", "packages/shared/src"],
  },
  {
    name: "admin-command-worker",
    roles: ["admission"],
    definitionPlan: true,
    modes: {
      development: { cwd: "packages/main", script: "src/processes/admin-command-worker.ts", execMode: "fork" },
      production: { cwd: "packages/main", script: "dist/admin-command-worker.js", execMode: "fork" },
    },
    watchPaths: ["packages/main/src/processes", "packages/main/src/server", "packages/shared/src"],
  },
]);

function assertRuntimeMode(mode) {
  if (!runtimeModes.has(mode)) {
    throw new Error(`Invalid IDREAM_PM2_MODE "${mode}"; expected development or production`);
  }
  return mode;
}

function positiveInstanceCount(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredVoiceRuntimeTargets(environment) {
  const configured = [
    environment.VOICE_PROVIDER ?? "pocket-tts",
    environment.VOICE_IDENTITY_PROVIDER,
  ];
  return namesWithRole("voice").filter((name) => configured.includes(name));
}

function videoWorkerCount(mode, provider) {
  assertRuntimeMode(mode);
  const resolved = provider ?? "mock";
  if (resolved === "mock") return 0;
  if (resolved === "backend" || (mode === "development" && resolved === "pipeline")) {
    return 1;
  }
  const allowed = mode === "development" ? "mock, backend or pipeline" : "mock or backend";
  throw new Error(
    `${mode === "development" ? "Development" : "Production"} video worker topology requires GEN_VIDEO_PROVIDER=${allowed}, received ${resolved}`,
  );
}

function namesWithRole(role) {
  return processSpecs.filter((spec) => spec.roles.includes(role)).map((spec) => spec.name);
}

function runtimeIdentityEnvironment(input) {
  const mode = assertRuntimeMode(input.mode);
  return {
    IDREAM_PM2_MODE: mode,
    IDREAM_RUNTIME_CERTIFICATION: RUNTIME_CERTIFICATION[mode],
    ...(input.sourceRevision
      ? { IDREAM_SOURCE_REVISION: input.sourceRevision }
      : {}),
    ...(input.sentryRelease ? { SENTRY_RELEASE: input.sentryRelease } : {}),
  };
}

function createRuntimeTopology(input) {
  const mode = assertRuntimeMode(input.mode);
  const environment = input.environment ?? {};
  const videoProvider = input.videoProvider ?? environment.GEN_VIDEO_PROVIDER ?? "mock";
  const voiceTargets = new Set(configuredVoiceRuntimeTargets(environment));
  const byName = new Map(processSpecs.map((spec) => [spec.name, spec]));

  const instanceCount = (name) => {
    const spec = byName.get(name);
    if (!spec) return null;
    if (spec.instancePolicy === "main-web") {
      return mode === "development"
        ? 1
        : positiveInstanceCount(environment.MAIN_WEB_INSTANCES, 1);
    }
    if (spec.instancePolicy === "gen-image") {
      return positiveInstanceCount(environment.GEN_IMAGE_INSTANCES, 1);
    }
    if (spec.instancePolicy === "gen-video") {
      return videoWorkerCount(mode, videoProvider);
    }
    return 1;
  };

  const enabled = (name) => {
    const spec = byName.get(name);
    if (!spec) return false;
    if (spec.roles.includes("voice")) return voiceTargets.has(name);
    if (name === "gen-video") return instanceCount(name) > 0;
    return true;
  };

  const definition = (name) => {
    const spec = byName.get(name);
    if (!spec) return null;
    const modeDefinition = spec.modes[mode];
    const cwd = path.resolve(input.repoRoot, modeDefinition.cwd);
    const args = [...(modeDefinition.args ?? [])];
    const watch = mode === "development" && spec.watchPaths?.length
      ? spec.watchPaths.map((entry) => path.resolve(input.repoRoot, entry))
      : false;
    return {
      name,
      cwd,
      script: modeDefinition.script,
      execPath: path.resolve(cwd, modeDefinition.script),
      args,
      execInterpreter: input.bunInterpreter,
      execMode: `${modeDefinition.execMode}_mode`,
      ecosystemExecMode: modeDefinition.execMode,
      instances: instanceCount(name),
      watch,
      ...(watch === false ? {} : { watchDelay: 500 }),
      ...(spec.killTimeout ? { killTimeout: spec.killTimeout } : {}),
    };
  };

  const generationWorkerDefinition = (kind) => {
    const spec = processSpecs.find(
      (candidate) => candidate.generationWorkerKind === kind,
    );
    return spec ? definition(spec.name) : null;
  };

  return {
    mode,
    certification: RUNTIME_CERTIFICATION[mode],
    processNames: processSpecs.map((spec) => spec.name),
    enabledProcessNames: processSpecs.filter((spec) => enabled(spec.name)).map((spec) => spec.name),
    admissionTargets: namesWithRole("admission"),
    drainWorkerTargets: namesWithRole("drain"),
    voiceRuntimeTargets: namesWithRole("voice"),
    definitionPlanTargets: ["voice", "admission", "drain"].flatMap((role) =>
      processSpecs
        .filter((spec) => spec.definitionPlan && spec.roles.includes(role))
        .map((spec) => spec.name)
    ),
    configuredVoiceRuntimeTargets: [...voiceTargets],
    definition,
    generationWorkerDefinition,
    enabled,
    instanceCount,
  };
}

function normalizePm2Args(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function processRuntimeMarker(process) {
  const pm2Env = process?.pm2_env;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  const marker = pm2Env.IDREAM_PM2_MODE ?? pm2Env.env?.IDREAM_PM2_MODE;
  return runtimeModes.has(marker) ? marker : null;
}

function processCertificationMarker(process) {
  const pm2Env = process?.pm2_env;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  return pm2Env.IDREAM_RUNTIME_CERTIFICATION ??
    pm2Env.env?.IDREAM_RUNTIME_CERTIFICATION ??
    null;
}

function processSourceRevision(process) {
  const pm2Env = process?.pm2_env;
  if (!pm2Env || typeof pm2Env !== "object") return null;
  return pm2Env.IDREAM_SOURCE_REVISION ?? pm2Env.env?.IDREAM_SOURCE_REVISION ?? null;
}

function matchesRuntimeProcessDefinition(process, topology, options = {}) {
  const definition = topology.definition(process?.name);
  const pm2Env = process?.pm2_env;
  if (!definition || !pm2Env || typeof pm2Env !== "object") return false;
  const expectedRevision = options.sourceRevision?.trim();
  return pm2Env.pm_cwd === definition.cwd &&
    pm2Env.pm_exec_path === definition.execPath &&
    JSON.stringify(normalizePm2Args(pm2Env.args)) === JSON.stringify(definition.args) &&
    JSON.stringify(normalizePm2Args(pm2Env.node_args)) === "[]" &&
    (definition.execInterpreter === undefined || pm2Env.exec_interpreter === definition.execInterpreter) &&
    pm2Env.exec_mode === definition.execMode &&
    JSON.stringify(pm2Env.watch ?? false) === JSON.stringify(definition.watch) &&
    processRuntimeMarker(process) === topology.mode &&
    processCertificationMarker(process) === topology.certification &&
    (!expectedRevision || processSourceRevision(process) === expectedRevision);
}

module.exports = {
  RUNTIME_CERTIFICATION,
  assertRuntimeMode,
  configuredVoiceRuntimeTargets,
  createRuntimeTopology,
  matchesRuntimeProcessDefinition,
  namesWithRole,
  normalizePm2Args,
  positiveInstanceCount,
  processCertificationMarker,
  processRuntimeMarker,
  processSourceRevision,
  runtimeIdentityEnvironment,
  videoWorkerCount,
};
