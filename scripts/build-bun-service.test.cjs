const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("Bun service builds inline @idream/shared while leaving third-party packages external", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "idream-bun-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = path.join(root, "entry.ts");
  const outdir = path.join(root, "dist");
  writeFileSync(
    entrypoint,
    [
      'import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";',
      "console.log(FREE_DAILY_MESSAGES);",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    "bun",
    [
      path.join(repoRoot, "scripts/build-bun-service.mjs"),
      "--outdir",
      outdir,
      entrypoint,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const outputName = readdirSync(outdir).find((name) => name.endsWith(".js"));
  assert.ok(outputName, "missing JavaScript build output");
  const output = readFileSync(path.join(outdir, outputName), "utf8");
  assert.doesNotMatch(output, /["']@idream\/shared(?:\/|["'])/);
  assert.match(output, /FREE_DAILY_MESSAGES|30/);
});
