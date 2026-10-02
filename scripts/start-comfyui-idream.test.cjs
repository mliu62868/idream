const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  childExitCode,
  resolveRuntime,
} = require("./start-comfyui-idream.cjs");

test("launcher exits cleanly after its child receives the forwarded stop signal", () => {
  assert.equal(childExitCode(null, "SIGTERM"), 0);
  assert.equal(childExitCode(null, "SIGINT"), 0);
  assert.equal(childExitCode(7, null), 7);
  assert.equal(childExitCode(null, null), 1);
});

test("image runner pins its own Qwen-Image-2.1 capable ComfyUI install", () => {
  const runtime = resolveRuntime({ COMFYUI_PROFILE: "image" });
  assert.equal(
    runtime.root,
    "/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI",
  );
  assert.equal(runtime.args[runtime.args.indexOf("--port") + 1], "8189");
});

test("video runner pins the validated RedGraft LTX 2.5 MPS runtime", () => {
  const runtime = resolveRuntime({ COMFYUI_PROFILE: "video" });

  assert.equal(
    runtime.root,
    "/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI",
  );
  assert.equal(
    runtime.env.ASFP8_ENABLE_ONLY,
    "tensor_to_fp8,int_mm_mps,fused_norm_mps,rope_fast_mps",
  );
  assert.equal(runtime.env.ASFP8_FP8_EXT, "off");
  assert.equal(runtime.env.ASFP8_FP8_NATIVE, "off");
  const extraPathsIndex = runtime.args.indexOf("--extra-model-paths-config");
  assert.deepEqual(runtime.args.slice(extraPathsIndex + 1, extraPathsIndex + 3), [
    "/Users/kk/Library/Application Support/Comfy Desktop/shared_model_paths.yaml",
    path.resolve(__dirname, "../packages/gen/workflows/comfy-extra-models-idream.yaml"),
  ]);
  assert.equal(runtime.args[runtime.args.indexOf("--port") + 1], "8188");
  assert.equal(runtime.userDirectory, "/Users/kk/ComfyUI-Shared/user");
  assert.equal(
    runtime.args[runtime.args.indexOf("--user-directory") + 1],
    runtime.userDirectory,
  );
  assert.equal(
    runtime.args.filter((arg) => arg === "--use-split-cross-attention").length,
    1,
  );
  assert.deepEqual(
    runtime.args.slice(-3),
    ["--cache-ram", "10", "128"],
  );
});

test("image runner isolates state and uses the faster verified PyTorch attention", () => {
  const runtime = resolveRuntime({ COMFYUI_PROFILE: "image" });

  assert.equal(runtime.args[runtime.args.indexOf("--port") + 1], "8189");
  assert.equal(
    runtime.args.filter((arg) => arg === "--use-pytorch-cross-attention").length,
    1,
  );
  assert.equal(runtime.args.includes("--use-split-cross-attention"), false);
  assert.equal(
    runtime.env.ASFP8_ENABLE_ONLY,
    "tensor_to_fp8,int_mm_mps",
  );
  assert.match(runtime.userDirectory, /\/runners\/image\/user$/);
  assert.match(runtime.inputDirectory, /\/runners\/image\/input$/);
  assert.match(runtime.outputDirectory, /\/runners\/image\/output$/);
  assert.deepEqual(runtime.args.slice(-3), ["--cache-ram", "10", "128"]);
});

test("MiniMax H3 runner isolates exact PyTorch attention", () => {
  const runtime = resolveRuntime({ COMFYUI_PROFILE: "video-h3" });

  assert.equal(runtime.args[runtime.args.indexOf("--port") + 1], "8190");
  assert.equal(
    runtime.args.filter((arg) => arg === "--use-pytorch-cross-attention").length,
    1,
  );
  assert.equal(runtime.args.includes("--use-split-cross-attention"), false);
  assert.match(runtime.userDirectory, /\/runners\/video-h3\/user$/);
  assert.match(runtime.inputDirectory, /\/runners\/video-h3\/input$/);
  assert.match(runtime.outputDirectory, /\/runners\/video-h3\/output$/);
  assert.deepEqual(runtime.args.slice(-3), ["--cache-ram", "10", "128"]);
});

