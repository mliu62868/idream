import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as patchContentAssetRoute } from "@/app/api/v2/admin/assets/[id]/route";
import { prisma } from "@/server/lib/db";
import { selectCharacterDraftImage } from "./asset-studio";
import {
  CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
  characterImageQualifications,
} from "./image-qualification";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";

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
  const visualProfileId = `image-placement-visual-${suffix}`;
  const referenceSetId = `image-placement-references-${suffix}`;
  const visualProfileHash = characterVisualProfileSnapshotHash({
    version: 1,
    style: "realistic",
    identityPrompt: "same adult character",
    negativeIdentityPrompt: null,
    faceTraits: {},
    hairTraits: {},
    bodyTraits: {},
    signatureTraits: {},
    styleTraits: {},
  });
  const referenceSetHash = referenceSetSnapshotHash({
    visualProfileId,
    revision: 1,
    selectorVersion: "asset-studio-test-v1",
    references: [{
      mediaAssetId: currentAssetId,
      position: 0,
      role: "identity_anchor",
      weight: 1,
    }],
  });
  const digest = "a".repeat(64);
  const reviewId = (assetId: string) => `review-${assetId}`;

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
          source: "admin_asset_upload",
          sha256: digest,
          uploadAuthority: {
            schemaVersion: "platform-asset-operator-upload-v1",
            kind: "operator_upload",
            assetId: id,
            uploadedById: actorId,
            sha256: digest,
          },
          platformAsset: { status: "draft", purpose: "character_library" },
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
    await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "same adult character",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [currentAssetId],
        adapterRefs: {},
        immutableHash: visualProfileHash,
        evidenceState: "sealed",
        createdFrom: "asset_studio_test",
      },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "asset-studio-test-v1",
        snapshotHash: referenceSetHash,
        createdFrom: "asset_studio_test",
        references: {
          create: {
            mediaAssetId: currentAssetId,
            position: 0,
            role: "identity_anchor",
            selectionReason: "sealed identity fixture",
          },
        },
      },
    });
    await prisma.creativeReviewDecision.createMany({
      data: [coverAssetId, heroAssetId, chatAssetId].map((assetId) => ({
        id: reviewId(assetId),
        runItemId: null,
        artifactId: assetId,
        decision: "approved",
        identityConsistency: "passed",
        score: 95,
        reason: "Reviewed against the sealed Character identity.",
        reviewerId: actorId,
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          characterImageImport: {
            schemaVersion: CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
            source: "operator_upload",
            characterId,
            assetId,
            visualProfileId,
            visualProfileVersion: 1,
            visualProfileHash,
            referenceSetRevisionId: referenceSetId,
            referenceSetSnapshotHash: referenceSetHash,
          },
        },
      })),
    });
  });

  afterAll(async () => {
    await prisma.creativeReviewDecision.deleteMany({ where: { reviewerId: actorId } });
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

  it("selects three reviewed operator uploads without generation lineage", async () => {
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 1,
      purpose: "character_cover",
      assetId: unusedAssetId,
      actor: { id: actorId, role: "admin" },
      reason: "An unreviewed upload must remain only a candidate",
      requestId: `image-placement-unreviewed-${suffix}`,
    })).rejects.toMatchObject({
      status: 409,
      message: "Review this image before choosing it for Character operations",
      details: expect.objectContaining({ state: "candidate" }),
    });

    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 1,
      purpose: "character_cover",
      assetId: coverAssetId,
      reviewDecisionId: reviewId(coverAssetId),
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
      reviewDecisionId: reviewId(heroAssetId),
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
      reviewDecisionId: reviewId(chatAssetId),
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
        character_cover: {
          assetId: coverAssetId,
          reviewDecisionId: reviewId(coverAssetId),
        },
        character_hero: {
          assetId: heroAssetId,
          reviewDecisionId: reviewId(heroAssetId),
        },
        character_chat: {
          assetId: chatAssetId,
          reviewDecisionId: reviewId(chatAssetId),
        },
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
      reviewDecisionId: reviewId(heroAssetId),
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

  it("surfaces a selected placement whose pinned Review was superseded", async () => {
    const latestReviewId = `review-latest-${heroAssetId}`;
    await prisma.creativeReviewDecision.create({
      data: {
        id: latestReviewId,
        runItemId: null,
        artifactId: heroAssetId,
        supersedesDecisionId: reviewId(heroAssetId),
        decision: "approved",
        identityConsistency: "passed",
        score: 96,
        reason: "New Review decision against the same sealed identity.",
        reviewerId: actorId,
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          characterImageImport: {
            schemaVersion: CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
            source: "operator_upload",
            characterId,
            assetId: heroAssetId,
            visualProfileId,
            visualProfileVersion: 1,
            visualProfileHash,
            referenceSetRevisionId: referenceSetId,
            referenceSetSnapshotHash: referenceSetHash,
          },
        },
      },
    });
    const hero = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: heroAssetId },
    });
    const qualifications = await characterImageQualifications(
      prisma,
      characterId,
      [hero],
    );

    expect(qualifications.get(heroAssetId)).toMatchObject({
      state: "selected",
      blockers: ["review_authority_changed"],
      releaseQualifiedPurposes: [],
      authority: { reviewDecisionId: latestReviewId },
    });
  });
});
