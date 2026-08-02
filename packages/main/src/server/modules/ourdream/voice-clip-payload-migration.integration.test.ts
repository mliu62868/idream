import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/server/lib/env";

describe("Voice clip current-attempt payload database guard", () => {
  const schema = `voice_payload_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE "users" ("id" TEXT PRIMARY KEY)');
    await client.query('CREATE TABLE "characters" ("id" TEXT PRIMARY KEY)');
    await client.query('CREATE TABLE "media_assets" ("id" TEXT PRIMARY KEY)');
    const migration = await readFile(
      path.resolve(
        process.cwd(),
        "prisma/migrations/20260801201500_voice_clip_authority/migration.sql",
      ),
      "utf8",
    );
    await client.query(migration);
    await client.query('INSERT INTO "users" ("id") VALUES ($1)', ["user-1"]);
    await client.query('INSERT INTO "characters" ("id") VALUES ($1)', [
      "character-1",
    ]);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("rejects in-attempt rewrites but permits one expired-lease takeover CAS", async () => {
    const prewarm = {
      version: 1,
      text: "Pinned synthesis text",
      sessionId: null,
      intent: "prewarm",
    };
    const play = { ...prewarm, intent: "play" };
    await client.query(
      `INSERT INTO "voice_clip_requests" (
        "id", "userId", "characterId", "messageId", "requestFingerprint",
        "synthesisPayload", "providerPayload", "leaseOwner", "leaseExpiresAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, NOW())`,
      [
        "request-1",
        "user-1",
        "character-1",
        "message-1",
        "fingerprint-1",
        JSON.stringify(prewarm),
        JSON.stringify({ providerKey: "mock" }),
        "worker-1",
        new Date(Date.now() + 60_000),
      ],
    );

    await expect(
      client.query(
        'UPDATE "voice_clip_requests" SET "synthesisPayload" = $1::jsonb WHERE "id" = $2',
        [JSON.stringify(play), "request-1"],
      ),
    ).rejects.toThrow(/immutable within an attempt/);

    await client.query(
      'UPDATE "voice_clip_requests" SET "leaseExpiresAt" = $1 WHERE "id" = $2',
      [new Date(Date.now() - 1_000), "request-1"],
    );
    await expect(
      client.query(
        `UPDATE "voice_clip_requests"
         SET "attemptNo" = "attemptNo" + 1,
             "synthesisPayload" = $1::jsonb,
             "leaseOwner" = $2,
             "leaseExpiresAt" = $3
         WHERE "id" = $4`,
        [
          JSON.stringify(play),
          "worker-2",
          new Date(Date.now() + 60_000),
          "request-1",
        ],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      client.query(
        'UPDATE "voice_clip_requests" SET "synthesisPayload" = $1::jsonb WHERE "id" = $2',
        [JSON.stringify(prewarm), "request-1"],
      ),
    ).rejects.toThrow(/immutable within an attempt/);
  });

  it("keeps legacy null payloads readable and rejects non-canonical payload shapes", async () => {
    const insert = (id: string, synthesisPayload: unknown) =>
      client.query(
        `INSERT INTO "voice_clip_requests" (
          "id", "userId", "characterId", "messageId", "requestFingerprint",
          "synthesisPayload", "providerPayload", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW())`,
        [
          id,
          "user-1",
          "character-1",
          `message-${id}`,
          `fingerprint-${id}`,
          synthesisPayload === null ? null : JSON.stringify(synthesisPayload),
          JSON.stringify({ providerKey: "mock" }),
        ],
      );

    await expect(insert("legacy-null", null)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(
      insert("extra-key", {
        version: 1,
        text: "Pinned synthesis text",
        sessionId: null,
        intent: "play",
        mutablePrompt: "must not be stored",
      }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("invalid-version", {
        version: 2,
        text: "Pinned synthesis text",
        sessionId: null,
        intent: "play",
      }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("null-intent", {
        version: 1,
        text: "Pinned synthesis text",
        sessionId: null,
        intent: null,
      }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
  });
});
