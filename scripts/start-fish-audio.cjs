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

const model = process.env.FISH_AUDIO_MODEL || "indextts-2.5-mlx-8bit";
const requirements = {
  "indextts-2.5-mlx-8bit": "scripts/indextts-requirements.lock",
  "breeze-tts-2-mlx-8bit": "scripts/breeze-tts-requirements.lock",
}[model];
if (!requirements) throw new Error(`Unsupported voice-cloning model: ${model}`);

// Each engine owns its pinned dependencies. A restart must use the prepared
// offline cache; it must not upgrade Breeze or import the host's Python packages.
// An isolated venv also excludes packages installed next to the chosen interpreter.
const childEnv = { ...process.env };
delete childEnv.PYTHONPATH;
delete childEnv.PYTHONHOME;
childEnv.HF_HUB_OFFLINE = "1";
const child = spawn(
  uv,
  [
    "run",
    "--offline",
    "--no-project",
    "--isolated",
    "--python",
    "3.12",
    "--with-requirements",
    requirements,
    "uvicorn",
    "fish_audio_gateway:app",
    // The checkout's generated coverage/ directory shadows Numba's optional coverage import.
    "--app-dir",
    __dirname,
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
