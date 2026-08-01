// pm2 process topology (design §12). Eight logical apps / nine processes by
// default (gen-image has two instances), graded by execution-time SLA.
// Development is the default: web apps use Next dev/Fast Refresh and source
// services use PM2 watch. Production keeps the immutable standalone web runtime.
//   bun run pm2:start              # development; no build required
//   bun run pm2:status
//   pm2 restart main-web admin-web # reload startup config/source state
//   bun run pm2:start:production   # production; build first
//   pm2 restart chat                   # single-instance: brief gap, reconciler heals
// IDREAM_PM2_MODE accepts only "development" or "production". Switching modes
// changes the process definitions, so delete/recreate the ecosystem once; normal
// source and .env changes only need Fast Refresh, PM2 watch, or pm2 restart.
// Production web apps run from immutable .next-runtime releases. Prefer restart
// after both builds are published; rolling reload still needs deployment-aware
// routing to keep old clients and workers on the same release during the overlap.
// ⚠️ chat is instances:1 — it writes the local file store (sessions/mem). Do NOT
//    scale it past 1 without moving CHAT_FS_ROOT to shared storage (D1/C1).
// ⚠️ script paths point at real node entry files (.mjs / next's CJS bin), NOT the
//    pnpm `.bin/*` shell shims — pm2's node interpreter cannot parse a /bin/sh shim
//    (and cluster mode requires a node-loadable script).
// Absolute cwds (resolved from this file's dir) so targeted `pm2 start
// ecosystem.config.js --only <app>` resolves each app's working dir — and thus its
// dotenv-loaded .env — identically to a full start. Relative cwds resolve against
// the pm2 daemon's cwd under `--only`, which silently breaks per-app .env loading.
const { existsSync, readFileSync } = require("node:fs");
const path = require("path");
const dir = (rel) => path.join(__dirname, rel);
const runtimeMode = process.env.IDREAM_PM2_MODE ?? "development";
if (runtimeMode !== "development" && runtimeMode !== "production") {
  throw new Error(
    `Invalid IDREAM_PM2_MODE "${runtimeMode}"; expected development or production`,
  );
}
const isDevelopment = runtimeMode === "development";
const sourceWatch = (...paths) =>
  isDevelopment
    ? {
        watch: paths.map(dir),
        watch_delay: 500,
      }
    : {
        watch: false,
      };
const localEnvValue = (envPath, key) => {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || match[1] !== key) continue;
    const rawValue = (match[2] ?? "").trim();
    const quote = rawValue[0];
    if ((quote === "\"" || quote === "'") && rawValue.at(-1) === quote) {
      return rawValue.slice(1, -1);
    }
    return rawValue.replace(/\s+#.*$/, "");
  }
  return undefined;
};
// REDIS_URL must resolve IDENTICALLY across main-web (which enqueues) and gen-finalizer
// (which consumes) — otherwise generation jobs stick forever. Durable Main↔Chat delivery
// does not use Redis. main's env.ts loads .env NON-overridingly, so a hardcoded fallback
// here would override .env for the pm2-injected workers while main-web kept the .env value.
// So: inject the override ONLY when it is set in the shell, and apply the SAME value to all
// three. When unset, none are injected and all three fall back to packages/main/.env.
const mainRedisUrl = process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL;
const mainRedisEnv = mainRedisUrl ? { REDIS_URL: mainRedisUrl } : {};
// INTERNAL_TOKEN is a cross-service credential, not a main-only setting. In
// deployed environments the secret manager injects it. For local pm2 runs,
// reuse the main .env value selectively so gen callbacks cannot silently run
// with an empty token while main-web validates a populated one.
const internalToken = process.env.INTERNAL_TOKEN ?? localEnvValue(dir("packages/main/.env"), "INTERNAL_TOKEN");
const sharedInternalEnv = internalToken ? { INTERNAL_TOKEN: internalToken } : {};
const mainEnvPath = dir("packages/main/.env");
const mainEnvValue = (key, fallback) =>
  process.env[key] ?? localEnvValue(mainEnvPath, key) ?? fallback;
const fishAudioApiUrl = new URL(
  mainEnvValue("FISH_AUDIO_API_URL", "http://127.0.0.1:8062/v1"),
);
const fishAudioApiToken = mainEnvValue("FISH_AUDIO_API_TOKEN");

