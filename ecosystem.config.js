// pm2 process topology (design §12). Six processes, graded by execution-time SLA.
// Source-run via each package's tsx (resolves tsconfig @/ paths); main-web via next.
//   pnpm pm2:start   # start all      pnpm pm2:status
//   pm2 reload main-web                # zero-downtime (cluster only)
//   pm2 restart chat                   # single-instance: brief gap, reconciler heals
// ⚠️ chat is instances:1 — it writes the local file store (sessions/mem). Do NOT
//    scale it past 1 without moving CHAT_FS_ROOT to shared storage (D1/C1).
module.exports = {
  apps: [
    // fast · synchronous — public pages, characters, billing, library, chat BFF
    {
      name: "main-web",
      cwd: "packages/main",
      script: "node_modules/.bin/next",
      args: "start",
      exec_mode: "cluster",
      instances: "max",
      env: { PORT: 3000 },
    },
    // fast I/O + slow generation — chat/web (API+SSE) + chat/worker, one process
    {
      name: "chat",
      cwd: "packages/chat",
      script: "node_modules/.bin/tsx",
      args: "src/main.ts",
      exec_mode: "fork",
      instances: 1, // ⚠️ local FS single-writer
      env: { CHAT_PORT: 3100 },
    },
    // slow · async — pure generation, only writes blob, horizontally scalable
    {
      name: "gen-image",
      cwd: "packages/gen",
      script: "node_modules/.bin/tsx",
      args: "src/image.ts",
      exec_mode: "fork",
      instances: 2,
    },
    {
      name: "gen-video",
      cwd: "packages/gen",
      script: "node_modules/.bin/tsx",
      args: "src/video.ts",
      exec_mode: "fork",
      instances: 1,
    },
    // medium · async — main-side authority write-back
    {
      name: "gen-finalizer",
      cwd: "packages/main",
      script: "node_modules/.bin/tsx",
      args: "src/processes/finalizer.ts",
      exec_mode: "fork",
      instances: 1,
    },
    {
      name: "main-event-consumer",
      cwd: "packages/main",
      script: "node_modules/.bin/tsx",
      args: "src/processes/event-consumer.ts",
      exec_mode: "fork",
      instances: 1,
    },
  ],
};
