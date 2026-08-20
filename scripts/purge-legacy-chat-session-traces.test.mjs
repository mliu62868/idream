import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseArgs,
  purgeLegacyChatSessionTraces,
} from "./purge-legacy-chat-session-traces.mjs";

test("legacy trace purge is check-only unless apply is explicit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "idream-trace-purge-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const sessions = path.join(root, "sessions", "user-1");
  await mkdir(sessions, { recursive: true });
  const trace = path.join(sessions, "session-1.jsonl");
  await writeFile(trace, '{"rawOutput":"private sentinel"}\n', "utf8");

  const checked = await purgeLegacyChatSessionTraces({
    apply: false,
    environment: { CHAT_FS_ROOT: root },
  });
  assert.equal(checked.mode, "check");
  assert.equal(checked.files, 1);
  assert.equal(await readFile(trace, "utf8"), '{"rawOutput":"private sentinel"}\n');

  const applied = await purgeLegacyChatSessionTraces({
    apply: true,
    environment: { CHAT_FS_ROOT: root },
  });
  assert.equal(applied.mode, "apply");
  assert.equal(applied.files, 1);
  await assert.rejects(readFile(trace, "utf8"), { code: "ENOENT" });
});

test("argument parser fails closed", () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true });
  assert.throws(() => parseArgs(["--root", "/"]), /usage/);
});
