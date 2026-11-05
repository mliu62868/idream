const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");

const {
  childExitCode,
  productionOutputPrefixes,
  resolveRuntime,
  sweepTransientFiles,
  transientRetentionMs,
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

test("working-file retention is on in production and off by default in development", () => {
  const day = 24 * 60 * 60 * 1_000;
  assert.equal(transientRetentionMs({}), 0);
  assert.equal(transientRetentionMs({ APP_ENV: "production" }), day);
  assert.equal(transientRetentionMs({ IDREAM_PM2_MODE: "production" }), day);
  assert.equal(transientRetentionMs({ COMFYUI_TRANSIENT_RETENTION_HOURS: "48" }), 2 * day);
  assert.equal(transientRetentionMs({ APP_ENV: "production", COMFYUI_TRANSIENT_RETENTION_HOURS: "0" }), 0);
  // Shorter than a prompt can sit in the queue would pull inputs out from under it.
  assert.throws(() => transientRetentionMs({ COMFYUI_TRANSIENT_RETENTION_HOURS: "1" }), /at least 6/);
  assert.throws(() => transientRetentionMs({ COMFYUI_TRANSIENT_RETENTION_HOURS: "soon" }), /must be 0/);
});

test("every production workflow's output prefix is known to the sweep", () => {
  const prefixes = productionOutputPrefixes();
  for (const expected of ["idream_redcraft_qw21t", "idream-redgraft-ltx25", "idream-minimax-h3-mystic", "idream-enhance-2x"]) {
    assert.ok(prefixes.includes(expected), expected);
  }
});

test("the sweep removes only expired production working files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "idream-comfy-retention-"));
  try {
    const inputDirectory = path.join(root, "input");
    const outputDirectory = path.join(root, "output");
    mkdirSync(inputDirectory);
    mkdirSync(path.join(outputDirectory, "h3-benchmark-20261024"), { recursive: true });
    const now = Date.parse("2030-01-02T00:00:00.000Z");
    const place = (directory, name, ageMs) => {
      const file = path.join(directory, name);
      writeFileSync(file, "x");
      utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
    };
    const hour = 60 * 60 * 1_000;
    const hash = "a".repeat(64);
    place(inputDirectory, `idream-reference-${hash}.png`, 25 * hour);
    place(inputDirectory, `idream-edit-mask-${hash}.png`, 25 * hour);
    place(inputDirectory, `idream-reference-${"b".repeat(64)}.png`, 2 * hour);
    place(inputDirectory, "hand-picked-reference.png", 25 * hour);
    place(outputDirectory, "idream_redcraft_qw21t_00001_.png", 25 * hour);
    place(outputDirectory, "idream_redcraft_qw21t_00002_.png", 2 * hour);
    place(outputDirectory, "idream_redcraft_qw21t_ab_compare.png", 25 * hour);
    place(outputDirectory, "ray_m4_rayresident_00001_.png", 25 * hour);
    place(outputDirectory, "idream_redcraft_krea2_identity_00001_.png", 25 * hour);
    place(path.join(outputDirectory, "h3-benchmark-20261024"), "idream_redcraft_qw21t_00001_.png", 25 * hour);

    const removed = sweepTransientFiles({ inputDirectory, outputDirectory, retentionMs: 24 * hour, now, prefixes: ["idream_redcraft_qw21t"] });

    assert.equal(removed.length, 3);
    assert.deepEqual(readdirSync(inputDirectory).sort(), ["hand-picked-reference.png", `idream-reference-${"b".repeat(64)}.png`]);
    assert.deepEqual(readdirSync(outputDirectory).sort(), ["h3-benchmark-20261024", "idream_redcraft_krea2_identity_00001_.png", "idream_redcraft_qw21t_00002_.png", "idream_redcraft_qw21t_ab_compare.png", "ray_m4_rayresident_00001_.png"]);
    assert.deepEqual(readdirSync(path.join(outputDirectory, "h3-benchmark-20261024")), ["idream_redcraft_qw21t_00001_.png"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
