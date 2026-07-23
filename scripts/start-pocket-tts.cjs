const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `Pocket TTS MLX requires Apple Silicon macOS; received ${process.platform}/${process.arch}`,
  );
}

const candidates = [
  process.env.UV_BIN,
  path.join(process.env.HOME || "", ".local/bin/uv"),
  path.join(process.env.HOME || "", ".langflow/uv/uv"),
  "uv",
].filter(Boolean);
const uv = candidates.find((candidate) => candidate === "uv" || existsSync(candidate));
if (!uv) {
  throw new Error("uv is required to start Pocket TTS; set UV_BIN to its executable");
}

const child = spawn(
  uv,
  [
    "run",
    "--with",
    "pocket-tts-mlx==0.2.1",
    "--with",
    "python-multipart",
    "--with",
    "fastapi",
    "--with",
    "uvicorn",
    "uvicorn",
    "scripts.pocket_tts_gateway:app",
    "--host",
    process.env.POCKET_TTS_HOST || "127.0.0.1",
    "--port",
    process.env.POCKET_TTS_PORT || "8062",
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
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
