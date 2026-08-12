/* eslint-disable @typescript-eslint/no-require-imports -- This unit test exercises the CommonJS bootstrap used directly by PM2. */
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  nextCli,
  packageRoot,
  prismaCli,
  runDevelopment,
} = require("./start-development.cjs");

test("development startup generates Prisma Client before loading Next", () => {
  const calls = [];
  const runtime = {
    argv: ["/runtime/node", "start-development.cjs", "--hostname", "127.0.0.1"],
    env: { TEST_MARKER: "true" },
    execPath: "/runtime/node",
  };
  const status = runDevelopment({
    process: runtime,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    loadNext: (entrypoint) => calls.push({ entrypoint }),
  });

  assert.equal(status, 0);
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
    { entrypoint: nextCli },
  ]);
  assert.deepEqual(runtime.argv, [
    "/runtime/node",
    nextCli,
    "dev",
    "--hostname",
    "127.0.0.1",
  ]);
  assert.equal(runtime.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(runtime.env.IDREAM_NEXT_DIST_DIR, ".next-development");
});

test("development startup fails closed when Prisma generation fails", () => {
  let loadedNext = false;
  const runtime = {
    argv: ["/runtime/node", "start-development.cjs"],
    env: {},
    execPath: "/runtime/node",
  };
  const status = runDevelopment({
    process: runtime,
    spawnSync: () => ({ status: 29 }),
    loadNext: () => {
      loadedNext = true;
    },
  });

  assert.equal(status, 29);
  assert.equal(loadedNext, false);
});
