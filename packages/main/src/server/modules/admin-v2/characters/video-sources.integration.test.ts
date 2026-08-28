import { randomUUID } from "node:crypto";
import { contentAssetQuerySchema } from "@idream/shared/admin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { listContentAssets } from "@/server/modules/admin-v2/content/assets";

const providerState = vi.hoisted(() => ({
  storedKeys: [] as string[],
  deletedKeys: [] as string[],
}));

vi.mock("@/server/providers", () => ({
  providers: {
    blob: {
      async putPrivate(input: { key: string; body: Uint8Array }) {
        providerState.storedKeys.push(input.key);
        return {
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        };
      },
      async delete(input: { key: string }) {
        providerState.deletedKeys.push(input.key);
        return { ok: true as const, data: { deleted: true as const } };
      },
    },
  },
}));

import {
  createCharacterVideoSource,
  parseCharacterVideoSourceForm,
} from "./video-sources";

describe("Character video library import", () => {
  const suffix = randomUUID();
  const actorId = `video-source-admin-${suffix}`;
  const characterId = `video-source-character-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Mara Video Source",
        age: 31,
        description: "A local video library integration fixture.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.mediaAsset.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("imports once and exposes the video through the role asset library", async () => {
    providerState.storedKeys = [];
    providerState.deletedKeys = [];
    const bytes = new Uint8Array(2_048);
    const form = new FormData();
    form.set("purpose", "character_video_library");
    form.set("video", new File([bytes], "mara-night.webm", { type: "video/webm" }));
    const parsed = await parseCharacterVideoSourceForm(
      new Request("http://localhost", { method: "POST", body: form }),
    );
    const idempotencyKey = `video-source-${suffix}`;
    const first = await createCharacterVideoSource({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: `video-source-request-${suffix}`,
      form: parsed,
    });
    const replay = await createCharacterVideoSource({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: `video-source-replay-${suffix}`,
      form: parsed,
    });

    expect(first).toMatchObject({
      replayed: false,
      asset: {
        filename: "mara-night.webm",
        contentType: "video/webm",
        sizeBytes: bytes.byteLength,
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(providerState.storedKeys).toHaveLength(1);
    expect(providerState.deletedKeys).toEqual([]);

    const persisted = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: first.asset.id },
    });
    expect(persisted).toMatchObject({
      characterId,
      ownerId: actorId,
      type: "video",
      visibility: "private",
      safetyStatus: "passed",
    });
    expect(persisted.metadata).toMatchObject({
      purpose: "character_video_library",
      platformAsset: {
        purpose: "character_video_library",
        status: "generated",
      },
    });

    const library = await listContentAssets(contentAssetQuerySchema.parse({
      mediaType: "video",
      targetId: characterId,
      limit: 100,
    }));
    expect(library.items).toContainEqual(expect.objectContaining({
      id: first.asset.id,
      type: "video",
      targetType: "character",
      targetId: characterId,
      platformStatus: "generated",
    }));
  });
});
