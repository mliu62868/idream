// pm2 process topology (design §12). Eight processes, graded by execution-time SLA.
// Source-run via tsx's node entry (resolves tsconfig @/ paths); web apps via
// Next standalone server output.
//   bun run pm2:start   # start all   bun run pm2:status
//   pm2 restart main-web admin-web     # switch both apps to their published release
//   pm2 restart chat                   # single-instance: brief gap, reconciler heals
// Web apps run from immutable .next-runtime releases. Prefer restart after both
// builds are published; rolling reload still needs deployment-aware routing to
// keep old clients and workers on the same release during the overlap window.
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
// REDIS_URL must resolve IDENTICALLY across main-web (which enqueues) and the main-side
// workers gen-finalizer / main-event-consumer (which consume) — otherwise jobs and chat→main
// events are produced on one Redis and consumed on another (split-brain: jobs stick forever,
// events silently drop). main's env.ts loads .env NON-overridingly, so a hardcoded fallback
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
const pocketTtsApiUrl = new URL(
  mainEnvValue("POCKET_TTS_API_URL", "http://127.0.0.1:8062/v1"),
);
const pocketTtsApiToken = mainEnvValue("POCKET_TTS_API_TOKEN");
const huggingFaceToken = mainEnvValue("HF_TOKEN");

module.exports = {
  apps: [
    // Apple Silicon MLX inference — Pocket TTS + durable cloned voice-state registry
    {
      name: "pocket-tts",
      cwd: dir("."),
      script: "scripts/start-pocket-tts.cjs",
      exec_mode: "fork",
      instances: 1,
      env: {
        POCKET_TTS_HOST: mainEnvValue("POCKET_TTS_HOST", pocketTtsApiUrl.hostname),
        POCKET_TTS_PORT: mainEnvValue(
          "POCKET_TTS_PORT",
          pocketTtsApiUrl.port || (pocketTtsApiUrl.protocol === "https:" ? "443" : "80"),
        ),
        POCKET_TTS_MODEL: mainEnvValue("POCKET_TTS_MODEL", "kyutai/pocket-tts"),
        POCKET_TTS_LANGUAGE: mainEnvValue("POCKET_TTS_LANGUAGE", "english"),
        POCKET_TTS_DEFAULT_VOICE_ID:
          mainEnvValue("POCKET_TTS_DEFAULT_VOICE_ID", "alba"),
        POCKET_TTS_VOICE_DIR:
          mainEnvValue("POCKET_TTS_VOICE_DIR", dir(".data/pocket-tts/voices")),
        POCKET_TTS_MLX_WARMUP_FRAMES:
          mainEnvValue("POCKET_TTS_MLX_WARMUP_FRAMES", "1"),
        ...(pocketTtsApiToken ? { POCKET_TTS_API_TOKEN: pocketTtsApiToken } : {}),
        ...(huggingFaceToken ? { HF_TOKEN: huggingFaceToken } : {}),
      },
    },
    // fast · synchronous — public pages, characters, billing, library, chat BFF
    {
      name: "main-web",
      cwd: dir("."),
      script: "scripts/start-next-standalone.cjs",
      args: "packages/main",
      exec_mode: "cluster",
      // Was "max" → one worker per CPU core, which floods `pm2 list` on many-core
      // machines. Cap to a small fixed count (override with MAIN_WEB_INSTANCES).
      // Cluster mode still load-balances across these workers on one port.
      instances: process.env.MAIN_WEB_INSTANCES ?? 1,
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
      cwd: dir("."),
      script: "scripts/start-next-standalone.cjs",
      args: "packages/admin",
      exec_mode: "cluster",
      instances: 1,
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
      env: {
        ...sharedInternalEnv,
      },
    },
    // gen-video is DEFERRED to V1.1 (video_gen flag is off; see docs/architecture/12-roadmap.md).
    // Keep it out of the running topology until a real video provider is enabled, so we
    // don't run an idle/exiting worker. Re-enable this block together with VIDEO_PROVIDER.
    // {
    //   name: "gen-video",
    //   cwd: dir("packages/gen"),
    //   script: "node_modules/tsx/dist/cli.mjs",
    //   args: "src/video.ts",
    //   exec_mode: "fork",
    //   instances: 1,
    // },
    // medium · async — main-side authority write-back
    {
      name: "gen-finalizer",
      cwd: dir("packages/main"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/finalizer.ts",
      exec_mode: "fork",
      instances: 1,
      env: {
        ...mainRedisEnv,
        ...sharedInternalEnv,
        // Finalize only — do NOT add ai.image/video.generate, or this
        // main-side process (IMAGE_PROVIDER defaults to mock) races the dedicated
        // gen-image worker (GEN_IMAGE_PROVIDER=backend) → nondeterministic mock output.
        // Character previews are owned by gen-image and return through app.ai.finalize.
        GEN_FINALIZER_QUEUES: "app.ai.finalize",
      },
    },
    {
      name: "main-event-consumer",
      cwd: dir("packages/main"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/event-consumer.ts",
      exec_mode: "fork",
      instances: 1,
      env: {
        ...mainRedisEnv,
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
      env: {
        ...mainRedisEnv,
        ...sharedInternalEnv,
      },
    },
  ],
};
