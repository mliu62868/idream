const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const appRoot = "/Applications/oMLX.app/Contents/Resources";
const python = process.env.FISH_AUDIO_PYTHON ||
  path.join(appRoot, "Python/cpython-3.11/bin/python3.11");
const sitePackages = path.join(
  appRoot,
  "Python/framework-mlx-base/lib/python3.11/site-packages",
);

if (!existsSync(python)) {
  throw new Error(
    "oMLX bundled Python is required to start Fish Audio; set FISH_AUDIO_PYTHON",
  );
}

const pythonPath = [
  appRoot,
  sitePackages,
  process.env.PYTHONPATH,
].filter(Boolean).join(path.delimiter);

const child = spawn(
  python,
  [
    "-m",
    "uvicorn",
    "scripts.fish_audio_gateway:app",
    "--host",
    process.env.FISH_AUDIO_HOST || "127.0.0.1",
    "--port",
    process.env.FISH_AUDIO_PORT || "8062",
  ],
  {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PYTHONPATH: pythonPath },
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
