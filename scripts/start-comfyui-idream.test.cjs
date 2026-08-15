const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const { resolveRuntime } = require("./start-comfyui-idream.cjs");

test("ComfyUI launcher passes paths as argv without a shell", () => {
  const root = "/tmp/ComfyUI instance (1)";
  const runtime = resolveRuntime({
    COMFYUI_ROOT: root,
    COMFYUI_PORT: "8199",
    COMFYUI_OUTPUT_DIRECTORY: "/tmp/output files",
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
    path.join(root, "user"),
  );
});
