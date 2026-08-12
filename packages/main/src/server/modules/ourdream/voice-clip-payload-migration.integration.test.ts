import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/server/lib/env";
import { voiceClipSynthesisPayloadSchema } from "./voice-clip";

describe("Voice clip current-attempt payload database guard", () => {
  const schema = `voice_payload_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  let scenePayloadMigration = "";

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE "users" ("id" TEXT PRIMARY KEY)');
    await client.query('CREATE TABLE "characters" ("id" TEXT PRIMARY KEY)');
    await client.query('CREATE TABLE "media_assets" ("id" TEXT PRIMARY KEY)');
    const authorityMigration = await readFile(
      path.resolve(
        process.cwd(),
        "prisma/migrations/20260801201500_voice_clip_authority/migration.sql",
      ),
      "utf8",
    );
    await client.query(authorityMigration);
    scenePayloadMigration = await readFile(
      path.resolve(
        process.cwd(),
        "prisma/migrations/20260811160000_voice_clip_scene_payload_authority/migration.sql",
      ),
      "utf8",
    );
    await client.query(scenePayloadMigration);
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

  it("accepts an exact pinned Chat scene and rejects partial or malformed scene authority", async () => {
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
          JSON.stringify(synthesisPayload),
          JSON.stringify({ providerKey: "mock" }),
        ],
      );
    const scene = {
      schemaVersion: 1,
      version: 2,
      location: "yacht deck",
      time: null,
      participants: ["user", "alexa-reeves"],
      emotionalBeat: "guarded curiosity",
      unresolvedThreads: ["why the user came aboard"],
    };
    const current = {
      version: 1,
      text: "Pinned synthesis text",
      sessionId: "session-1",
      intent: "play",
      sceneVersion: 2,
      scene,
    };

    await expect(insert("scene-current", current)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(
      insert("scene-partial", { ...current, scene: undefined }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("scene-version-partial", { ...current, sceneVersion: undefined }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("scene-fractional", { ...current, sceneVersion: 2.5 }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("scene-version-drift", { ...current, sceneVersion: 1 }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("scene-null-version-drift", {
        ...current,
        sceneVersion: 2,
        scene: null,
      }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("scene-invalid-participant", {
        ...current,
        scene: { ...scene, participants: ["user", 42] },
      }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
    await expect(
      insert("scene-extra-key", {
        ...current,
        scene: { ...scene, mutablePrompt: "not authority" },
      }),
    ).rejects.toThrow(/voice_clip_requests_synthesis_payload_check/);
  });

  it("keeps the Zod and database pair/parity authority identical", () => {
    const legacy = {
      version: 1,
      text: "Legacy synthesis text",
      sessionId: null,
      intent: "play",
    } as const;
    const scene = {
      schemaVersion: 1,
      version: 2,
      location: "yacht deck",
      time: null,
      participants: ["user", "alexa-reeves"],
      emotionalBeat: "guarded curiosity",
      unresolvedThreads: ["why the user came aboard"],
    } as const;

    expect(voiceClipSynthesisPayloadSchema.safeParse(legacy).success).toBe(true);
    expect(
      voiceClipSynthesisPayloadSchema.safeParse({
        ...legacy,
        sceneVersion: 2,
        scene,
      }).success,
    ).toBe(true);
    expect(
      voiceClipSynthesisPayloadSchema.safeParse({ ...legacy, sceneVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      voiceClipSynthesisPayloadSchema.safeParse({ ...legacy, scene }).success,
    ).toBe(false);
    expect(
      voiceClipSynthesisPayloadSchema.safeParse({
        ...legacy,
        sceneVersion: 1,
        scene,
      }).success,
    ).toBe(false);
    expect(
      voiceClipSynthesisPayloadSchema.safeParse({
        ...legacy,
        sceneVersion: 1,
        scene: null,
      }).success,
    ).toBe(false);
  });

  it("can reapply the guarded migration without weakening the constraint", async () => {
    await expect(client.query(scenePayloadMigration)).resolves.toBeDefined();
    const constraint = await client.query<{
      definition: string;
      validated: boolean;
    }>(
      `SELECT pg_get_constraintdef(oid) AS definition,
              convalidated AS validated
         FROM pg_constraint
        WHERE conrelid = 'voice_clip_requests'::regclass
          AND conname = 'voice_clip_requests_synthesis_payload_check'`,
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0]).toMatchObject({ validated: true });
    expect(constraint.rows[0]?.definition).toContain("sceneVersion");
  });
});