module.exports = {
  apps: [
    // Resident Fish Audio S2 Pro MLX runtime + durable reference-voice registry.
    {
      name: "fish-audio",
      cwd: dir("."),
      script: "scripts/start-fish-audio.cjs",
      exec_mode: "fork",
      instances: 1,
      ...sourceWatch(
        "scripts/start-fish-audio.cjs",
        "scripts/fish_audio_gateway.py",
      ),
      env: {
        FISH_AUDIO_HOST: mainEnvValue("FISH_AUDIO_HOST", fishAudioApiUrl.hostname),
        FISH_AUDIO_PORT: mainEnvValue(
          "FISH_AUDIO_PORT",
          fishAudioApiUrl.port ||
            (fishAudioApiUrl.protocol === "https:" ? "443" : "80"),
        ),
        FISH_AUDIO_MODEL:
          mainEnvValue("FISH_AUDIO_MODEL", "fish-audio-s2-pro-8bit"),
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
    // fast · synchronous — public pages, characters, billing, library, chat BFF
    {
      name: "main-web",
      cwd: isDevelopment ? dir("packages/main") : dir("."),
      script: isDevelopment
        ? "node_modules/next/dist/bin/next"
        : "scripts/start-next-standalone.cjs",
      args: isDevelopment ? "dev" : "packages/main",
      exec_mode: isDevelopment ? "fork" : "cluster",
      // Was "max" → one worker per CPU core, which floods `pm2 list` on many-core
      // machines. Cap to a small fixed count (override with MAIN_WEB_INSTANCES).
      // Cluster mode still load-balances across these workers on one port.
      instances: isDevelopment ? 1 : (process.env.MAIN_WEB_INSTANCES ?? 1),
      // Next dev owns source watching/Fast Refresh. PM2 watch would fight it.
      watch: false,
      env: {
        PORT: process.env.MAIN_WEB_PORT ?? "3000",
        ...mainRedisEnv,
        ...sharedInternalEnv,
      },
      // config from packages/main/.env (next + dotenv load it)
    },
    // fast · synchronous — internal admin control plane, isolated from public web
    {
      name: "admin-web",
      cwd: isDevelopment ? dir("packages/admin") : dir("."),
      script: isDevelopment
        ? "node_modules/next/dist/bin/next"
        : "scripts/start-next-standalone.cjs",
      args: isDevelopment ? "dev" : "packages/admin",
      exec_mode: isDevelopment ? "fork" : "cluster",
      instances: 1,
      // Next dev owns source watching/Fast Refresh. PM2 watch would fight it.
      watch: false,
      env: {
        PORT: process.env.ADMIN_WEB_PORT ?? "3001",
        ...sharedInternalEnv,
      },
      // config from packages/admin/.env (next + dotenv load it)
    },
    // fast I/O + slow generation — chat/web (API+SSE) + chat/worker, one process
    {
      name: "chat",
      cwd: dir("packages/chat"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/main.ts",
      exec_mode: "fork",
      instances: 1, // ⚠️ local FS single-writer
      ...sourceWatch("packages/chat/src", "packages/shared/src"),
      env: {
        ...sharedInternalEnv,
      },
      // config from packages/chat/.env (CHAT_PORT, CHAT_DATABASE_URL, …)
    },
    // slow · async — pure generation, only writes blob, horizontally scalable
    {
      name: "gen-image",
      cwd: dir("packages/gen"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/image.ts",
      exec_mode: "fork",
      // Draw Things serializes within one worker. Set GEN_IMAGE_INSTANCES=1 for
      // strict host-wide single-process model loading; other backends may scale out.
      instances: process.env.GEN_IMAGE_INSTANCES ?? 2,
      ...sourceWatch(
        "packages/gen/src",
        "packages/gen/workflows",
        "packages/shared/src",
      ),
      env: {
        ...sharedInternalEnv,
      },
    },
    {
      name: "gen-video",
      cwd: dir("packages/gen"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/video.ts",
      exec_mode: "fork",
      instances: 1,
      // Video jobs can run for 10–30 minutes. A dev watch restart after the
      // ComfyUI submit but before manifest ingest creates an orphan prompt and
      // BullMQ retry duplicate, so this worker is always restarted explicitly.
      watch: false,
      env: {
        ...sharedInternalEnv,
      },
    },
    // medium · async — main-side authority write-back
    {
      name: "gen-finalizer",
      cwd: dir("packages/main"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/finalizer.ts",
      exec_mode: "fork",
      instances: 1,
      ...sourceWatch(
        "packages/main/src/processes",
        "packages/main/src/server",
        "packages/shared/src",
      ),
      env: {
        ...mainRedisEnv,
        ...sharedInternalEnv,
        // Finalize only — do NOT add ai.image/video.generate, or this
        // main-side process (IMAGE_PROVIDER defaults to mock) races the dedicated
        // gen-image worker (GEN_IMAGE_PROVIDER=backend) → nondeterministic mock output.
        // Character previews are owned by gen-image and return through app.ai.finalize.
      },
    },
    {
      name: "main-event-consumer",
      cwd: dir("packages/main"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/event-consumer.ts",
      exec_mode: "fork",
      instances: 1,
      ...sourceWatch(
        "packages/main/src/processes",
        "packages/main/src/server",
        "packages/shared/src",
      ),
      env: {
        ...sharedInternalEnv,
      },
    },
    // medium · async — authoritative Admin command execution and lease recovery
    {
      name: "admin-command-worker",
      cwd: dir("packages/main"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/admin-command-worker.ts",
      exec_mode: "fork",
      instances: 1,
      ...sourceWatch(
        "packages/main/src/processes",
        "packages/main/src/server",
        "packages/shared/src",
      ),
      env: {
        ...mainRedisEnv,
        ...sharedInternalEnv,
      },
    },
  ],
};
