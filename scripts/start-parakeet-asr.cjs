const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const candidates = [
  process.env.UV_BIN,
  path.join(process.env.HOME || "", ".local/bin/uv"),
  path.join(process.env.HOME || "", ".langflow/uv/uv"),
  "uv",
].filter(Boolean);
const uv = candidates.find((candidate) => candidate === "uv" || existsSync(candidate));
if (!uv) {
  throw new Error("uv is required to start Parakeet ASR; set UV_BIN to its executable");
}

// SPEC: start only from the wheels `bun run voice:asr:install` put in the uv cache.
// INTENT: without --offline uv revalidates the PyPI index once its HTTP cache
// expires, so a restart with PyPI or the host proxy unreachable exits and PM2
// crash-loops the resident voice runtime. uv still resolves the hashed lock
// from cache; a lock change fails here until install runs again.
const child = spawn(
  uv,
  [
    "run",
    "--offline",
    "--no-project",
    "--python",
    "3.12",
    "--with-requirements",
    "scripts/parakeet-asr-requirements.lock",
    "uvicorn",
    "scripts.parakeet_asr_gateway:app",
    "--workers",
    "1",
    "--host",
    process.env.PARAKEET_ASR_HOST || "127.0.0.1",
    "--port",
    process.env.PARAKEET_ASR_PORT || "8064",
  ],
  {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    stdio: "inherit",
  },
);

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
