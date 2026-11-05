const { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const defaultRoot = "/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI";
const defaultAppleSiliconFp8Patches = "tensor_to_fp8,int_mm_mps";
const videoAppleSiliconFp8Patches =
  `${defaultAppleSiliconFp8Patches},fused_norm_mps,rope_fast_mps`;
const sharedRoot = "/Users/kk/ComfyUI-Shared";
const desktopExtraModelPaths =
  "/Users/kk/Library/Application Support/Comfy Desktop/shared_model_paths.yaml";
const idreamExtraModelPaths = path.resolve(
  __dirname,
  "../packages/gen/workflows/comfy-extra-models-idream.yaml",
);

const profiles = {
  // INVARIANT: this is the exact RedGraft configuration that produced the
  // verified 121-frame video. Do not add global MPS patches here without a
  // frame-level video regression.
  video: {
    port: "8188",
    attentionArg: "--use-split-cross-attention",
    // INTENT: these compile_shader kernels work on M4 and fuse the exact
    // LTX rms_adaln/RoPE seams without enabling the failed Metal 4.1 kernels.
    appleSiliconFp8Patches: videoAppleSiliconFp8Patches,
    // INVARIANT: the workflow memory barrier uses ComfyUI's active RAM-cache
    // eviction hook to drop CPU text-loader ownership after conditioning.
    cacheArgs: ["--cache-ram", "10", "128"],
    inputDirectory: path.join(sharedRoot, "input"),
    outputDirectory: path.join(sharedRoot, "output"),
    userDirectory: path.join(sharedRoot, "user"),
  },
  // INTENT: keep image attention and model state isolated from RedGraft.
  image: {
    port: "8189",
    // INTENT: the image runner needs Qwen-Image-2.1 nodes (TextEncodeQwenImage21,
    // QwenImage21Cache) that landed after v0.34.2. It gets its own pinned
    // worktree (88ab4a06) and venv so the video runners' validated LTX/H3
    // runtime is untouched.
    root: "/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI",
    attentionArg: "--use-pytorch-cross-attention",
    // INVARIANT: image workflows use the same graph-scoped lifecycle node as
    // video; deterministic RAM-cache ownership is required for physical text
    // encoder release after all positive/negative/reference encoding finishes.
    cacheArgs: ["--cache-ram", "10", "128"],
    inputDirectory: path.join(sharedRoot, "runners/image/input"),
    outputDirectory: path.join(sharedRoot, "runners/image/output"),
    userDirectory: path.join(sharedRoot, "runners/image/user"),
  },
  // INTENT: keep H3 on exact PyTorch SDPA in its own process so its attention
  // backend and model cache cannot alter RedGraft/LTX output.
  "video-h3": {
    port: "8190",
    attentionArg: "--use-pytorch-cross-attention",
    cacheArgs: ["--cache-ram", "10", "128"],
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
  const root = env.COMFYUI_ROOT || profile.root || defaultRoot;
  const python = env.COMFYUI_VENV_PYTHON || path.join(root, ".venv/bin/python3");
  const userDirectory = env.COMFYUI_USER_DIRECTORY || profile.userDirectory;
  const inputDirectory = env.COMFYUI_INPUT_DIRECTORY || profile.inputDirectory;
  const outputDirectory = env.COMFYUI_OUTPUT_DIRECTORY || profile.outputDirectory;
  const extraModelPaths = [...new Set([
    env.COMFYUI_EXTRA_MODEL_PATHS || desktopExtraModelPaths,
    idreamExtraModelPaths,
  ])];
  const runtimeEnv = {
    ...env,
    ASFP8_ENABLE_ONLY:
      env.ASFP8_ENABLE_ONLY ||
      profile.appleSiliconFp8Patches ||
      defaultAppleSiliconFp8Patches,
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
      ...extraModelPaths,
      "--output-directory",
      outputDirectory,
      "--input-directory",
      inputDirectory,
      "--user-directory",
      userDirectory,
      profile.attentionArg,
      ...(profile.cacheArgs || []),
    ],
  };
}

const WORKFLOW_DIRECTORY = path.resolve(__dirname, "../packages/gen/workflows");
const MINIMUM_RETENTION_HOURS = 6;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const TRANSIENT_INPUT = /^idream-(?:reference|edit-mask)-[0-9a-f]{64}\.png$/;

// SPEC: how long a runner keeps its working copies. Zero means no sweep.
// INTENT: production defaults on because the guarantee has to hold without anyone
// remembering a variable. Development defaults off: these directories also hold
// benchmark evidence the research records point at, and deletion cannot be undone.
function transientRetentionMs(env = process.env) {
  const explicit = env.COMFYUI_TRANSIENT_RETENTION_HOURS;
  const production = env.APP_ENV === "production" || env.IDREAM_PM2_MODE === "production";
  const hours = explicit === undefined ? (production ? 24 : 0) : Number(explicit);
  // A prompt can queue for hours and still needs its uploaded inputs when it runs.
  if (!Number.isFinite(hours) || (hours !== 0 && hours < MINIMUM_RETENTION_HOURS)) {
    throw new Error(
      `COMFYUI_TRANSIENT_RETENTION_HOURS must be 0 or at least ${MINIMUM_RETENTION_HOURS}; received ${explicit}`,
    );
  }
  return hours * 60 * 60 * 1_000;
}

// The checked-in descriptors are the authority on what production writes, so a
// retired workflow's files and hand-run benchmarks never match.
function productionOutputPrefixes(workflowDirectory = WORKFLOW_DIRECTORY) {
  const prefixes = new Set();
  for (const file of readdirSync(workflowDirectory)) {
    if (!file.endsWith(".json")) continue;
    const { apiPrompt } = JSON.parse(readFileSync(path.join(workflowDirectory, file), "utf8"));
    for (const node of Object.values(apiPrompt ?? {})) {
      if (typeof node.inputs?.filename_prefix === "string") prefixes.add(node.inputs.filename_prefix);
    }
  }
  return [...prefixes];
}

// SPEC: Gen copies every result into Blob and uploads inputs again for each submit,
// so what the runner keeps is only a working copy. Left alone those copies hold user
// reference images and prompts past account erasure, which cannot reach this host's
// directories. A bounded lifetime is what lets erasure make a promise about them.
// INVARIANT: top-level files matching production names only, never subdirectories.
function sweepTransientFiles({ inputDirectory, outputDirectory, retentionMs, now = Date.now(), prefixes = productionOutputPrefixes() }) {
  const expired = (file) => now - statSync(file).mtimeMs >= retentionMs;
  const removed = [];
  const sweep = (directory, matches) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !matches(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (!expired(file)) continue;
      unlinkSync(file);
      removed.push(file);
    }
  };
  sweep(inputDirectory, (name) => TRANSIENT_INPUT.test(name));
  // ComfyUI's own counter suffix, so a hand-named comparison under the same prefix stays.
  sweep(outputDirectory, (name) => {
    const counted = /^(.+)_\d{5,}_\.(?:png|mp4)$/.exec(name);
    return counted !== null && prefixes.includes(counted[1]);
  });
  return removed;
}

function startTransientFileSweep(runtime, retentionMs) {
  if (retentionMs === 0) return;
  const sweep = () => {
    try {
      const removed = sweepTransientFiles({ ...runtime, retentionMs });
      if (removed.length > 0) console.log(`[comfyui-retention] removed ${removed.length} expired working files`);
    } catch (error) {
      // Never take a runner down over housekeeping; the next pass tries again.
      console.error(`[comfyui-retention] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}

function startComfyUi({ env = process.env, spawnProcess = spawn } = {}) {
  const runtime = resolveRuntime(env);
  const retentionMs = transientRetentionMs(env);
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

  startTransientFileSweep(runtime, retentionMs);

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

module.exports = {
  childExitCode,
  productionOutputPrefixes,
  resolveRuntime,
  startComfyUi,
  sweepTransientFiles,
  transientRetentionMs,
};
