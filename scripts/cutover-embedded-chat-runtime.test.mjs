import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCutover } from "./cutover-embedded-chat-runtime.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "idream-chat-cutover-"));
  await mkdir(path.join(root, "packages/chat"), { recursive: true });
  return root;
}

test("migrates runtime keys, retires routing flags, and quarantines the legacy package", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages/chat-agent"), { recursive: true });
  await writeFile(path.join(root, "packages/chat/.env"), "CHAT_MODEL_PROVIDER=openai\nDSH_AGENT_URL=http://legacy\nDSH_READY_MODEL=stale-model\n");
  await writeFile(path.join(root, "packages/chat-agent/.env"), "DSH_IGREP_COMMAND=igrep-pinned\nIGREP_LLM_MODEL=maintenance\n");

  const result = await runCutover(root, {
    nonce: () => "fixed",
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  const chatEnv = await readFile(path.join(root, "packages/chat/.env"), "utf8");

  assert.deepEqual(result.migratedKeys, ["DSH_IGREP_COMMAND", "IGREP_LLM_MODEL"]);
  assert.deepEqual(result.retiredKeys, ["DSH_AGENT_URL", "DSH_READY_MODEL"]);
  assert.match(chatEnv, /DSH_IGREP_COMMAND=igrep-pinned/);
  assert.doesNotMatch(chatEnv, /DSH_AGENT_URL/);
  assert.doesNotMatch(chatEnv, /DSH_READY_MODEL/);
  assert.equal(result.quarantine, path.join(
    root,
    ".data/quarantine/chat-agent-package-2026-08-28T12-00-00.000Z",
  ));
});

test("is idempotent after the legacy package is gone", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const chatEnv = path.join(root, "packages/chat/.env");
  await writeFile(chatEnv, "CHAT_MODEL_PROVIDER=openai\n");

  const first = await runCutover(root);
  const firstText = await readFile(chatEnv, "utf8");
  const second = await runCutover(root);

  assert.equal(first.quarantine, null);
  assert.equal(second.quarantine, null);
  assert.equal(await readFile(chatEnv, "utf8"), firstText);
});

test("rejects incomplete source and target environments", async (t) => {
  const missingTarget = await fixture();
  const missingLegacyEnv = await fixture();
  t.after(() => Promise.all([
    rm(missingTarget, { recursive: true, force: true }),
    rm(missingLegacyEnv, { recursive: true, force: true }),
  ]));
  await mkdir(path.join(missingLegacyEnv, "packages/chat-agent"), { recursive: true });
  await writeFile(path.join(missingLegacyEnv, "packages/chat/.env"), "CHAT_MODEL_PROVIDER=openai\n");

  await assert.rejects(runCutover(missingTarget), /packages\/chat\/\.env is required/);
  await assert.rejects(runCutover(missingLegacyEnv), /packages\/chat-agent\/\.env is required/);
});
