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
module.exports = {
  apps: [
    // fast · synchronous — public pages, characters, billing, library, chat BFF
    {
      name: "main-web",
      cwd: ".",
      script: "scripts/start-next-standalone.cjs",
      args: "packages/main",
      exec_mode: "cluster",
      instances: "max",
      env: {
        PORT: process.env.MAIN_WEB_PORT ?? "3000",
      },
      // config from packages/main/.env (next + dotenv load it)
    },
    // fast · synchronous — internal admin control plane, isolated from public web
    {
      name: "admin-web",
      cwd: ".",
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
    // slow · local runner gateway — wraps stable-diffusion.cpp as OpenAI-compatible images
    {
      name: "sdcpp-image",
      cwd: "packages/gen",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/sdcpp-openai-image-server.ts",
      exec_mode: "fork",
      instances: 1,
      env: {
        SDCPP_IMAGE_PORT: process.env.SDCPP_IMAGE_PORT ?? "8091",
        SDCPP_IMAGE_MODEL_ID: process.env.SDCPP_IMAGE_MODEL_ID ?? "pornmaster-zimage-turbo",
        SDCPP_CLI: process.env.SDCPP_CLI ?? "/Users/kk/code/sdcpp/sd-cli",
        SDCPP_SOURCE_MODEL:
          process.env.SDCPP_SOURCE_MODEL ??
          "/Users/kk/Downloads/pornmasterZImage_turboV35Bf16.safetensors",
        SDCPP_LLM:
          process.env.SDCPP_LLM ??
          "/Users/kk/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        SDCPP_VAE:
          process.env.SDCPP_VAE ??
          "/Users/kk/.localai/models/z-image-components/split_files/vae/ae.safetensors",
        SDCPP_STEPS: process.env.SDCPP_STEPS ?? "8",
        SDCPP_MAX_COUNT: process.env.SDCPP_MAX_COUNT ?? "1",
        SDCPP_TIMEOUT_MS: process.env.SDCPP_TIMEOUT_MS ?? "300000",
      },
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
