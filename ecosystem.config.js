// pm2 process topology (design §12). Seven processes, graded by execution-time SLA.
// Source-run via tsx's node entry (resolves tsconfig @/ paths); web apps via
// Next standalone server output.
//   bun run pm2:start   # start all   bun run pm2:status
//   pm2 restart main-web admin-web     # after in-place Next builds
//   pm2 reload main-web admin-web      # only with immutable release dirs
//   pm2 restart chat                   # single-instance: brief gap, reconciler heals
// ⚠️ Do not `pm2 reload` web apps after rebuilding the same .next directory:
//    old cluster workers can keep references to removed server chunks.
// ⚠️ chat is instances:1 — it writes the local file store (sessions/mem). Do NOT
//    scale it past 1 without moving CHAT_FS_ROOT to shared storage (D1/C1).
// ⚠️ script paths point at real node entry files (.mjs / next's CJS bin), NOT the
//    pnpm `.bin/*` shell shims — pm2's node interpreter cannot parse a /bin/sh shim
//    (and cluster mode requires a node-loadable script).
// Absolute cwds (resolved from this file's dir) so targeted `pm2 start
// ecosystem.config.js --only <app>` resolves each app's working dir — and thus its
// dotenv-loaded .env — identically to a full start. Relative cwds resolve against
// the pm2 daemon's cwd under `--only`, which silently breaks per-app .env loading.
const path = require("path");
const dir = (rel) => path.join(__dirname, rel);
// REDIS_URL must resolve IDENTICALLY across main-web (which enqueues) and the main-side
// workers gen-finalizer / main-event-consumer (which consume) — otherwise jobs and chat→main
// events are produced on one Redis and consumed on another (split-brain: jobs stick forever,
// events silently drop). main's env.ts loads .env NON-overridingly, so a hardcoded fallback
// here would override .env for the pm2-injected workers while main-web kept the .env value.
// So: inject the override ONLY when it is set in the shell, and apply the SAME value to all
// three. When unset, none are injected and all three fall back to packages/main/.env.
const mainRedisUrl = process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL;
const mainRedisEnv = mainRedisUrl ? { REDIS_URL: mainRedisUrl } : {};

module.exports = {
  apps: [
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
        // Finalize + character.preview — do NOT add ai.image/video.generate, or this
        // main-side process (IMAGE_PROVIDER defaults to mock) races the dedicated
        // gen-image worker (GEN_IMAGE_PROVIDER=backend) → nondeterministic mock output.
        // character.preview is main-only (no gen worker owns it), so it is safe here.
        GEN_FINALIZER_QUEUES: "app.ai.finalize,character.preview",
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
      },
    },
  ],
};
