/* eslint-disable @typescript-eslint/no-require-imports -- This unit test exercises the Bun-hosted CommonJS bootstrap used directly by PM2. */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  nextCli,
  packageRoot,
  prismaCli,
  runDevelopment,
} = require("./start-development.cjs");

test("development startup remains the parent authority for the Next lifecycle", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  const runtime = new EventEmitter();
  runtime.argv = ["/runtime/node", "start-development.cjs"];
  runtime.env = {};
  runtime.execPath = "/runtime/node";

  const lifecycle = runDevelopment({
    process: runtime,
    spawnSync: () => ({ status: 0 }),
    spawn: () => child,
  });

  assert.equal(typeof lifecycle?.then, "function");
  child.emit("exit", 0, null);
  assert.equal(await lifecycle, 0);
});

test("development startup generates Prisma Client before spawning Next", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const runtime = {
    argv: ["/runtime/node", "start-development.cjs", "--hostname", "127.0.0.1"],
    env: { TEST_MARKER: "true" },
    execPath: "/runtime/node",
    once: () => {},
    off: () => {},
  };
  const lifecycle = runDevelopment({
    process: runtime,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  child.emit("exit", 0, null);

  assert.equal(await lifecycle, 0);
  assert.deepEqual(calls, [
    {
      command: "/runtime/node",
      args: [prismaCli, "generate"],
      options: {
        cwd: packageRoot,
        env: runtime.env,
        stdio: "inherit",
      },
    },
    {
      command: "/runtime/node",
      args: [nextCli, "dev", "--hostname", "127.0.0.1"],
      options: {
        cwd: packageRoot,
        env: runtime.env,
        stdio: "inherit",
      },
    },
  ]);
  assert.equal(runtime.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(runtime.env.IDREAM_NEXT_DIST_DIR, ".next-development");
});

test("development startup fails closed when Prisma generation fails", async () => {
  let spawnedNext = false;
  const runtime = {
    argv: ["/runtime/node", "start-development.cjs"],
    env: {},
    execPath: "/runtime/node",
  };
  const status = await runDevelopment({
    process: runtime,
    spawnSync: () => ({ status: 29 }),
    spawn: () => {
      spawnedNext = true;
    },
  });

  assert.equal(status, 29);
  assert.equal(spawnedNext, false);
});

test("development startup preserves Playwright-owned Next directories", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  const runtime = new EventEmitter();
  Object.assign(runtime, {
    argv: ["/runtime/node", "start-development.cjs", "--port", "3940"],
    env: {
      PW_RUN_ID: "acd11234",
      IDREAM_NEXT_DIST_DIR: ".next/playwright-main-3940-acd11234",
      IDREAM_NEXT_TSCONFIG:
        ".next/playwright-config-main-3940-acd11234/tsconfig.json",
    },
    execPath: "/runtime/node",
  });

  const lifecycle = runDevelopment({
    process: runtime,
    spawnSync: () => ({ status: 0 }),
    spawn: () => child,
  });
  child.emit("exit", 0, null);

  assert.equal(await lifecycle, 0);
  assert.equal(runtime.env.IDREAM_NEXT_DEVELOPMENT, undefined);
  assert.equal(
    runtime.env.IDREAM_NEXT_DIST_DIR,
    ".next/playwright-main-3940-acd11234",
  );
  assert.equal(
    runtime.env.IDREAM_NEXT_TSCONFIG,
    ".next/playwright-config-main-3940-acd11234/tsconfig.json",
  );
});

test("development startup forwards PM2 stop signals and waits for Next", async () => {
  const child = new EventEmitter();
  const forwarded = [];
  child.kill = (signal) => {
    forwarded.push(signal);
    return true;
  };
  const runtime = new EventEmitter();
  runtime.argv = ["/runtime/node", "start-development.cjs"];
  runtime.env = {};
  runtime.execPath = "/runtime/node";
  const lifecycle = runDevelopment({
    process: runtime,
    spawnSync: () => ({ status: 0 }),
    spawn: () => child,
  });

  runtime.emit("SIGTERM");
  assert.deepEqual(forwarded, ["SIGTERM"]);
  child.emit("exit", null, "SIGTERM");
  assert.equal(await lifecycle, 0);
  assert.equal(runtime.listenerCount("SIGTERM"), 0);
  assert.equal(runtime.listenerCount("SIGINT"), 0);
});
