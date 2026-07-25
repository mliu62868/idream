const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "ecosystem.config.js");

function loadConfig(mode) {
  const originalMode = process.env.IDREAM_PM2_MODE;
  try {
    if (mode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = mode;
    }
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  } finally {
    if (originalMode === undefined) {
      delete process.env.IDREAM_PM2_MODE;
    } else {
      process.env.IDREAM_PM2_MODE = originalMode;
    }
    delete require.cache[require.resolve(configPath)];
  }
}

function byName(config, name) {
  const app = config.apps.find((candidate) => candidate.name === name);
  assert.ok(app, `missing PM2 app ${name}`);
  return app;
}

test("development is the source-backed default", () => {
  const config = loadConfig(undefined);
  assert.equal(config.apps.length, 8);
  const mainWeb = byName(config, "main-web");
  const adminWeb = byName(config, "admin-web");
  const chat = byName(config, "chat");
  const genImage = byName(config, "gen-image");
  const genFinalizer = byName(config, "gen-finalizer");

  assert.equal(mainWeb.cwd, path.join(repoRoot, "packages/main"));
  assert.equal(mainWeb.script, "node_modules/next/dist/bin/next");
  assert.equal(mainWeb.args, "dev");
  assert.equal(mainWeb.exec_mode, "fork");
  assert.equal(mainWeb.instances, 1);
  assert.equal(mainWeb.watch, false);

  assert.equal(adminWeb.cwd, path.join(repoRoot, "packages/admin"));
  assert.equal(adminWeb.script, "node_modules/next/dist/bin/next");
  assert.equal(adminWeb.args, "dev");
  assert.equal(adminWeb.exec_mode, "fork");
  assert.equal(adminWeb.watch, false);

  assert.deepEqual(chat.watch, [
    path.join(repoRoot, "packages/chat/src"),
    path.join(repoRoot, "packages/shared/src"),
  ]);
  assert.equal(chat.watch_delay, 500);
  assert.equal(genImage.instances, 2);
  assert.deepEqual(genFinalizer.watch, [
    path.join(repoRoot, "packages/main/src/processes"),
    path.join(repoRoot, "packages/main/src/server"),
    path.join(repoRoot, "packages/shared/src"),
  ]);
});

test("production keeps immutable standalone web releases and disables watch", () => {
  const config = loadConfig("production");
  const mainWeb = byName(config, "main-web");
  const adminWeb = byName(config, "admin-web");

  for (const web of [mainWeb, adminWeb]) {
    assert.equal(web.cwd, repoRoot);
    assert.equal(web.script, "scripts/start-next-standalone.cjs");
    assert.equal(web.exec_mode, "cluster");
    assert.equal(web.watch, false);
  }

  for (const app of config.apps) {
    assert.equal(app.watch, false);
  }
});

test("invalid runtime modes fail fast", () => {
  assert.throws(
    () => loadConfig("preview"),
    /Invalid IDREAM_PM2_MODE "preview"/,
  );
});
