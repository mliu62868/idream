// pm2 process topology (design §12). Chat embeds the DSH/igrep runtime in its
// single Bun process; mock video omits gen-video in every mode.
// Development is the default: web apps use Next dev/Fast Refresh and source
// services use PM2 watch. Production keeps the immutable standalone web runtime.
//   bun run pm2:start              # development; no build required
//   bun run pm2:status
//   bun run pm2:restart            # detect current mode; production stays gated
//   bun run pm2:start:production   # production; build first
// Always use the gated wrapper above; direct PM2 restarts bypass queue fences.
// IDREAM_PM2_MODE accepts only "development" or "production". Switching modes
// changes the process definitions, so delete/recreate the ecosystem once; normal
// source and .env changes only need Fast Refresh, PM2 watch, or `bun run pm2:restart`.
// Production web apps run from immutable .next-runtime releases. Prefer restart
// after both builds are published; rolling reload still needs deployment-aware
// routing to keep old clients and workers on the same release during the overlap.
// ⚠️ chat is instances:1 — each AgentRun has one local-file writer.
//    Product Turn/Scene/attachment authority stays in Main PostgreSQL; generic
//    memory lives in the DSH/igrep workspace. Do NOT scale it past 1 without
//    shared storage plus explicit per-run writer arbitration.
// ⚠️ Every first-party JavaScript/TypeScript/Next process uses Bun as PM2's
//    interpreter. Voice-runtime Bun wrappers own their Python Uvicorn children;
//    PM2 remains the lifecycle manager and queue-fence authority.
// Absolute cwds (resolved from this file's dir) so targeted `pm2 start
// ecosystem.config.js --only <app>` resolves each app's working dir — and thus its
// dotenv-loaded .env — identically to a full start. Relative cwds resolve against
// the pm2 daemon's cwd under `--only`, which silently breaks per-app .env loading.
const { existsSync, readFileSync } = require("node:fs");
const path = require("path");
const {
  assertRuntimeMode,
  createRuntimeTopology,
  runtimeIdentityEnvironment,
} = require("./scripts/runtime-topology.cjs");
const dir = (rel) => path.join(__dirname, rel);
const bunInterpreter = [
  process.env.BUN_EXEC_PATH,
  process.env.BUN_INSTALL
    ? path.join(process.env.BUN_INSTALL, "bin", "bun")
    : undefined,
  process.env.HOME
    ? path.join(process.env.HOME, ".bun", "bin", "bun")
    : undefined,
].find((candidate) => candidate && existsSync(candidate)) ?? "bun";
const runtimeMode = process.env.IDREAM_PM2_MODE ?? "development";
assertRuntimeMode(runtimeMode);
const isDevelopment = runtimeMode === "development";
const localEnvValue = (envPath, key) => {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || match[1] !== key) continue;
    const rawValue = (match[2] ?? "").trim();
    const quote = rawValue[0];
    if ((quote === '"' || quote === "'") && rawValue.at(-1) === quote) {
      return rawValue.slice(1, -1);
    }
    return rawValue.replace(/\s+#.*$/, "");
  }
  return undefined;
};
// Gen loads packages/gen/.env without overriding the shell. Resolve topology
// through that same authority so PM2 never registers a mock worker that exits
// before creating the Bull consumer the wrapper expects to count.
const genVideoProvider =
  process.env.GEN_VIDEO_PROVIDER ??
  localEnvValue(dir("packages/gen/.env"), "GEN_VIDEO_PROVIDER") ??
  "mock";
// REDIS_URL must resolve IDENTICALLY across main-web (which enqueues) and gen-finalizer
// (which consumes) — otherwise generation jobs stick forever. Durable Main↔Chat delivery
// does not use Redis. Which vars are cross-service, and their one set of defaults, is
// defined in packages/shared/src/contracts/env.ts — that file is the SSoT; what follows
// is only the pm2-specific mechanics of getting the same value into three processes.
// main's env.ts loads .env NON-overridingly, so a hardcoded fallback here would override
// .env for the pm2-injected workers while main-web kept the .env value. So: inject the
// override ONLY when it is set in the shell, and apply the SAME value to all three.
// When unset, none are injected and all three fall back to packages/main/.env.
const mainRedisUrl = process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL;
const mainRedisEnv = mainRedisUrl ? { REDIS_URL: mainRedisUrl } : {};
// INTERNAL_TOKEN is a cross-service credential, not a main-only setting. In
// deployed environments the secret manager injects it. For local pm2 runs,
// reuse the main .env value selectively so gen callbacks cannot silently run
// with an empty token while main-web validates a populated one.
const internalToken =
  process.env.INTERNAL_TOKEN ??
  localEnvValue(dir("packages/main/.env"), "INTERNAL_TOKEN");
