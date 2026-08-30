const { existsSync, mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const defaultRoot = "/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI";
const defaultAppleSiliconFp8Patches = "tensor_to_fp8,int_mm_mps";
const sharedRoot = "/Users/kk/ComfyUI-Shared";

const profiles = {
  // INVARIANT: this is the exact RedGraft configuration that produced the
  // verified 121-frame video. Do not add global MPS patches here without a
  // frame-level video regression.
  video: {
    port: "8188",
    attentionArg: "--use-split-cross-attention",
    inputDirectory: path.join(sharedRoot, "input"),
    outputDirectory: path.join(sharedRoot, "output"),
    userDirectory: path.join(sharedRoot, "user"),
  },
  // INTENT: Krea2 Identity Edit was materially faster with PyTorch attention;
  // separate state prevents that choice from changing RedGraft's math path.
  image: {
    port: "8189",
    attentionArg: "--use-pytorch-cross-attention",
    inputDirectory: path.join(sharedRoot, "runners/image/input"),
    outputDirectory: path.join(sharedRoot, "runners/image/output"),
    userDirectory: path.join(sharedRoot, "runners/image/user"),
  },
  // INTENT: keep H3 on exact PyTorch SDPA in its own process so its attention
  // backend and model cache cannot alter RedGraft/LTX output.
  "video-h3": {
    port: "8190",
    attentionArg: "--use-pytorch-cross-attention",
    inputDirectory: path.join(sharedRoot, "runners/video-h3/input"),
    outputDirectory: path.join(sharedRoot, "runners/video-h3/output"),
    userDirectory: path.join(sharedRoot, "runners/video-h3/user"),
  },
};

function resolveRuntime(env = process.env) {
  const profileName = env.COMFYUI_PROFILE || "video";
  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(
      `COMFYUI_PROFILE must be image, video, or video-h3; received ${profileName}`,
    );
  }
  const root = env.COMFYUI_ROOT || defaultRoot;
  const python = env.COMFYUI_VENV_PYTHON || path.join(root, ".venv/bin/python3");
  const userDirectory = env.COMFYUI_USER_DIRECTORY || profile.userDirectory;
  const inputDirectory = env.COMFYUI_INPUT_DIRECTORY || profile.inputDirectory;
  const outputDirectory = env.COMFYUI_OUTPUT_DIRECTORY || profile.outputDirectory;
  const runtimeEnv = {
    ...env,
    ASFP8_ENABLE_ONLY:
      env.ASFP8_ENABLE_ONLY || defaultAppleSiliconFp8Patches,
    // M4/macOS 26 cannot compile the Metal 4.1 native FP8 extension. Pinning
    // these off avoids a capability probe/build attempt on every runner start.
    ASFP8_FP8_EXT: env.ASFP8_FP8_EXT || "off",
    ASFP8_FP8_NATIVE: env.ASFP8_FP8_NATIVE || "off",
  };

  return {
    profileName,
    root,
    python,
    userDirectory,
    inputDirectory,
    outputDirectory,
    env: runtimeEnv,
    args: [
      "-s",
      "main.py",
      "--listen",
      env.COMFYUI_HOST || "127.0.0.1",
      "--port",
      env.COMFYUI_PORT || profile.port,
      "--extra-model-paths-config",
      env.COMFYUI_EXTRA_MODEL_PATHS ||
        "/Users/kk/Library/Application Support/Comfy Desktop/shared_model_paths.yaml",
      "--output-directory",
      outputDirectory,
      "--input-directory",
      inputDirectory,
      "--user-directory",
      userDirectory,
      profile.attentionArg,
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
  for (const directory of [
    runtime.userDirectory,
    runtime.inputDirectory,
    runtime.outputDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const child = spawnProcess(runtime.python, runtime.args, {
    cwd: runtime.root,
    env: runtime.env,
    stdio: "inherit",
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGTERM"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    process.exit(childExitCode(code, signal));
  });

  return child;
}

// INTENT: forwarding the child's signal back to this process re-enters the
// launcher's own signal handler and leaves PM2 stuck in "stopping" forever.
function childExitCode(code, signal) {
  return signal ? 0 : code ?? 1;
}

if (require.main === module) startComfyUi();

module.exports = { childExitCode, resolveRuntime, startComfyUi };
