/* eslint-disable @typescript-eslint/no-require-imports -- This unit test exercises the CommonJS bootstrap used directly by the package script. */
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  nextCli,
  runDevelopment,
} = require("./start-development.cjs");

test("ordinary Admin development owns its dedicated Next directory", () => {
  const runtime = {
    argv: ["/runtime/node", "start-development.cjs", "--port", "3001"],
    env: {},
    execPath: "/runtime/node",
  };

  const loaded = [];
  const status = runDevelopment({
    process: runtime,
    loadNext: (entrypoint) => loaded.push(entrypoint),
  });

  assert.equal(status, 0);
  assert.deepEqual(loaded, [nextCli]);
  assert.deepEqual(runtime.argv, [
    "/runtime/node",
    nextCli,
    "dev",
    "--port",
    "3001",
  ]);
  assert.equal(runtime.env.IDREAM_NEXT_DEVELOPMENT, "1");
  assert.equal(runtime.env.IDREAM_NEXT_DIST_DIR, ".next-development");
});

test("Admin development preserves Playwright-owned Next directories", () => {
  const runtime = {
    argv: ["/runtime/node", "start-development.cjs", "--port", "3941"],
    env: {
      PW_RUN_ID: "acd11235",
      IDREAM_NEXT_DIST_DIR: ".next/playwright-admin-3941-acd11235",
      IDREAM_NEXT_TSCONFIG:
        ".next/playwright-config-admin-3941-acd11235/tsconfig.json",
    },
    execPath: "/runtime/node",
  };

  const status = runDevelopment({
    process: runtime,
    loadNext: () => {},
  });

  assert.equal(status, 0);
  assert.equal(runtime.env.IDREAM_NEXT_DEVELOPMENT, undefined);
  assert.equal(
    runtime.env.IDREAM_NEXT_DIST_DIR,
    ".next/playwright-admin-3941-acd11235",
  );
  assert.equal(
    runtime.env.IDREAM_NEXT_TSCONFIG,
    ".next/playwright-config-admin-3941-acd11235/tsconfig.json",
  );
});
