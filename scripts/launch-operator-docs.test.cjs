const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const rootPackage = require("../package.json");

const repoRoot = path.resolve(__dirname, "..");
const operatorDocs = [
  "docs/architecture/10-operations.md",
  "docs/product/LAUNCH_READINESS_AUDIT.md",
  "docs/product/PRODUCTION_SECRET_CHECKLIST.md",
];

const sentryProbeCommands = [
  "bun run launch:probe:sentry:main -- --report .tmp/launch-sentry-main-probe.json",
  "bun run launch:probe:sentry:admin -- --report .tmp/launch-sentry-admin-probe.json",
  "bun run launch:probe:sentry:chat -- --report .tmp/launch-sentry-chat-probe.json",
  "bun run launch:probe:sentry:gen -- --report .tmp/launch-sentry-gen-probe.json",
];

test("launch operator docs use the package-bound Sentry probes", () => {
  for (const relativePath of operatorDocs) {
    const contents = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /launch:probe:sentry -- --service/);
    for (const command of sentryProbeCommands) {
      assert.match(contents, new RegExp(escapeRegExp(command)));
    }
  }
});

test("the root Chat model probe loads the Chat runtime authority", () => {
  assert.equal(
    rootPackage.scripts["launch:probe:chat"],
    "node --env-file=packages/main/.env --env-file=packages/chat/.env packages/main/node_modules/.bin/tsx packages/main/src/server/probe-chat-model.ts",
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
