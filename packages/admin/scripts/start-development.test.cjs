/* eslint-disable @typescript-eslint/no-require-imports -- This unit test exercises the Bun-hosted CommonJS bootstrap used directly by PM2. */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { runDevelopment } = require("./start-development.cjs");

test("development startup remains the parent authority for the Next lifecycle", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  const runtime = new EventEmitter();
  runtime.argv = ["/runtime/node", "start-development.cjs"];
  runtime.env = {};
  runtime.execPath = "/runtime/node";

  const lifecycle = runDevelopment({
    process: runtime,
    spawn: () => child,
  });

  assert.equal(typeof lifecycle?.then, "function");
  child.emit("exit", 0, null);
  assert.equal(await lifecycle, 0);
});

test("Bun bootstrap starts Next on Node so cold Turbopack externals resolve", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  const runtime = new EventEmitter();
  Object.assign(runtime, {
    argv: ["/runtime/bun", "start-development.cjs"],
    env: { NODE_OPTIONS: "--enable-source-maps" },
    execPath: "/runtime/bun",
  });
  const commands = [];
  const lifecycle = runDevelopment({
    process: runtime,
    spawn: (command) => {
      commands.push(command);
      return child;
    },
  });
  child.emit("exit", 0, null);

  assert.equal(await lifecycle, 0);
  assert.deepEqual(commands, ["node"]);
  assert.match(
    runtime.env.NODE_OPTIONS,
    /^--enable-source-maps --require \S+\/scripts\/bound-react-async-debug\.cjs$/,
  );
});

test("development startup preserves Playwright-owned Next directories", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  const runtime = new EventEmitter();
  Object.assign(runtime, {
    argv: ["/runtime/node", "start-development.cjs", "--port", "3941"],
    env: {
      PW_RUN_ID: "acd11234",
      IDREAM_NEXT_DIST_DIR: ".next/playwright-admin-3941-acd11234",
      IDREAM_NEXT_TSCONFIG:
        ".next/playwright-config-admin-3941-acd11234/tsconfig.json",
    },
    execPath: "/runtime/node",
  });

  const lifecycle = runDevelopment({
    process: runtime,
    spawn: () => child,
  });
  child.emit("exit", 0, null);

  assert.equal(await lifecycle, 0);
  assert.equal(runtime.env.IDREAM_NEXT_DEVELOPMENT, undefined);
  assert.equal(
    runtime.env.IDREAM_NEXT_DIST_DIR,
    ".next/playwright-admin-3941-acd11234",
  );
  assert.equal(
    runtime.env.IDREAM_NEXT_TSCONFIG,
    ".next/playwright-config-admin-3941-acd11234/tsconfig.json",
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
    spawn: () => child,
  });

  runtime.emit("SIGTERM");
  assert.deepEqual(forwarded, ["SIGTERM"]);
  child.emit("exit", null, "SIGTERM");
  assert.equal(await lifecycle, 0);
  assert.equal(runtime.listenerCount("SIGTERM"), 0);
  assert.equal(runtime.listenerCount("SIGINT"), 0);
});


test("Admin wrapper returns the real Node child failure status", async () => {
  const { spawn } = require("node:child_process");
  const runtime = new EventEmitter();
  Object.assign(runtime, {
    argv: ["/runtime/bun", "start-development.cjs"], env: {}, execPath: "/runtime/bun",
  });
  const status = await runDevelopment({
    process: runtime,
    spawn: (command) => spawn(command, ["-e", "process.exit(7)"], { stdio: "ignore" }),
  });
  assert.equal(status, 7);
  assert.equal(runtime.env.IDREAM_NEXT_DIST_DIR, ".next-development");
  assert.equal(runtime.listenerCount("SIGTERM"), 0);
});