const sharedInternalEnv = internalToken
  ? { INTERNAL_TOKEN: internalToken }
  : {};
const mainEnvPath = dir("packages/main/.env");
const mainEnvValue = (key, fallback) =>
  process.env[key] ?? localEnvValue(mainEnvPath, key) ?? fallback;
const fishAudioApiUrl = new URL(
  mainEnvValue("FISH_AUDIO_API_URL", "http://127.0.0.1:8062/v1"),
);
const fishAudioApiToken = mainEnvValue("FISH_AUDIO_API_TOKEN");
const pocketTtsApiUrl = new URL(
  mainEnvValue("POCKET_TTS_API_URL", "http://127.0.0.1:8063/v1"),
);
const pocketTtsApiToken = mainEnvValue("POCKET_TTS_API_TOKEN");
const topologyEnvironment = {
  ...process.env,
  VOICE_PROVIDER: mainEnvValue("VOICE_PROVIDER", "pocket-tts"),
  VOICE_IDENTITY_PROVIDER: mainEnvValue("VOICE_IDENTITY_PROVIDER"),
};
const runtimeTopology = createRuntimeTopology({
  repoRoot: __dirname,
  bunInterpreter,
  mode: runtimeMode,
  environment: topologyEnvironment,
  videoProvider: genVideoProvider,
});
const runtimeIdentityEnv = runtimeIdentityEnvironment({
  mode: runtimeMode,
  sourceRevision: process.env.IDREAM_SOURCE_REVISION,
  sentryRelease: process.env.SENTRY_RELEASE,
});
const runtimeProcess = (name) => {
  const definition = runtimeTopology.definition(name);
  if (!definition) throw new Error(`Unknown PM2 runtime process ${name}`);
  return {
    name: definition.name,
    cwd: definition.cwd,
    script: definition.script,
    ...(definition.args.length === 0
      ? {}
      : {
          args: definition.args.length === 1
            ? definition.args[0]
            : definition.args,
        }),
    interpreter: definition.execInterpreter,
    exec_mode: definition.ecosystemExecMode,
    instances: definition.instances,
    watch: definition.watch,
    ...(definition.watchDelay
      ? { watch_delay: definition.watchDelay }
      : {}),
    ...(definition.killTimeout
      ? { kill_timeout: definition.killTimeout }
      : {}),
  };
};

