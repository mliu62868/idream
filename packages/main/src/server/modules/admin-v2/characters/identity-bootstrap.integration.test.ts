import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as bootstrapIdentityRoute } from "@/app/api/v2/admin/characters/[id]/identity-bootstrap/route";
import { prisma } from "@/server/lib/db";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { loadCharacterIdentityBootstrapAuthority } from "./identity-bootstrap-authority";
import { recordCreativeReviewDecision } from "@/server/modules/admin-v2/creative/workflow";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

describe("Character first identity bootstrap authority", () => {
  const suffix = randomUUID();
  const actorId = `identity-bootstrap-admin-${suffix}`;
  const characterId = `identity-bootstrap-character-${suffix}`;
  const projectId = `identity-bootstrap-project-${suffix}`;
  const contentId = `identity-bootstrap-content-${suffix}`;
  const runId = `identity-bootstrap-run-${suffix}`;
  const itemId = `identity-bootstrap-item-${suffix}`;
  const jobId = `identity-bootstrap-job-${suffix}`;
  const assetId = `identity-bootstrap-asset-${suffix}`;
  const decisionId = `identity-bootstrap-decision-${suffix}`;
  const supersedingDecisionId = `identity-bootstrap-superseding-decision-${suffix}`;
  const legacyEmptyProfileId = `identity-bootstrap-empty-profile-${suffix}`;
  const idempotencyKey = `identity-bootstrap-command-${suffix}`;
  const bootstrapBrief = "A definitive first portrait of Mara that will establish identity authority.";
  const appearanceSnapshot = {
    identityAnchor: "Composed late-night radio host",
    stableTraits: ["dark wavy hair", "warm brown eyes"],
    style: "realistic",
    referenceDirection: "Low-key tungsten portraiture with an intimate editorial crop",
  };

  function request(
    confirmation = `BOOTSTRAP IDENTITY ${characterId}`,
    commandKey = idempotencyKey,
  ) {
    return new Request(`http://localhost/api/v2/admin/characters/${characterId}/identity-bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": commandKey,
        "if-match": "\"1\"",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": `identity-bootstrap-request-${suffix}`,
      },
      body: JSON.stringify({
        entityVersion: 1,
        runId,
        itemId,
        assetId,
        reviewDecisionId: decisionId,
        reason: "Establish the first reviewed portrait as the Character identity anchor",
        confirmation,
      }),
    });
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@idream.internal`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: actorId,
        name: "Mara",
        age: 28,
        gender: "female",
        style: "realistic",
        description: "A precise, warm late-night confidante.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "producing",
        audience: {},
        successCriteria: ["Identity is recognizable across customer surfaces"],
        activeKey: `identity-bootstrap:${characterId}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `identity-bootstrap-content-hash-${suffix}`,
        personaSnapshot: {
          name: "Mara",
          age: 28,
          gender: "female",
          description: "A precise, warm late-night confidante.",
        },
        openingSnapshot: {
          firstMessage: "You made it. What do you need to put down tonight?",
        },
        appearanceSnapshot,
        sourceType: "identity_bootstrap_test",
        createdById: actorId,
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: legacyEmptyProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Ungrounded legacy candidate",
        negativeIdentityPrompt: null,
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        evidenceState: "candidate",
        createdFrom: "admin_passport_edit",
      },
    });
    const bootstrapAuthority = await loadCharacterIdentityBootstrapAuthority(prisma, characterId);
    expect(bootstrapAuthority).toMatchObject({
      state: "recoverable_empty_history",
      allowed: true,
      nextVersion: 2,
      recoverableProfileIds: [legacyEmptyProfileId],
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Mara first identity portrait",
        purpose: "character_cover",
        targetType: "character",
        targetId: characterId,
        profileId: "redcraft-krea2",
        profileVersion: 1,
        presetIds: [],
        orientation: "4:5",
        brief: bootstrapBrief,
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        createdById: actorId,
      },
    });
    await prisma.contentProductionItem.create({
      data: {
        id: itemId,
        batchId: runId,
        itemIndex: 0,
        status: "approved",
        tags: [],
      },
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId: actorId,
        characterId,
        mode: "image",
        prompt: "A definitive first portrait of Mara.",
        controls: {},
        presetIds: [],
        model: "redcraft-krea2-txt2img",
        profileId: "redcraft-krea2",
        profileVersion: 1,
        orientation: "4:5",
        outputCount: 1,
        deliveredOutputCount: 1,
        status: "completed",
        sourceType: "content_production_item",
        sourceId: itemId,
        sourceMeta: {
          batchId: runId,
          purpose: "character_cover",
          targetType: "character",
          targetId: characterId,
          bootstrapIdentity: true,
          bootstrapProjectVersion: 1,
          characterContentVersionId: contentId,
          visualBriefHash: canonicalSha256({
            characterContentVersionId: contentId,
            appearanceSnapshot,
            brief: bootstrapBrief,
          }),
          bootstrapAuthorityState: bootstrapAuthority.state,
          expectedIdentityHistoryFingerprint: bootstrapAuthority.historyFingerprint,
          expectedIdentityVersion: bootstrapAuthority.nextVersion,
        },
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: actorId,
        sourceJobId: jobId,
        characterId,
        type: "image",
        url: `/assets/${assetId}.webp`,
        thumbnailUrl: `/assets/${assetId}-thumb.webp`,
        storageKey: `test-fixtures/${assetId}.webp`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.contentProductionItem.update({
      where: { id: itemId },
      data: { jobId, mediaAssetId: assetId },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: decisionId,
        runItemId: itemId,
        artifactId: assetId,
        decision: "approved",
        identityConsistency: "unscored",
        score: 92,
        evidence: { artifactFree: true, singleSubject: true, intentMatch: true, noVisibleText: true },
        reason: "Artifact, face count, intent, and customer context passed; this portrait defines identity.",
        reviewerId: actorId,
      },
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "character.identity.bootstrap" } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: projectId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.referenceCandidate.deleteMany({ where: { mediaAssetId: assetId } });
    const profiles = await prisma.characterVisualProfile.findMany({
      where: { characterId },
      select: { id: true },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { visualProfileId: { in: profiles.map((profile) => profile.id) } },
    });
    await prisma.characterVisualProfile.deleteMany({ where: { characterId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: itemId } });
    await prisma.contentProductionItem.deleteMany({ where: { id: itemId } });
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: runId } });
    await prisma.characterContentVersion.deleteMany({ where: { id: contentId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("rejects a mismatched high-intent confirmation before writing authority", async () => {
    const response = await bootstrapIdentityRoute(request("BOOTSTRAP IDENTITY another-character"), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(response.status).toBe(400);
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(1);
    await expect(prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: legacyEmptyProfileId },
    })).resolves.toMatchObject({ status: "active" });
  });

  it("rejects an approved decision after a newer review supersedes it", async () => {
    await prisma.creativeReviewDecision.create({
      data: {
        id: supersedingDecisionId,
        runItemId: itemId,
        artifactId: assetId,
        supersedesDecisionId: decisionId,
        decision: "rejected",
        identityConsistency: "unscored",
        evidence: {},
        reason: "A later review found that this candidate cannot establish identity authority.",
        reviewerId: actorId,
        createdAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    });

    try {
      const response = await bootstrapIdentityRoute(
        request(`BOOTSTRAP IDENTITY ${characterId}`, `identity-bootstrap-stale-review-${suffix}`),
        { params: Promise.resolve({ id: characterId }) },
      );
      expect(response.status).toBe(409);
      expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(1);
      await expect(prisma.characterVisualProfile.findUniqueOrThrow({
        where: { id: legacyEmptyProfileId },
      })).resolves.toMatchObject({ status: "active" });
    } finally {
      await prisma.creativeReviewDecision.deleteMany({ where: { id: supersedingDecisionId } });
    }
  });

  it("keeps ungrounded draft and generation history recoverable in Character Assets", async () => {
    await prisma.characterProject.update({
      where: { id: projectId },
      data: {
        draftImageAssetId: assetId,
        draftAssetPack: { character_cover: { assetId, runId, itemId } },
      },
    });
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { visualProfileId: legacyEmptyProfileId, visualProfileVersion: 1 },
    });

    try {
      await expect(loadCharacterIdentityBootstrapAuthority(prisma, characterId)).resolves.toMatchObject({
        state: "recoverable_empty_history",
        allowed: true,
        nextVersion: 2,
        blockers: [],
        recoverableProfileIds: [legacyEmptyProfileId],
      });
    } finally {
      await prisma.generationJob.update({
        where: { id: jobId },
        data: { visualProfileId: null, visualProfileVersion: null },
      });
      await prisma.characterProject.update({
        where: { id: projectId },
        data: { draftImageAssetId: null, draftAssetPack: {} },
      });
    }
  });

  it("only treats an available and safely ownable current Character image as bootstrap authority", async () => {
    const foreignCharacterId = `identity-bootstrap-foreign-character-${suffix}`;
    const deletedAssetId = `identity-bootstrap-deleted-image-${suffix}`;
    const blockedAssetId = `identity-bootstrap-blocked-image-${suffix}`;
    const archivedAssetId = `identity-bootstrap-archived-image-${suffix}`;
    const foreignAssetId = `identity-bootstrap-foreign-image-${suffix}`;
    const sharedAssetId = `identity-bootstrap-shared-image-${suffix}`;
    const uniqueAssetId = `identity-bootstrap-unique-image-${suffix}`;
    const ownedAssetId = `identity-bootstrap-owned-image-${suffix}`;
    const assetIds = [
      deletedAssetId,
      blockedAssetId,
      archivedAssetId,
      foreignAssetId,
      sharedAssetId,
      uniqueAssetId,
      ownedAssetId,
    ];
    await prisma.character.create({
      data: {
        id: foreignCharacterId,
        creatorId: actorId,
        name: "Foreign identity owner",
        age: 31,
        description: "A separate Character authority fixture.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: deletedAssetId,
          ownerId: actorId,
          type: "image",
          url: `/assets/${deletedAssetId}.webp`,
          storageKey: `test-fixtures/${deletedAssetId}.webp`,
          safetyStatus: "passed",
          deletedAt: new Date(),
          metadata: {},
        },
        {
          id: blockedAssetId,
          ownerId: actorId,
          type: "image",
          url: `/assets/${blockedAssetId}.webp`,
          storageKey: `test-fixtures/${blockedAssetId}.webp`,
          safetyStatus: "blocked",
          metadata: {},
        },
        {
          id: archivedAssetId,
          ownerId: actorId,
          characterId,
          type: "image",
          url: `/assets/${archivedAssetId}.webp`,
          storageKey: `test-fixtures/${archivedAssetId}.webp`,
          safetyStatus: "passed",
          metadata: { platformAsset: { status: "archived" } },
        },
        {
          id: foreignAssetId,
          ownerId: actorId,
          characterId: foreignCharacterId,
          type: "image",
          url: `/assets/${foreignAssetId}.webp`,
          storageKey: `test-fixtures/${foreignAssetId}.webp`,
          safetyStatus: "passed",
          metadata: {},
        },
        ...[sharedAssetId, uniqueAssetId].map((id) => ({
          id,
          ownerId: actorId,
          type: "image",
          url: `/assets/${id}.webp`,
          storageKey: `test-fixtures/${id}.webp`,
          safetyStatus: "passed",
          metadata: {},
        })),
        {
          id: ownedAssetId,
          ownerId: actorId,
          characterId,
          type: "image",
          url: `/assets/${ownedAssetId}.webp`,
          storageKey: `test-fixtures/${ownedAssetId}.webp`,
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });

    try {
      for (const unusableAssetId of [
        deletedAssetId,
        blockedAssetId,
        archivedAssetId,
        foreignAssetId,
      ]) {
        await prisma.character.update({
          where: { id: characterId },
          data: { imageAssetId: unusableAssetId },
        });
        await expect(loadCharacterIdentityBootstrapAuthority(prisma, characterId)).resolves.toMatchObject({
          state: "recoverable_empty_history",
          allowed: true,
          blockers: [],
        });
      }

      await prisma.character.update({
        where: { id: foreignCharacterId },
        data: { imageAssetId: sharedAssetId },
      });
      await prisma.character.update({
        where: { id: characterId },
        data: { imageAssetId: sharedAssetId },
      });
      await expect(loadCharacterIdentityBootstrapAuthority(prisma, characterId)).resolves.toMatchObject({
        state: "recoverable_empty_history",
        allowed: true,
        blockers: [],
      });

      await prisma.character.update({
        where: { id: foreignCharacterId },
        data: { imageAssetId: null },
      });
      for (const usableAssetId of [uniqueAssetId, ownedAssetId]) {
        await prisma.character.update({
          where: { id: characterId },
          data: { imageAssetId: usableAssetId },
        });
        await expect(loadCharacterIdentityBootstrapAuthority(prisma, characterId)).resolves.toMatchObject({
          state: "blocked_existing_authority",
          allowed: false,
          blockers: ["character_image_already_selected"],
        });
      }
    } finally {
      await prisma.character.update({
        where: { id: characterId },
        data: { imageAssetId: null },
      });
      await prisma.character.update({
        where: { id: foreignCharacterId },
        data: { imageAssetId: null },
      });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
      await prisma.character.delete({ where: { id: foreignCharacterId } });
    }
  });

  it("atomically supersedes recoverable empty history with sealed reviewed identity authority", async () => {
    await prisma.characterProject.update({
      where: { id: projectId },
      data: {
        draftAssetPack: {
          character_hero: {
            assetId: `stale-hero-${suffix}`,
            runId: `stale-hero-run-${suffix}`,
          },
          character_chat: {
            assetId: `stale-chat-${suffix}`,
            runId: `stale-chat-run-${suffix}`,
          },
        },
      },
    });
    const refreshedAuthority = await loadCharacterIdentityBootstrapAuthority(prisma, characterId);
    const bootstrapJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (
      bootstrapJob.sourceMeta === null ||
      typeof bootstrapJob.sourceMeta !== "object" ||
      Array.isArray(bootstrapJob.sourceMeta)
    ) {
      throw new Error("Expected bootstrap source metadata");
    }
    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        sourceMeta: toInputJson({
          ...bootstrapJob.sourceMeta,
          expectedIdentityHistoryFingerprint: refreshedAuthority.historyFingerprint,
        }),
      },
    });
    const response = await bootstrapIdentityRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        characterId,
        projectVersion: 2,
        visualProfileVersion: 2,
        referenceSetRevision: 1,
        anchorAssetId: assetId,
        draftImageAssetId: assetId,
        replayed: false,
      },
    });

    const profile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    expect(profile).toMatchObject({
      version: 2,
      style: "realistic",
      anchorAssetIds: [assetId],
      referenceAssetIds: [assetId],
      evidenceState: "reviewed_bootstrap",
      createdFrom: `identity_bootstrap:${jobId}`,
    });
    expect(profile.identityPrompt).toContain(
      "Preserve the exact same adult person shown in the canonical identity portrait",
    );
    expect(profile.identityPrompt).not.toContain(
      "A precise, warm late-night confidante.",
    );
    expect(profile.immutableHash).toBe(characterVisualProfileSnapshotHash(profile));
    await expect(prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: legacyEmptyProfileId },
    })).resolves.toMatchObject({ status: "archived" });

    const referenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profile.id, status: "active" },
      include: { references: true },
    });
    expect(referenceSet.references).toEqual([
      expect.objectContaining({
        mediaAssetId: assetId,
        position: 0,
        role: "primary_face",
        weight: 1,
      }),
    ]);
    expect(referenceSet.snapshotHash).toBe(referenceSetSnapshotHash(referenceSet));
    const bootstrappedProject = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(bootstrappedProject).toMatchObject({
      version: 2,
      draftImageAssetId: assetId,
      draftAssetPack: {
        character_cover: expect.objectContaining({
          assetId,
          runId,
          itemId,
          generationJobId: jobId,
          bootstrapIdentity: true,
        }),
      },
    });
    expect(bootstrappedProject.draftAssetPack).toEqual({
      character_cover: expect.objectContaining({
        assetId,
        runId,
        itemId,
        generationJobId: jobId,
        bootstrapIdentity: true,
      }),
    });
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } })).resolves.toMatchObject({
      imageAssetId: null,
    });
    expect(await prisma.adminAuditLog.count({
      where: { targetId: projectId, action: "character.identity.bootstrapped" },
    })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({
      where: { aggregateId: projectId, eventType: "character.identity.bootstrapped.v2" },
    })).toBe(1);
  });

  it("prevents review revocation while the portrait is active Character authority", async () => {
    await expect(recordCreativeReviewDecision({
      runId,
      itemId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: 1,
      supersedesDecisionId: decisionId,
      decision: "rejected",
      identityConsistency: "unscored",
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "A bound identity anchor must be withdrawn before its review can change",
      requestId: `identity-bootstrap-bound-review-${suffix}`,
    })).rejects.toMatchObject({ status: 409 });
    await expect(prisma.creativeReviewDecision.findFirst({
      where: { runItemId: itemId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })).resolves.toMatchObject({ id: decisionId, decision: "approved" });
  });

  it("replays the same atomic command without duplicating profile or reference revisions", async () => {
    const response = await bootstrapIdentityRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { replayed: true, projectVersion: 2 } });
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(2);
    expect(await prisma.referenceSetRevision.count()).toBeGreaterThanOrEqual(1);
  });
});
