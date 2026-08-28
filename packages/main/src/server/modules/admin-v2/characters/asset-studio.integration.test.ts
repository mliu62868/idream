import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as patchContentAssetRoute } from "@/app/api/v2/admin/assets/[id]/route";
import { prisma } from "@/server/lib/db";
import { selectCharacterDraftImage } from "./asset-studio";

async function patchContentAsset(request: Request, id: string): Promise<Response> {
  const response = await patchContentAssetRoute(request, {
    params: Promise.resolve({ id }),
  });
  if (response.ok) return response;
  const payload = await response.clone().json() as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  throw Object.assign(new Error(payload.error?.message ?? "Admin v2 request failed"), {
    status: response.status,
    code: payload.error?.code,
    details: payload.error?.details,
  });
}

describe.sequential("Character image placement authority", () => {
  const suffix = randomUUID();
  const actorId = `image-placement-admin-${suffix}`;
  const characterId = `image-placement-character-${suffix}`;
  const projectId = `image-placement-project-${suffix}`;
  const currentAssetId = `image-placement-current-${suffix}`;
  const coverAssetId = `image-placement-cover-${suffix}`;
  const heroAssetId = `image-placement-hero-${suffix}`;
  const chatAssetId = `image-placement-chat-${suffix}`;
  const unusedAssetId = `image-placement-unused-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@idream.internal`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: currentAssetId,
        ownerId: actorId,
        type: "image",
        url: `/assets/${currentAssetId}.webp`,
        storageKey: `test-fixtures/${currentAssetId}.webp`,
        safetyStatus: "passed",
        metadata: { source: "upload" },
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: actorId,
        name: "Aria",
        age: 27,
        description: "A warm, observant storyteller.",
        source: "official",
        appearance: {},
        advancedDetails: {},
        imageAssetId: currentAssetId,
      },
    });
    await prisma.mediaAsset.update({
      where: { id: currentAssetId },
      data: { characterId },
    });
    await prisma.mediaAsset.createMany({
      data: [coverAssetId, heroAssetId, chatAssetId, unusedAssetId].map((id) => ({
        id,
        ownerId: actorId,
        characterId,
        type: "image" as const,
        url: `/assets/${id}.webp`,
        storageKey: `test-fixtures/${id}.webp`,
        safetyStatus: "passed" as const,
        metadata: {
          source: "upload",
          platformAsset: { status: "generated", purpose: "character_library" },
        },
      })),
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        activeKey: `image-placement:${characterId}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: projectId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            currentAssetId,
            coverAssetId,
            heroAssetId,
            chatAssetId,
            unusedAssetId,
          ],
        },
      },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("selects three role images without generation or review lineage", async () => {
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 1,
      purpose: "character_cover",
      assetId: coverAssetId,
      actor: { id: actorId, role: "admin" },
      reason: "Use an imported role image as the cover",
      requestId: `image-placement-cover-${suffix}`,
    })).resolves.toMatchObject({
      characterId,
      projectVersion: 2,
      selectedPurpose: "character_cover",
      draftImageAssetId: coverAssetId,
      draftAssetPack: { character_cover: coverAssetId },
    });

    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 2,
      purpose: "character_hero",
      assetId: heroAssetId,
      actor: { id: actorId, role: "admin" },
      reason: "Use an imported role image as the hero",
      requestId: `image-placement-hero-${suffix}`,
    })).resolves.toMatchObject({
      projectVersion: 3,
      draftAssetPack: {
        character_cover: coverAssetId,
        character_hero: heroAssetId,
      },
    });

    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 3,
      purpose: "character_chat",
      assetId: chatAssetId,
      actor: { id: actorId, role: "admin" },
      reason: "Use an imported role image in Chat",
      requestId: `image-placement-chat-${suffix}`,
    })).resolves.toMatchObject({
      projectVersion: 4,
      draftAssetPack: {
        character_cover: coverAssetId,
        character_hero: heroAssetId,
        character_chat: chatAssetId,
      },
      deepLink: `/admin/characters/${characterId}?tab=preview`,
    });

    await expect(prisma.characterProject.findUniqueOrThrow({
      where: { id: projectId },
    })).resolves.toMatchObject({
      version: 4,
      draftImageAssetId: coverAssetId,
      draftAssetPack: {
        character_cover: { assetId: coverAssetId },
        character_hero: { assetId: heroAssetId },
        character_chat: { assetId: chatAssetId },
      },
    });
    await expect(prisma.character.findUniqueOrThrow({
      where: { id: characterId },
    })).resolves.toMatchObject({ imageAssetId: currentAssetId });
  });

  it("keeps placement and archive responsibilities explicit", async () => {
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 4,
      purpose: "character_chat",
      assetId: heroAssetId,
      actor: { id: actorId, role: "admin" },
      reason: "A placement must not reuse another placement image",
      requestId: `image-placement-duplicate-${suffix}`,
    })).rejects.toMatchObject({
      status: 409,
      message: "Each Character placement must use a different image",
    });

    await expect(patchContentAsset(
      new Request(`http://localhost/api/v2/admin/assets/${coverAssetId}`, {
        method: "PATCH",
        headers: {
          "idempotency-key": `image-placement-cover-archive-${suffix}`,
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          status: "archived",
          reason: "Attempt to archive an image currently used by operations",
          confirmation: coverAssetId,
        }),
      }),
      coverAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        dependencies: expect.arrayContaining([
          expect.objectContaining({ kind: "character_project_draft", projectId }),
        ]),
      },
    });

    await expect(patchContentAsset(
      new Request(`http://localhost/api/v2/admin/assets/${unusedAssetId}`, {
        method: "PATCH",
        headers: {
          "idempotency-key": `image-placement-unused-archive-${suffix}`,
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          status: "archived",
          reason: "Remove an unused image from the role library",
          confirmation: unusedAssetId,
        }),
      }),
      unusedAssetId,
    )).resolves.toMatchObject({ status: 200 });

    const unusedAsset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: unusedAssetId },
    });
    expect(unusedAsset.metadata).toMatchObject({
      platformAsset: { status: "archived" },
    });
  });
});