module.exports = {
  apps: [
    // Optional Fish Audio S2 Pro MLX runtime + durable reference-voice registry.
    {
      ...runtimeProcess("fish-audio"),
      env: {
        ...runtimeIdentityEnv,
        FISH_AUDIO_HOST: mainEnvValue(
          "FISH_AUDIO_HOST",
          fishAudioApiUrl.hostname,
        ),
        FISH_AUDIO_PORT: mainEnvValue(
          "FISH_AUDIO_PORT",
          fishAudioApiUrl.port ||
            (fishAudioApiUrl.protocol === "https:" ? "443" : "80"),
        ),
        FISH_AUDIO_MODEL: mainEnvValue(
          "FISH_AUDIO_MODEL",
          "fish-audio-s2-pro-8bit",
        ),
        FISH_AUDIO_MODEL_PATH: mainEnvValue(
          "FISH_AUDIO_MODEL_PATH",
          path.join(
            process.env.HOME || __dirname,
            ".omlx/models/mlx-community/fish-audio-s2-pro-8bit",
          ),
        ),
        FISH_AUDIO_LANGUAGE: mainEnvValue("FISH_AUDIO_LANGUAGE", "auto"),
        FISH_AUDIO_DEFAULT_VOICE_ID: mainEnvValue(
          "FISH_AUDIO_DEFAULT_VOICE_ID",
          "fish-female-default",
        ),
        FISH_AUDIO_SYSTEM_REFERENCE_AUDIO: mainEnvValue(
          "FISH_AUDIO_SYSTEM_REFERENCE_AUDIO",
          dir(".data/fish-audio/system/female-reference.wav"),
        ),
        FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST: mainEnvValue(
          "FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST",
          dir(".data/fish-audio/system/female-reference.json"),
        ),
        FISH_AUDIO_VOICE_DIR: mainEnvValue(
          "FISH_AUDIO_VOICE_DIR",
          dir(".data/fish-audio/voices"),
        ),
        ...(fishAudioApiToken
          ? { FISH_AUDIO_API_TOKEN: fishAudioApiToken }
          : {}),
      },
    },
    // Official Pocket TTS CPU runtime for default English speech and role voices.
    {
      ...runtimeProcess("pocket-tts"),
      env: {
        ...runtimeIdentityEnv,
        POCKET_TTS_HOST: mainEnvValue(
          "POCKET_TTS_HOST",
          pocketTtsApiUrl.hostname,
        ),
        POCKET_TTS_PORT: mainEnvValue(
          "POCKET_TTS_PORT",
          pocketTtsApiUrl.port ||
            (pocketTtsApiUrl.protocol === "https:" ? "443" : "80"),
        ),
        POCKET_TTS_MODEL: mainEnvValue("POCKET_TTS_MODEL", "pocket-tts"),
        POCKET_TTS_MODEL_REVISION: mainEnvValue(
          "POCKET_TTS_MODEL_REVISION",
          "39592ff23c9ef80098bb74895d104c26275fe2c9",
        ),
        POCKET_TTS_LANGUAGE: mainEnvValue("POCKET_TTS_LANGUAGE", "english"),
        POCKET_TTS_DEFAULT_VOICE_ID: mainEnvValue(
          "POCKET_TTS_DEFAULT_VOICE_ID",
          "alba",
        ),
        POCKET_TTS_VOICE_DIR: mainEnvValue(
          "POCKET_TTS_VOICE_DIR",
          dir(".data/pocket-tts/voices"),
        ),
        POCKET_TTS_IDEMPOTENCY_DIR: mainEnvValue(
          "POCKET_TTS_IDEMPOTENCY_DIR",
          dir(".data/pocket-tts/idempotency"),
        ),
        ...(pocketTtsApiToken
          ? { POCKET_TTS_API_TOKEN: pocketTtsApiToken }
          : {}),
        ...(process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {}),
      },
    },
    // fast · synchronous — public pages, characters, billing, library, chat BFF
    {
      ...runtimeProcess("main-web"),
      // Was "max" → one worker per CPU core, which floods `pm2 list` on many-core
      // machines. Cap to a small fixed count (override with MAIN_WEB_INSTANCES).
      // Cluster mode still load-balances across these workers on one port.
      env: {
        ...runtimeIdentityEnv,
        IDREAM_PM2_BUN_ENTRYPOINT: isDevelopment
          ? "main-development"
          : "next-standalone",
        ...(!isDevelopment
          ? { IDREAM_NEXT_PACKAGE_PATH: "packages/main" }
          : {}),
        PORT: process.env.MAIN_WEB_PORT ?? "3000",
        ...(isDevelopment
          ? {
              IDREAM_NEXT_DEVELOPMENT: "1",
              IDREAM_NEXT_DIST_DIR: ".next-development",
            }
          : {}),
        ...mainRedisEnv,
        ...sharedInternalEnv,
      },
      // config from packages/main/.env (next + dotenv load it)
    },
    // fast · synchronous — internal admin control plane, isolated from public web
    {
      ...runtimeProcess("admin-web"),
      env: {
        ...runtimeIdentityEnv,
        IDREAM_PM2_BUN_ENTRYPOINT: isDevelopment
          ? "admin-development"
          : "next-standalone",
        ...(!isDevelopment
          ? { IDREAM_NEXT_PACKAGE_PATH: "packages/admin" }
          : {}),
        PORT: process.env.ADMIN_WEB_PORT ?? "3001",
        ...(isDevelopment
          ? {
              IDREAM_NEXT_DEVELOPMENT: "1",
              IDREAM_NEXT_DIST_DIR: ".next-development",
            }
          : {}),
        ...sharedInternalEnv,
      },
      // config from packages/admin/.env (next + dotenv load it)
    },
    // fast I/O + slow generation — chat/web (API+SSE) + chat/worker, one process
    {
      ...runtimeProcess("chat"), // ⚠️ local FS single-writer
      // Warm model calls and active generations are allowed to finish after
      // admission closes; PM2 must not cut the process off at its 1.6s default.
      env: {
        ...runtimeIdentityEnv,
        ...sharedInternalEnv,
      },
      // config from packages/chat/.env (CHAT_PORT, CHAT_FS_ROOT, …)
    },
    // slow · async — pure generation, only writes blob, horizontally scalable
    {
      ...runtimeProcess("gen-image"),
      // One Apple GPU/unified-memory authority per host. The worker-level lease
      // also serializes against gen-video; extra image workers only add resident
      // model pressure, so scaling out must be an explicit operator decision.
      // Provider calls may outlive PM2's default kill window. Queue pause/drain
      // should make this idle; this is the last fail-safe against mid-job kill.
      env: {
        ...runtimeIdentityEnv,
        ...sharedInternalEnv,
        COMFYUI_IMAGE_API_URL:
          process.env.COMFYUI_IMAGE_API_URL ??
          localEnvValue(dir("packages/gen/.env"), "COMFYUI_IMAGE_API_URL") ??
          "http://127.0.0.1:8189",
        ...(process.env.GEN_IMAGE_WORKER_RUN_ID
          ? { GEN_IMAGE_WORKER_RUN_ID: process.env.GEN_IMAGE_WORKER_RUN_ID }
          : {}),
      },
    },
    ...(runtimeTopology.enabled("gen-video")
      ? [
          {
            ...runtimeProcess("gen-video"),
            // Video jobs can run for 10–30 minutes. A dev watch restart after the
            // ComfyUI submit but before manifest ingest creates an orphan prompt and
            // BullMQ retry duplicate, so runtime-topology keeps this worker off watch.
            env: {
              ...runtimeIdentityEnv,
              ...sharedInternalEnv,
              COMFYUI_VIDEO_API_URL:
                process.env.COMFYUI_VIDEO_API_URL ??
                localEnvValue(dir("packages/gen/.env"), "COMFYUI_VIDEO_API_URL") ??
                "http://127.0.0.1:8188",
              COMFYUI_H3_API_URL:
                process.env.COMFYUI_H3_API_URL ??
                localEnvValue(dir("packages/gen/.env"), "COMFYUI_H3_API_URL") ??
                "http://127.0.0.1:8190",
              ...(process.env.GEN_VIDEO_WORKER_RUN_ID
                ? { GEN_VIDEO_WORKER_RUN_ID: process.env.GEN_VIDEO_WORKER_RUN_ID }
                : {}),
            },
          },
        ]
      : []),
    // medium · async — main-side authority write-back
    {
      ...runtimeProcess("gen-finalizer"),
      env: {
        ...runtimeIdentityEnv,
        ...mainRedisEnv,
        ...sharedInternalEnv,
        // Finalize only — image/video provider execution is owned exclusively by
        // the dedicated Gen workers through GEN_IMAGE_PROVIDER/GEN_VIDEO_PROVIDER.
        // Character previews are owned by gen-image and return through app.ai.finalize.
      },
    },
    {
      ...runtimeProcess("main-event-consumer"),
      env: {
        ...runtimeIdentityEnv,
        ...sharedInternalEnv,
      },
    },
    // medium · async — authoritative Admin command execution and lease recovery
    {
      ...runtimeProcess("admin-command-worker"),
      env: {
        ...runtimeIdentityEnv,
        ...mainRedisEnv,
        ...sharedInternalEnv,
      },
    },
  ].filter((app) => runtimeTopology.enabled(app.name)),
};
