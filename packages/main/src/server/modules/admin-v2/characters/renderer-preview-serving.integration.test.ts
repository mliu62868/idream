import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { getCharacterWorkspace } from "./workspace";
import { issueCharacterPreviewToken } from "./preview-token";
import { loadCharacterRendererPreview } from "./renderer-preview";

describe.sequential("Character renderer preview Serving authority", () => {
  const suffix = randomUUID();
  const ownerId = `renderer-serving-owner-${suffix}`;
  const characterId = `renderer-serving-character-${suffix}`;
  const projectId = `renderer-serving-project-${suffix}`;
  const contentId = `renderer-serving-content-${suffix}`;
  const revisionId = `renderer-serving-revision-${suffix}`;
  const rollbackRevisionId = `renderer-serving-rollback-revision-${suffix}`;
  const releaseId = `renderer-serving-release-${suffix}`;
  const rollbackReleaseId = `renderer-serving-rollback-release-${suffix}`;
  const servingId = `renderer-serving-pointer-${suffix}`;
  const assetPack = {
    character_cover: `renderer-serving-cover-${suffix}`,
    character_hero: `renderer-serving-hero-${suffix}`,
    character_chat: `renderer-serving-chat-${suffix}`,
  };
  const releasePlacementManifest = {
    schemaVersion: 1,
    kind: "editorial_import",
    placements: [
      {
        slotKey: "character_avatar",
        assetId: assetPack.character_cover,
        slotVersion: 1,
      },
      {
        slotKey: "character_hero",
        assetId: assetPack.character_hero,
        slotVersion: 1,
      },
      {
        slotKey: "character_chat",
        assetId: assetPack.character_chat,
        slotVersion: 1,
      },
    ],
  };

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@idream.internal`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: ownerId,
        name: "Serving Truth",
        age: 29,
        description: "A fixture whose preview follows the real Serving pointer.",
        source: "official",
        visibility: "public",
        status: "approved",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.mediaAsset.createMany({
      data: Object.values(assetPack).map((id) => ({
        id,
        ownerId,
        characterId,
        type: "image",
        url: `/assets/${id}.webp`,
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: { source: "editorial_import", synthetic: false },
      })),
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: assetPack.character_cover },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        ownerId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
        draftImageAssetId: assetPack.character_cover,
        draftAssetPack: {
          character_cover: assetPack.character_cover,
          character_hero: assetPack.character_hero,
          character_chat: assetPack.character_chat,
        },
        activeKey: `renderer-serving:${characterId}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `renderer-serving-content-hash-${suffix}`,
        personaSnapshot: {
          name: "Serving Truth",
          description: "A fixture whose preview follows the real Serving pointer.",
          exampleDialogue: ["The active pointer is the truth."],
        },
        openingSnapshot: { firstMessage: "Only the active Release is live." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "renderer_serving_test",
        createdById: ownerId,
      },
    });
    await prisma.characterRevision.createMany({
      data: [
        {
          id: revisionId,
          projectId,
          revision: 1,
          characterContentVersionId: contentId,
          projectSnapshot: {},
          createdById: ownerId,
        },
        {
          id: rollbackRevisionId,
          projectId,
          revision: 2,
          characterContentVersionId: contentId,
          projectSnapshot: {},
          createdById: ownerId,
        },
      ],
    });
    await prisma.characterRelease.createMany({
      data: [
        {
          id: releaseId,
          projectId,
          revisionId,
          characterContentVersionId: contentId,
          generationProvenance: {
            schemaVersion: "character-release-editorial-import-v1",
            dataset: "renderer-preview-serving-fixture",
            recordId: characterId,
            sourceAssetId: assetPack.character_cover,
          },
          releasePlacementManifest,
          snapshotHash: `renderer-serving-release-hash-${suffix}`,
          readiness: "ready",
          legacy: true,
          status: "published",
          publishedAt: new Date(),
        },
        {
          id: rollbackReleaseId,
          projectId,
          revisionId: rollbackRevisionId,
          characterContentVersionId: contentId,
          generationProvenance: {
            schemaVersion: "character-release-editorial-import-v1",
            dataset: "renderer-preview-serving-fixture",
            recordId: characterId,
            sourceAssetId: assetPack.character_cover,
          },
          releasePlacementManifest,
          snapshotHash: `renderer-serving-rollback-hash-${suffix}`,
          readiness: "ready",
          legacy: true,
          status: "published",
          publishedAt: new Date(),
          supersedesId: releaseId,
          rollbackOfReleaseId: releaseId,
        },
      ],
    });
    await prisma.publicCatalogQualification.createMany({
      data: [
        {
          id: `renderer-serving-qualification-${suffix}`,
          releaseId,
          releaseSnapshotHash: `renderer-serving-release-hash-${suffix}`,
          kind: "editorial_import",
          evidence: {
            schemaVersion: "public-catalog-qualification-v1",
            policyVersion: "public-catalog-editorial-import-v1",
            sourceAssetId: assetPack.character_cover,
          },
        },
        {
          id: `renderer-serving-rollback-qualification-${suffix}`,
          releaseId: rollbackReleaseId,
          releaseSnapshotHash: `renderer-serving-rollback-hash-${suffix}`,
          kind: "editorial_import",
          evidence: {
            schemaVersion: "public-catalog-qualification-v1",
            policyVersion: "public-catalog-editorial-import-v1",
            sourceAssetId: assetPack.character_cover,
          },
        },
      ],
    });
    await prisma.characterServing.create({
      data: {
        id: servingId,
        characterId,
        currentReleaseId: releaseId,
        state: "live",
      },
    });
  });

  afterAll(async () => {
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { in: [releaseId, rollbackReleaseId] } },
    });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: Object.values(assetPack) } },
    });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  async function liveToken() {
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
      select: { version: true },
    });
    return issueCharacterPreviewToken(
      {
        characterId,
        contentVersionId: contentId,
        releaseId,
        servingVersion: serving.version,
        imageAssetId: assetPack.character_cover,
        assetPack,
        label: "Live",
      },
      env.BETTER_AUTH_SECRET,
    );
  }

  it("projects a Live snapshot only while CharacterServing is live", async () => {
    await expect(getCharacterWorkspace(characterId)).resolves.toMatchObject({
      preview: {
        live: {
          releaseId,
          label: "Live",
          assetPackReady: true,
          renderUrl: expect.any(String),
        },
      },
    });

    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "paused" },
    });
    try {
      await expect(getCharacterWorkspace(characterId)).resolves.toMatchObject({
        preview: { live: null },
      });
    } finally {
      await prisma.characterServing.update({
        where: { characterId },
        data: { state: "live" },
      });
    }
  });

  it("invalidates a Live token while Serving is paused", async () => {
    const token = await liveToken();
    await expect(loadCharacterRendererPreview(token)).resolves.toMatchObject({
      authority: { releaseId, label: "Live" },
    });

    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "paused" },
    });
    try {
      await expect(loadCharacterRendererPreview(token)).resolves.toBeNull();
    } finally {
      await prisma.characterServing.update({
        where: { characterId },
        data: { state: "live", version: { increment: 1 } },
      });
    }
    await expect(loadCharacterRendererPreview(token)).resolves.toBeNull();
  });

  it("invalidates the old Live token after a rollback swaps the Serving pointer", async () => {
    const token = await liveToken();
    await expect(loadCharacterRendererPreview(token)).resolves.not.toBeNull();

    await prisma.characterServing.update({
      where: { characterId },
      data: {
        currentReleaseId: rollbackReleaseId,
        version: { increment: 1 },
      },
    });
    try {
      await expect(loadCharacterRendererPreview(token)).resolves.toBeNull();
      await expect(getCharacterWorkspace(characterId)).resolves.toMatchObject({
        preview: {
          live: {
            releaseId: rollbackReleaseId,
            label: "Live",
          },
        },
      });
    } finally {
      await prisma.characterServing.update({
        where: { characterId },
        data: {
          currentReleaseId: releaseId,
          version: { increment: 1 },
        },
      });
    }
    await expect(loadCharacterRendererPreview(token)).resolves.toBeNull();
  });
});
