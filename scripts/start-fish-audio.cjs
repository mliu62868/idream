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
  throw new Error("uv is required to start the voice-cloning gateway; set UV_BIN to its executable");
}

// SPEC: start only from the wheels `bun run voice:fish:install` put in the uv cache.
// INTENT: the gateway runs Breeze TTS 2, which needs mlx-audio >= 0.5; oMLX's
// bundled mlx-audio predates it, so the gateway owns a hashed lock instead of
// borrowing oMLX's Python. --offline keeps a restart from crash-looping when
// PyPI or the host proxy is unreachable, same as Pocket TTS.
const child = spawn(
  uv,
  [
    "run",
    "--offline",
    "--no-project",
    "--python",
    "3.12",
    "--with-requirements",
    "scripts/breeze-tts-requirements.lock",
    "uvicorn",
    "scripts.fish_audio_gateway:app",
    "--host",
    process.env.FISH_AUDIO_HOST || "127.0.0.1",
    "--port",
    process.env.FISH_AUDIO_PORT || "8062",
  ],
  {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
  },
);

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGTERM"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
