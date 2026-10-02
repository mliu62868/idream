import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";

it("migrates only proven reply versions and preserves historical delivery identities", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const schema = `voice_attempt_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE recent_chats ("sessionId" TEXT PRIMARY KEY, "userId" TEXT, "characterId" TEXT, "openingMessage" TEXT);
      CREATE TABLE chat_turns ("sessionId" TEXT, "assistantMessageId" TEXT, attempt INTEGER, "assistantContent" TEXT,
        "sceneVersion" INTEGER, scene JSONB, "assistantStatus" TEXT, "terminalAt" TIMESTAMP);
      CREATE TABLE voice_clip_requests (id TEXT PRIMARY KEY, "userId" TEXT, "characterId" TEXT, "messageId" TEXT,
        "synthesisPayload" JSONB, "createdAt" TIMESTAMP, "requestFingerprint" TEXT, "providerRequestId" TEXT, "mediaAssetId" TEXT);
      CREATE UNIQUE INDEX "voice_clip_requests_userId_messageId_key" ON voice_clip_requests ("userId", "messageId");
      CREATE TABLE voice_usage_facts ("requestId" TEXT, "mediaAssetId" TEXT, "costDreamcoins" INTEGER);
      INSERT INTO recent_chats VALUES ('session', 'owner', 'character', 'Hello.');
      INSERT INTO chat_turns VALUES
        ('session', 'current', 3, 'Reply.', 0, NULL, 'sent', '2026-10-01 12:00:00'),
        ('session', 'identical-old', 2, 'Reply.', 0, NULL, 'sent', '2026-10-01 12:00:00'),
        ('session', 'changed-old', 2, 'New reply.', 0, NULL, 'sent', '2026-10-01 12:00:00');
      INSERT INTO voice_clip_requests VALUES
        ('current-request', 'owner', 'character', 'current', '{"version":1,"text":"Reply.","sessionId":"session","intent":"play","sceneVersion":0,"scene":null}', '2026-10-01 12:00:01', 'current-fingerprint', 'current-provider', 'current-asset'),
        ('identical-old-request', 'owner', 'character', 'identical-old', '{"version":1,"text":"Reply.","sessionId":"session","intent":"play","sceneVersion":0,"scene":null}', '2026-10-01 11:00:00', 'old-fingerprint', 'old-provider', 'old-asset'),
        ('changed-old-request', 'owner', 'character', 'changed-old', '{"version":1,"text":"Old reply.","sessionId":"session","intent":"play","sceneVersion":0,"scene":null}', '2026-10-01 11:00:00', 'changed-fingerprint', 'changed-provider', 'changed-asset'),
        ('opening-request', 'owner', 'character', 'opening:session', '{"version":1,"text":"Hello.","sessionId":"session","intent":"play"}', '2026-10-01 11:00:00', 'opening-fingerprint', 'opening-provider', 'opening-asset');
      INSERT INTO voice_usage_facts VALUES ('identical-old-request', 'old-asset', 2);
    `);
    const before = await client.query("SELECT to_jsonb(request) AS row FROM voice_clip_requests request ORDER BY id");
    const usageBefore = await client.query("SELECT * FROM voice_usage_facts");
    await client.query(await readFile(new URL("../../../../prisma/migrations/20261001010000_voice_clip_reply_attempt/migration.sql", import.meta.url), "utf8"));
    expect((await client.query('SELECT id, "replyAttempt" FROM voice_clip_requests ORDER BY id')).rows).toEqual([
      { id: "changed-old-request", replyAttempt: 0 },
      { id: "current-request", replyAttempt: 3 },
      { id: "identical-old-request", replyAttempt: 0 },
      { id: "opening-request", replyAttempt: 1 },
    ]);
    expect((await client.query("SELECT to_jsonb(request) - 'replyAttempt' AS row FROM voice_clip_requests request ORDER BY id")).rows).toEqual(before.rows);
    expect((await client.query("SELECT * FROM voice_usage_facts")).rows).toEqual(usageBefore.rows);
    await client.query(`INSERT INTO voice_clip_requests (id, "userId", "messageId", "replyAttempt") VALUES ('new-request', 'owner', 'identical-old', 2)`);
    await expect(client.query(`INSERT INTO voice_clip_requests (id, "userId", "messageId", "replyAttempt") VALUES ('duplicate-request', 'owner', 'identical-old', 2)`)).rejects.toMatchObject({ code: "23505" });
    await expect(client.query(`UPDATE voice_clip_requests SET "replyAttempt" = 1 WHERE id = 'identical-old-request'`)).rejects.toThrow("reply version is immutable");
  } finally {
    await client.query(`SET search_path TO public`);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
