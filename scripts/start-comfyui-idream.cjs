const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const defaultRoot = "/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI";

function resolveRuntime(env = process.env) {
  const root = env.COMFYUI_ROOT || defaultRoot;
  const python = env.COMFYUI_VENV_PYTHON || path.join(root, ".venv/bin/python3");

  return {
    root,
    python,
    args: [
      "-s",
      "main.py",
      "--listen",
      env.COMFYUI_HOST || "127.0.0.1",
      "--port",
      env.COMFYUI_PORT || "8188",
      "--extra-model-paths-config",
      env.COMFYUI_EXTRA_MODEL_PATHS ||
        "/Users/kk/Library/Application Support/Comfy Desktop/shared_model_paths.yaml",
      "--output-directory",
      env.COMFYUI_OUTPUT_DIRECTORY || "/Users/kk/ComfyUI-Shared/output",
      "--input-directory",
      env.COMFYUI_INPUT_DIRECTORY || "/Users/kk/ComfyUI-Shared/input",
      "--user-directory",
      env.COMFYUI_USER_DIRECTORY || path.join(root, "user"),
    ],
  };
}

function startComfyUi({ env = process.env, spawnProcess = spawn } = {}) {
  const runtime = resolveRuntime(env);
  if (!existsSync(runtime.python)) {
    throw new Error(
      "ComfyUI venv Python is required; set COMFYUI_VENV_PYTHON or COMFYUI_ROOT",
    );
  }

  const child = spawnProcess(runtime.python, runtime.args, {
    cwd: runtime.root,
    env,
    stdio: "inherit",
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGTERM"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });

  return child;
}

if (require.main === module) startComfyUi();

module.exports = { resolveRuntime, startComfyUi };
