const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

// PM2's Bun container retains an IPC listener after the web child exits.
// Exercise the actual entrypoint with a real failed child and a referenced IPC
// channel: returning a status or setting exitCode alone leaves PM2 falsely online.
for (const executable of [process.execPath, "bun"]) for (const name of ["main", "admin"]) {
  test(`${name} development entrypoint on ${path.basename(executable)} exits when its web child fails under a retained host IPC channel`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-development-exit-"));
    const preload = path.join(directory, "preload.cjs");
    writeFileSync(preload, `
      const childProcess = require("node:child_process");
      const realSpawn = childProcess.spawn;
      childProcess.spawnSync = () => ({ status: 0 });
      childProcess.spawn = () => realSpawn(process.execPath, ["-e", "process.exit(23)"], { stdio: "ignore" });
      process.on("message", () => {});
    `);
    const child = spawn(executable, ["--require", preload,
      path.resolve(__dirname, `../packages/${name}/scripts/start-development.cjs`)], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, IDREAM_PM2_BUN_ENTRYPOINT: "" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timeout;
    try {
      const result = await Promise.race([
        new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
        new Promise((resolve) => { timeout = setTimeout(() => resolve({ timedOut: true }), 1500); }),
      ]);
      assert.deepEqual(result, { code: 23, signal: null }, `Wrapper retained after child exit: ${stderr}`);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