test("launcher rejects an unknown profile instead of silently sharing a runner", () => {
  assert.throws(
    () => resolveRuntime({ COMFYUI_PROFILE: "everything" }),
    /video-h3/,
  );
});

test("ComfyUI launcher passes paths as argv without a shell", () => {
  const root = "/tmp/ComfyUI instance (1)";
  const runtime = resolveRuntime({
    COMFYUI_ROOT: root,
    COMFYUI_PORT: "8199",
    COMFYUI_OUTPUT_DIRECTORY: "/tmp/output files",
    COMFYUI_USER_DIRECTORY: "/tmp/user files",
  });

  assert.equal(runtime.root, root);
  assert.equal(runtime.python, path.join(root, ".venv/bin/python3"));
  assert.deepEqual(runtime.args.slice(0, 7), [
    "-s",
    "main.py",
    "--listen",
    "127.0.0.1",
    "--port",
    "8199",
    "--extra-model-paths-config",
  ]);
  assert.equal(
    runtime.args[runtime.args.indexOf("--output-directory") + 1],
    "/tmp/output files",
  );
  assert.equal(
    runtime.args[runtime.args.indexOf("--user-directory") + 1],
    "/tmp/user files",
  );
});

test("dedicated PM2 topology keeps image, RedGraft, and H3 isolated", () => {
  const config = require("./comfyui-ecosystem.config.cjs");
  assert.deepEqual(config.apps.map((app) => app.name), [
    "comfyui-video",
    "comfyui-image",
    "comfyui-video-h3",
  ]);
  assert.deepEqual(
    config.apps.map((app) => [
      app.env.COMFYUI_PROFILE,
      app.env.COMFYUI_PORT,
      app.instances,
    ]),
    [
      ["video", "8188", 1],
      ["image", "8189", 1],
      ["video-h3", "8190", 1],
    ],
  );
});

test("the image PM2 definition replaces a saved legacy Python override", () => {
  const config = require("./comfyui-ecosystem.config.cjs");
  const image = config.apps.find((app) => app.name === "comfyui-image");
  const runtime = resolveRuntime({
    COMFYUI_VENV_PYTHON: "/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI/.venv/bin/python3",
    ...image.env,
  });
  assert.equal(runtime.python, path.join(runtime.root, ".venv/bin/python3"));
});

test("the video PM2 definition replaces stale runtime and native cache overrides", () => {
  const config = require("./comfyui-ecosystem.config.cjs");
  const video = config.apps.find((app) => app.name === "comfyui-video");
  const runtime = resolveRuntime({
    COMFYUI_ROOT: "/tmp/old-comfy",
    COMFYUI_VENV_PYTHON: "/tmp/old-python",
    TORCH_EXTENSIONS_DIR: "/tmp/old-torch-cache",
    MPS_SDPA_SKIP_CALIBRATION: "0",
    ...video.env,
  });
  assert.equal(runtime.root, "/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI");
  assert.equal(runtime.python, "/Users/kk/ComfyUI-Installs/idream-ltx25-mpsgraph/.venv/bin/python3");
  assert.equal(runtime.env.MPS_SDPA_SKIP_CALIBRATION, "1");
  assert.equal(runtime.env.TORCH_EXTENSIONS_DIR, "/Users/kk/ComfyUI-Installs/idream-ltx25-mpsgraph/torch_extensions");
  for (const app of config.apps.filter((app) => app !== video)) {
    assert.equal(app.env.MPS_SDPA_SKIP_CALIBRATION, undefined);
    assert.equal(app.env.TORCH_EXTENSIONS_DIR, undefined);
  }
});
