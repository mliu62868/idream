import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("a Bun-launched build uses Node for Next and preserves its failure exit", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "idream-next-build-"));
  try {
    const next = path.join(fixture, "node_modules/next");
    mkdirSync(path.join(next, "dist/bin"), { recursive: true });
    writeFileSync(path.join(fixture, "package.json"), "{}");
    writeFileSync(path.join(next, "package.json"), '{"name":"next"}');
    writeFileSync(path.join(next, "dist/bin/next"), `
      console.log(JSON.stringify({ node: !process.versions.bun, args: process.argv.slice(2) }));
      process.exit(7);
    `);
    const result = spawnSync("bun", [
      new URL("./build-next-standalone.mjs", import.meta.url).pathname,
      fixture,
    ], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { node: true, args: ["build"] });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
