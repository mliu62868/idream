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

const model = process.env.FISH_AUDIO_MODEL || "ming-3.0-tts-0.5b-8bit";
const requirements = {
  "ming-3.0-tts-0.5b-8bit": "scripts/ming-tts-requirements.lock",
  "breeze-tts-2-mlx-8bit": "scripts/breeze-tts-requirements.lock",
}[model];
if (!requirements) throw new Error(`Unsupported voice-cloning model: ${model}`);

// Each engine owns its pinned dependencies. A restart must use the prepared
// offline cache; it must not upgrade Breeze or import the host's Python packages.
// The locked Python environment must not import packages from another runtime.
const childEnv = { ...process.env };
delete childEnv.PYTHONPATH;
delete childEnv.PYTHONHOME;
const child = spawn(
  uv,
  [
    "run",
    "--offline",
    "--no-project",
    "--python",
    "3.12",
    "--with-requirements",
    requirements,
    "uvicorn",
    "scripts.fish_audio_gateway:app",
    "--host",
    process.env.FISH_AUDIO_HOST || "127.0.0.1",
    "--port",
    process.env.FISH_AUDIO_PORT || "8062",
  ],
  {
    cwd: path.resolve(__dirname, ".."),
    env: childEnv,
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
