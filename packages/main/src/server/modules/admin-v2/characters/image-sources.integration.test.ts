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
    await prisma.creativeReviewDecision.deleteMany({ where: { reviewerId: actorId } });
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
        qualification: null,
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
      source: "admin_asset_upload",
      synthetic: false,
      filename: "mara-reference.png",
      uploadAuthority: {
        schemaVersion: "platform-asset-operator-upload-v1",
        kind: "operator_upload",
        assetId: first.asset.id,
        uploadedById: actorId,
      },
      platformAsset: {
        purpose: "identity_experiment_source",
        status: "draft",
      },
    });

    const recent = await listCharacterImageSources({ characterId });
    expect(recent.items).toContainEqual(first.asset);
  });

  it("keeps a library upload through publication and Review rejection until archive", async () => {
    const png = Uint8Array.from(await sharp({
      create: {
        width: 144,
        height: 180,
        channels: 3,
        background: { r: 72, g: 84, b: 112 },
      },
    }).png().toBuffer());
    const form = new FormData();
    form.set("purpose", "character_library");
    form.set("image", new File([png], "mara-cover.png", { type: "image/png" }));
    const parsed = await parseCharacterImageSourceForm(
      new Request("http://localhost", { method: "POST", body: form }),
    );
    const result = await createCharacterImageSource({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `character-library-${suffix}`,
      requestId: `character-library-request-${suffix}`,
      form: parsed,
    });

    expect(result.asset.qualification).toMatchObject({
      source: "operator_upload",
      state: "candidate",
      selectablePurposes: [],
      blockers: ["visual_authority_missing", "review_pending"],
      authority: {
        runId: null,
        itemId: null,
        reviewDecisionId: null,
        generationJobId: null,
      },
    });
    await expect(prisma.contentProductionItem.count({
      where: { mediaAssetId: result.asset.id },
    })).resolves.toBe(0);
    await expect(prisma.generationJob.count({
      where: { assets: { some: { id: result.asset.id } } },
    })).resolves.toBe(0);

    const library = await listCharacterImageSources({
      characterId,
      purpose: "character_library",
    });
    expect(library.items).toContainEqual(result.asset);

    for (const visibility of ["public_pack", "unlisted"]) {
      await prisma.mediaAsset.update({
        where: { id: result.asset.id },
        data: { visibility },
      });
      const afterPublication = await listCharacterImageSources({
        characterId,
        purpose: "character_library",
      });
      expect(afterPublication.items).toContainEqual(result.asset);
    }

    await prisma.creativeReviewDecision.create({
      data: {
        runItemId: null,
        artifactId: result.asset.id,
        decision: "rejected",
        identityConsistency: "failed",
        reason: "The uploaded candidate does not match the Character.",
        reviewerId: actorId,
      },
    });
    const afterRejection = await listCharacterImageSources({
      characterId,
      purpose: "character_library",
    });
    expect(afterRejection.items.find((asset) => asset.id === result.asset.id))
      .toMatchObject({ qualification: { state: "rejected" } });

    await prisma.$executeRaw`
      UPDATE "media_assets"
      SET "metadata" = jsonb_set("metadata", '{platformAsset,status}', '"archived"')
      WHERE "id" = ${result.asset.id}
    `;
    const afterArchive = await listCharacterImageSources({
      characterId,
      purpose: "character_library",
    });
    expect(afterArchive.items.map((asset) => asset.id)).not.toContain(result.asset.id);
  });

  it("keeps other Characters and identity experiments outside the library", async () => {
    const otherCharacterId = `image-source-other-character-${suffix}`;
    const sourceIds = [
      `image-source-private-experiment-${suffix}`,
      `image-source-published-experiment-${suffix}`,
      `image-source-other-library-${suffix}`,
    ];
    await prisma.character.create({
      data: {
        id: otherCharacterId,
        name: "Other Image Source",
        age: 30,
        description: "A separate Character whose library must stay isolated.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    try {
      await prisma.mediaAsset.createMany({
        data: sourceIds.map((id, index) => ({
          id,
          ownerId: actorId,
          characterId: index === 2 ? otherCharacterId : characterId,
          type: "image",
          url: `https://blob.example.test/${id}.png`,
          contentType: "image/png",
          visibility: index === 0 ? "private" : "public_pack",
          safetyStatus: "passed",
          metadata: {
            purpose: index === 2
              ? "character_library"
              : "identity_experiment_source",
          },
        })),
      });

      const library = await listCharacterImageSources({
        characterId,
        purpose: "character_library",
      });
      const libraryIds = library.items.map((asset) => asset.id);
      for (const sourceId of sourceIds) {
        expect(libraryIds).not.toContain(sourceId);
      }

      const identitySources = await listCharacterImageSources({ characterId });
      const identitySourceIds = identitySources.items.map((asset) => asset.id);
      expect(identitySourceIds).toContain(sourceIds[0]);
      expect(identitySourceIds).not.toContain(sourceIds[1]);
      expect(identitySourceIds).not.toContain(sourceIds[2]);
    } finally {
      await prisma.mediaAsset.deleteMany({ where: { id: { in: sourceIds } } });
      await prisma.character.delete({ where: { id: otherCharacterId } });
    }
  });
});
