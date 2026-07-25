import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "@/server/lib/db";

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
      async signGetUrl() {
        return {
          ok: true as const,
          data: { url: "https://blob.example.test/image-source" },
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
  createCharacterImageSource,
  listCharacterImageSources,
  parseCharacterImageSourceForm,
} from "./image-sources";

describe("Character local image source authority", () => {
  const suffix = randomUUID();
  const actorId = `image-source-admin-${suffix}`;
  const characterId = `image-source-character-${suffix}`;

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
        name: "Mara Image Source",
        age: 31,
        description: "A local image source integration fixture.",
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

  it("rejects files that are not decodable images", async () => {
    const form = new FormData();
    form.set("purpose", "identity_experiment_source");
    form.set(
      "image",
      new File([new Uint8Array(2_048)], "not-an-image.png", {
        type: "image/png",
      }),
    );

    await expect(parseCharacterImageSourceForm(new Request("http://localhost", {
      method: "POST",
      body: form,
    }))).rejects.toMatchObject({ status: 400 });
  });

  it("persists a private source idempotently and recovers it in the recent list", async () => {
    providerState.storedKeys = [];
    providerState.deletedKeys = [];
    const png = Uint8Array.from(await sharp({
      create: {
        width: 128,
        height: 160,
        channels: 3,
        background: { r: 96, g: 72, b: 64 },
      },
    }).png().toBuffer());
    const form = new FormData();
    form.set("purpose", "identity_experiment_source");
    form.set(
      "image",
      new File([png], "mara-reference.jpg", { type: "image/jpeg" }),
    );
    const parsed = await parseCharacterImageSourceForm(
      new Request("http://localhost", { method: "POST", body: form }),
    );

    expect(parsed).toMatchObject({
      purpose: "identity_experiment_source",
      image: {
        filename: "mara-reference.png",
        contentType: "image/png",
        extension: ".png",
        width: 128,
        height: 160,
      },
    });

    const idempotencyKey = `image-source-${suffix}`;
    const first = await createCharacterImageSource({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: `image-source-request-${suffix}`,
      form: parsed,
    });
    const replay = await createCharacterImageSource({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: `image-source-replay-${suffix}`,
      form: parsed,
    });

    expect(first).toMatchObject({
      replayed: false,
      asset: {
        filename: "mara-reference.png",
        contentType: "image/png",
        sizeBytes: png.byteLength,
        width: 128,
        height: 160,
      },
    });
    expect(first.asset.url).toMatch(/^\/user-content\/.+\/content\.png$/);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(providerState.storedKeys).toHaveLength(1);
    expect(providerState.deletedKeys).toEqual([]);

    const persisted = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: first.asset.id },
    });
    expect(persisted).toMatchObject({
      characterId,
      ownerId: actorId,
      type: "image",
      visibility: "private",
      safetyStatus: "passed",
      width: 128,
      height: 160,
    });
    expect(persisted.metadata).toMatchObject({
      purpose: "identity_experiment_source",
      source: "admin_local_upload",
      filename: "mara-reference.png",
      platformAsset: {
        purpose: "identity_experiment_source",
        status: "draft",
      },
    });

    const recent = await listCharacterImageSources({ characterId });
    expect(recent.items).toContainEqual(first.asset);
  });
});
