import assert from "node:assert/strict";
import test from "node:test";
import {
  companionLoopbackUrl,
  parseArgs,
  retireLegacyItemMemoryIntents,
} from "./retire-legacy-chat-item-memory-intents.mjs";

function fakePool(events, pending = [{ user_id: "private-user", intent_count: 2 }]) {
  const client = {
    async query(sql) {
      if (String(sql).includes("projection_claim_")) {
        throw new Error("old schema has no projection claim columns");
      }
      if (String(sql).includes("UPDATE chat.chat_file_mutations")) {
        assert.match(
          String(sql),
          /payload\s*=\s*chat\.redact_file_mutation_payload\(id,\s*kind,\s*payload\)/u,
        );
      }
      events.push(String(sql).trim().split(/\s+/u).slice(0, 3).join(" "));
      if (String(sql).includes("UPDATE chat.chat_file_mutations")) {
        return { rowCount: 2, rows: [{ id: "one" }, { id: "two" }] };
      }
      return { rows: [] };
    },
    release() { events.push("release"); },
  };
  return {
    async query() { return { rows: pending }; },
    async connect() { return client; },
    async end() { events.push("end"); },
  };
}

test("legacy item retirement is dry-run by default and content-free", async () => {
  const events = [];
  const fetchImpl = async () => { throw new Error("must not purge during check"); };
  const report = await retireLegacyItemMemoryIntents({
    apply: false,
    connectionString: "postgresql://projector.invalid/chat",
    fetchImpl,
    poolFactory: () => fakePool(events),
  });
  assert.deepEqual(report, {
    schemaVersion: 1,
    ok: false,
    mode: "check",
    users: 1,
    intents: 2,
    retired: 0,
    purgedWorkspaces: 0,
  });
  assert.equal(JSON.stringify(report).includes("private-user"), false);
  assert.deepEqual(events, ["end"]);
});

test("apply purges the complete user workspace before terminalizing receipts", async () => {
  const events = [];
  const report = await retireLegacyItemMemoryIntents({
    apply: true,
    connectionString: "postgresql://projector.invalid/chat",
    sidecarUrl: "http://127.0.0.1:3101",
    token: "secret-token",
    fetchImpl: async (_url, init) => {
      events.push(`purge:${JSON.parse(init.body).scope}`);
      assert.equal(init.headers.authorization, "Bearer secret-token");
      return Response.json({ ok: true, purged: 3 });
    },
    poolFactory: () => fakePool(events),
  });
  assert.deepEqual(report, {
    schemaVersion: 1,
    ok: true,
    mode: "apply",
    users: 1,
    intents: 2,
    retired: 2,
    purgedWorkspaces: 3,
  });
  assert.equal(events[0], "purge:user");
  assert.ok(events.indexOf("purge:user") < events.findIndex((event) => event.startsWith("BEGIN")));
  assert.equal(JSON.stringify(events).includes("secret-token"), false);
});

test("purge failure leaves every pending receipt untouched", async () => {
  const events = [];
  await assert.rejects(
    retireLegacyItemMemoryIntents({
      apply: true,
      connectionString: "postgresql://projector.invalid/chat",
      sidecarUrl: "http://localhost:3101",
      token: "secret-token",
      fetchImpl: async () => Response.json({ ok: false }, { status: 503 }),
      poolFactory: () => fakePool(events),
    }),
    /purge failed with HTTP 503/u,
  );
  assert.deepEqual(events, ["end"]);
});

test("arguments and the sidecar authority fail closed", () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true });
  assert.throws(() => parseArgs(["--force"]), /usage/u);
  assert.equal(companionLoopbackUrl("http://[::1]:3101").hostname, "[::1]");
  assert.throws(() => companionLoopbackUrl("https://remote.example"), /loopback/u);
  assert.throws(() => companionLoopbackUrl("http://user@127.0.0.1:3101"), /canonical/u);
});
