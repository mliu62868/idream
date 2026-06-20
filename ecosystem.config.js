// pm2 process topology (design §12). Six processes, graded by execution-time SLA.
// Source-run via tsx's node entry (resolves tsconfig @/ paths); main-web via next.
//   bun run pm2:start   # start all   bun run pm2:status
//   pm2 reload main-web                # zero-downtime (cluster only)
//   pm2 restart chat                   # single-instance: brief gap, reconciler heals
// ⚠️ chat is instances:1 — it writes the local file store (sessions/mem). Do NOT
//    scale it past 1 without moving CHAT_FS_ROOT to shared storage (D1/C1).
// ⚠️ script paths point at real node entry files (.mjs / next's CJS bin), NOT the
//    pnpm `.bin/*` shell shims — pm2's node interpreter cannot parse a /bin/sh shim
//    (and cluster mode requires a node-loadable script).
module.exports = {
  apps: [
    // fast · synchronous — public pages, characters, billing, library, chat BFF
    {
      name: "main-web",
      cwd: "packages/main",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      exec_mode: "cluster",
      instances: "max",
      // config from packages/main/.env (next + dotenv load it)
    },
    // fast I/O + slow generation — chat/web (API+SSE) + chat/worker, one process
    {
      name: "chat",
      cwd: "packages/chat",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/main.ts",
      exec_mode: "fork",
      instances: 1, // ⚠️ local FS single-writer
      // config from packages/chat/.env (CHAT_PORT, CHAT_DATABASE_URL, …)
    },
    // slow · async — pure generation, only writes blob, horizontally scalable
    {
      name: "gen-image",
      cwd: "packages/gen",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/image.ts",
      exec_mode: "fork",
      instances: 2,
    },
    {
      name: "gen-video",
      cwd: "packages/gen",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/video.ts",
      exec_mode: "fork",
      instances: 1,
    },
    // medium · async — main-side authority write-back
    {
      name: "gen-finalizer",
      cwd: "packages/main",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/finalizer.ts",
      exec_mode: "fork",
      instances: 1,
    },
    {
      name: "main-event-consumer",
      cwd: "packages/main",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/processes/event-consumer.ts",
      exec_mode: "fork",
      instances: 1,
    },
  ],
};
