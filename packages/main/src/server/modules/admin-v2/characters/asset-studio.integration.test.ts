import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { selectCharacterDraftImage } from "./asset-studio";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";
import { recordCreativeReviewDecision } from "@/server/modules/admin-v2/creative/workflow";
import { publishCharacterReferenceSet } from "./reference-set";
import { getCharacterWorkspace } from "./workspace";
import { issueCharacterPreviewToken } from "./preview-token";
import { loadCharacterRendererPreview } from "./renderer-preview";
import { createCharacterVisualProfile } from "@/server/modules/admin/characters/visual-profiles";
import { patchContentAsset } from "@/server/modules/admin/content-ops";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import { toInputJson } from "../shared/prisma-json";

describe.sequential("Character Asset Studio draft image authority", () => {
  const suffix = randomUUID();
  const actorId = `asset-studio-admin-${suffix}`;
  const characterId = `asset-studio-character-${suffix}`;
  const projectId = `asset-studio-project-${suffix}`;
  const currentAssetId = `asset-studio-current-${suffix}`;
  const candidateAssetId = `asset-studio-candidate-${suffix}`;
  const runId = `asset-studio-run-${suffix}`;
  const itemId = `asset-studio-item-${suffix}`;
  const jobId = `asset-studio-job-${suffix}`;
  const legacyDecisionId = `asset-studio-legacy-decision-${suffix}`;
  const decisionId = `asset-studio-decision-${suffix}`;
  let serializedDecisionId = "";
  let serializedRunVersion = 1;
  const heroAssetId = `asset-studio-hero-${suffix}`;
  const heroRunId = `asset-studio-hero-run-${suffix}`;
  const heroItemId = `asset-studio-hero-item-${suffix}`;
  const heroJobId = `asset-studio-hero-job-${suffix}`;
  const heroDecisionId = `asset-studio-hero-decision-${suffix}`;
  const chatAssetId = `asset-studio-chat-${suffix}`;
  const chatRunId = `asset-studio-chat-run-${suffix}`;
  const chatItemId = `asset-studio-chat-item-${suffix}`;
  const chatJobId = `asset-studio-chat-job-${suffix}`;
  const chatDecisionId = `asset-studio-chat-decision-${suffix}`;
  const contentId = `asset-studio-content-${suffix}`;
  const visualProfileId = `asset-studio-visual-${suffix}`;
  const referenceSetId = `asset-studio-reference-set-${suffix}`;
  const generationModelProfileId = `asset-studio-model-profile-${suffix}`;
  const generationProfileKey = `asset-studio-profile-${suffix}`;
  const routeQualificationId = `asset-studio-route-q1-${suffix}`;
  const routeFingerprint = `asset-studio-route-fingerprint-q1-${suffix}`;
  const replacementRouteQualificationId = `asset-studio-route-q2-${suffix}`;
  const replacementRouteFingerprint = `asset-studio-route-fingerprint-q2-${suffix}`;
  const workflowKey = "qwen-image-edit-img2img";

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" },
    });
    await prisma.mediaAsset.create({
      data: { id: currentAssetId, ownerId: actorId, type: "image", url: `/assets/${currentAssetId}.webp`, storageKey: `test-fixtures/${currentAssetId}.webp`, safetyStatus: "passed", metadata: {} },
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
    await prisma.mediaAsset.create({
      data: { id: candidateAssetId, ownerId: actorId, characterId, type: "image", url: `/assets/${candidateAssetId}.webp`, storageKey: `test-fixtures/${candidateAssetId}.webp`, safetyStatus: "passed", metadata: {} },
    });
    await prisma.mediaAsset.createMany({ data: [
      { id: heroAssetId, ownerId: actorId, characterId, type: "image", url: `/assets/${heroAssetId}.webp`, storageKey: `test-fixtures/${heroAssetId}.webp`, safetyStatus: "passed", metadata: {} },
      { id: chatAssetId, ownerId: actorId, characterId, type: "image", url: `/assets/${chatAssetId}.webp`, storageKey: `test-fixtures/${chatAssetId}.webp`, safetyStatus: "passed", metadata: {} },
    ] });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "producing",
        audience: {},
        successCriteria: [],
        activeKey: `asset-studio:${characterId}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `asset-studio-content-hash-${suffix}`,
        personaSnapshot: { name: "Aria", description: "A warm, observant storyteller." },
        openingSnapshot: { firstMessage: "Tell me what caught your attention today." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "asset_studio_test",
        createdById: actorId,
      },
    });
    const visualProfile = await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Aria, the same warm observant storyteller",
        negativeIdentityPrompt: "identity drift, different person",
        faceTraits: { identity: "Aria" },
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [currentAssetId],
        referenceAssetIds: [currentAssetId],
        adapterRefs: {},
        evidenceState: "reviewed_bootstrap",
        createdFrom: "asset_studio_test",
      },
    });
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { immutableHash: characterVisualProfileSnapshotHash(visualProfile) },
    });
    const referenceFixture = [{
      mediaAssetId: currentAssetId,
      position: 0,
      role: "primary_face",
      weight: 1,
      selectorVersion: "asset-studio-test-v1",
      selectionReason: "Canonical Aria identity",
      qualityScore: 95,
      identityScore: 0.97,
    }];
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "asset-studio-test-v1",
        createdFrom: "asset_studio_test",
        snapshotHash: referenceSetSnapshotHash({
          visualProfileId,
          revision: 1,
          selectorVersion: "asset-studio-test-v1",
          references: referenceFixture,
        }),
        references: { create: referenceFixture },
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: generationModelProfileId,
        profileKey: generationProfileKey,
        label: "Asset Studio qualified identity route",
        runner: "comfyui",
        pipelineModel: workflowKey,
        workflowKey,
        runnerConfig: {
          capabilities: { referenceImages: true, initImage: true },
        },
        allowedOrientations: ["4:5", "16:9"],
        version: 1,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: routeQualificationId,
        routeFingerprint,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `asset-studio-route-matrix-q1-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.98,
        result: "qualified",
        evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Aria primary portrait",
        purpose: "character_cover",
        targetType: "character",
        targetId: characterId,
        presetIds: [],
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
        mediaAssetId: candidateAssetId,
        itemIndex: 0,
        status: "approved",
        tags: [],
      },
    });
    await prisma.generationJob.create({ data: {
      id: jobId,
      userId: actorId,
      characterId,
      mode: "image",
      controls: {},
      presetIds: [],
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
        bootstrapIdentity: false,
        referenceSetRevisionId: referenceSetId,
        generationRouteQualificationId: routeQualificationId,
        generationRouteFingerprint: routeFingerprint,
      },
      visualProfileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      referenceAssetIds: [currentAssetId],
      model: workflowKey,
      profileId: generationProfileKey,
      profileVersion: 1,
      provider: "comfyui",
      completedAt: new Date(),
    } });
    await prisma.generationAttempt.create({
      data: {
        id: `asset-studio-attempt-${suffix}`,
        requestId: jobId,
        attemptNo: 1,
        provider: "comfyui",
        profileKey: generationProfileKey,
        profileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        status: "succeeded",
      },
    });
    await prisma.contentProductionItem.update({ where: { id: itemId }, data: { jobId } });
    await prisma.mediaAsset.update({ where: { id: candidateAssetId }, data: { sourceJobId: jobId } });
    await prisma.creativeReviewDecision.create({
      data: {
        id: legacyDecisionId,
        runItemId: itemId,
        artifactId: candidateAssetId,
        decision: "approved",
        identityConsistency: "passed",
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
        },
        reason: "Earlier approval was complete but has since been superseded.",
        reviewerId: actorId,
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: decisionId,
        runItemId: itemId,
        artifactId: candidateAssetId,
        supersedesDecisionId: legacyDecisionId,
        decision: "approved",
        identityConsistency: "passed",
        score: 97,
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
        },
        reason: "Face structure and identity markers match the locked character.",
        reviewerId: actorId,
      },
    });
    for (const fixture of [
      { runId: heroRunId, itemId: heroItemId, jobId: heroJobId, assetId: heroAssetId, purpose: "character_hero", decisionId: heroDecisionId },
      { runId: chatRunId, itemId: chatItemId, jobId: chatJobId, assetId: chatAssetId, purpose: "character_chat", decisionId: chatDecisionId },
    ]) {
      await prisma.contentProductionBatch.create({
        data: {
          id: fixture.runId,
          title: fixture.purpose,
          purpose: fixture.purpose,
          targetType: "character",
          targetId: characterId,
          presetIds: [],
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
        data: { id: fixture.itemId, batchId: fixture.runId, mediaAssetId: fixture.assetId, itemIndex: 0, status: "approved", tags: [] },
      });
      await prisma.generationJob.create({ data: {
        id: fixture.jobId,
        userId: actorId,
        characterId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        deliveredOutputCount: 1,
        status: "completed",
        sourceType: "content_production_item",
        sourceId: fixture.itemId,
        sourceMeta: {
          batchId: fixture.runId,
          purpose: fixture.purpose,
          targetType: "character",
          targetId: characterId,
          bootstrapIdentity: false,
          referenceSetRevisionId: referenceSetId,
          generationRouteQualificationId: routeQualificationId,
          generationRouteFingerprint: routeFingerprint,
        },
        visualProfileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: referenceSetId,
        referenceAssetIds: [currentAssetId],
        model: workflowKey,
        profileId: generationProfileKey,
        profileVersion: 1,
        provider: "comfyui",
        completedAt: new Date(),
      } });
      await prisma.generationAttempt.create({
        data: {
          id: `${fixture.jobId}-attempt`,
          requestId: fixture.jobId,
          attemptNo: 1,
          provider: "comfyui",
          profileKey: generationProfileKey,
          profileVersion: 1,
          workflowKey,
          workflowVersion: 1,
          status: "succeeded",
        },
      });
      await prisma.contentProductionItem.update({ where: { id: fixture.itemId }, data: { jobId: fixture.jobId } });
      await prisma.mediaAsset.update({ where: { id: fixture.assetId }, data: { sourceJobId: fixture.jobId } });
      await prisma.creativeReviewDecision.create({
        data: {
          id: fixture.decisionId,
          runItemId: fixture.itemId,
          artifactId: fixture.assetId,
          decision: "approved",
          identityConsistency: "passed",
          score: 97,
          evidence: { artifactFree: true, singleSubject: true, intentMatch: true, noVisibleText: true },
          reason: "Identity and placement intent match the character asset pack.",
          reviewerId: actorId,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "content.visual_profile.create" },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [projectId, characterId] } },
    });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { in: [itemId, heroItemId, chatItemId] } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: [jobId, heroJobId, chatJobId] } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: [jobId, heroJobId, chatJobId] } } });
    await prisma.contentProductionItem.deleteMany({ where: { id: { in: [itemId, heroItemId, chatItemId] } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: [runId, heroRunId, chatRunId] } } });
    await prisma.referenceSetRevision.deleteMany({ where: { visualProfileId } });
    await prisma.characterVisualProfile.deleteMany({ where: { characterId } });
    await prisma.generationRouteQualification.deleteMany({
      where: { id: { in: [routeQualificationId, replacementRouteQualificationId] } },
    });
    await prisma.generationModelProfile.deleteMany({ where: { id: generationModelProfileId } });
    await prisma.characterContentVersion.deleteMany({ where: { id: contentId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [currentAssetId, candidateAssetId, heroAssetId, chatAssetId] } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("rejects a production asset approval below the identity evidence threshold", async () => {
    const lowScoreRunId = `asset-studio-low-score-run-${suffix}`;
    await prisma.contentProductionBatch.create({
      data: {
        id: lowScoreRunId,
        title: "Low identity evidence",
        purpose: "character_cover",
        targetType: "character",
        targetId: characterId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        createdById: actorId,
      },
    });
    const lowScoreItemId = `asset-studio-low-score-item-${suffix}`;
    await prisma.contentProductionItem.create({
      data: {
        id: lowScoreItemId,
        batchId: lowScoreRunId,
        itemIndex: 0,
        status: "pending",
        tags: [],
      },
    });
    try {
      await expect(recordCreativeReviewDecision({
        runId: lowScoreRunId,
        itemId: lowScoreItemId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: 1,
        decision: "approved",
        identityConsistency: "passed",
        score: 89,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "The image looks clean but identity confidence is too low",
        requestId: `asset-studio-low-score-${suffix}`,
      })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("at least 90"),
      });
      const missingScoreError = await recordCreativeReviewDecision({
        runId: lowScoreRunId,
        itemId: lowScoreItemId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: 1,
        decision: "approved",
        identityConsistency: "passed",
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "An approval without an identity score must fail closed",
        requestId: `asset-studio-missing-score-${suffix}`,
      }).catch((cause: unknown) => cause);
      expect(missingScoreError).toMatchObject({ status: 400 });
      expect(missingScoreError).toBeInstanceOf(Error);
      expect((missingScoreError as Error).message).toContain("explicit score");
    } finally {
      await prisma.contentProductionItem.delete({
        where: { id: lowScoreItemId },
      });
      await prisma.contentProductionBatch.delete({
        where: { id: lowScoreRunId },
      });
    }
  });

  it("rejects a superseded approval without changing the Character Project", async () => {
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 1,
      purpose: "character_cover",
      runId,
      itemId,
      assetId: candidateAssetId,
      reviewDecisionId: legacyDecisionId,
      actor: { id: actorId, role: "admin" },
      reason: "A stale browser tab must not select an obsolete approval",
      requestId: `asset-studio-stale-select-${suffix}`,
    })).rejects.toMatchObject({ status: 409 });

    await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({
      version: 1,
      draftImageAssetId: null,
      draftAssetPack: {},
    });
  });

  it("rejects historical low-score approval before it can enter draft authority", async () => {
    await prisma.creativeReviewDecision.update({
      where: { id: decisionId },
      data: { score: 89 },
    });
    try {
      await expect(selectCharacterDraftImage({
        characterId,
        expectedProjectVersion: 1,
        purpose: "character_cover",
        runId,
        itemId,
        assetId: candidateAssetId,
        reviewDecisionId: decisionId,
        actor: { id: actorId, role: "admin" },
        reason: "Low identity confidence must stay outside draft authority",
        requestId: `asset-studio-low-score-select-${suffix}`,
      })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("at least 90"),
      });
      await expect(prisma.characterProject.findUniqueOrThrow({
        where: { id: projectId },
      })).resolves.toMatchObject({
        version: 1,
        draftImageAssetId: null,
      });
    } finally {
      await prisma.creativeReviewDecision.update({
        where: { id: decisionId },
        data: { score: 97 },
      });
    }
  });

  it("rejects an approved historical Run after Visual Identity authority changes", async () => {
    const replacementProfileId = `asset-studio-replacement-visual-${suffix}`;
    const replacementReferenceSetId = `asset-studio-replacement-reference-set-${suffix}`;
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { status: "archived" },
    });
    const replacement = await prisma.characterVisualProfile.create({
      data: {
        id: replacementProfileId,
        characterId,
        version: 2,
        status: "active",
        style: "realistic",
        identityPrompt: "Aria with an updated canonical identity",
        negativeIdentityPrompt: "identity drift, different person",
        faceTraits: { identity: "Aria v2" },
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [currentAssetId],
        referenceAssetIds: [currentAssetId],
        adapterRefs: {},
        evidenceState: "reviewed_bootstrap",
        createdFrom: "asset_studio_test",
      },
    });
    await prisma.characterVisualProfile.update({
      where: { id: replacementProfileId },
      data: { immutableHash: characterVisualProfileSnapshotHash(replacement) },
    });
    const replacementReferences = [{
      mediaAssetId: currentAssetId,
      position: 0,
      role: "primary_face",
      weight: 1,
      selectorVersion: "asset-studio-test-v2",
      selectionReason: "Replacement Aria identity",
      qualityScore: 96,
      identityScore: 0.98,
    }];
    await prisma.referenceSetRevision.create({
      data: {
        id: replacementReferenceSetId,
        visualProfileId: replacementProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "asset-studio-test-v2",
        createdFrom: "asset_studio_test",
        snapshotHash: referenceSetSnapshotHash({
          visualProfileId: replacementProfileId,
          revision: 1,
          selectorVersion: "asset-studio-test-v2",
          references: replacementReferences,
        }),
        references: { create: replacementReferences },
      },
    });

    try {
      await expect(selectCharacterDraftImage({
        characterId,
        expectedProjectVersion: 1,
        purpose: "character_cover",
        runId,
        itemId,
        assetId: candidateAssetId,
        reviewDecisionId: decisionId,
        actor: { id: actorId, role: "admin" },
        reason: "A stale identity-bound candidate must not enter the current draft",
        requestId: `asset-studio-stale-identity-${suffix}`,
      })).rejects.toMatchObject({ status: 409 });
      await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({
        version: 1,
        draftImageAssetId: null,
      });
    } finally {
      await prisma.referenceSetRevision.delete({ where: { id: replacementReferenceSetId } });
      await prisma.characterVisualProfile.delete({ where: { id: replacementProfileId } });
      await prisma.characterVisualProfile.update({
        where: { id: visualProfileId },
        data: { status: "active" },
      });
    }
  });

  it("serializes a superseding review with Character authority consumers", async () => {
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, characterId);
      markLocked();
      await gate;
    });
    await locked;

    let settled = false;
    const review = recordCreativeReviewDecision({
      runId,
      itemId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: 1,
      supersedesDecisionId: decisionId,
      decision: "approved",
      identityConsistency: "passed",
      score: 97,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "Serialized evidence refresh keeps the same approved candidate",
      requestId: `asset-studio-serialized-review-${suffix}`,
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    releaseLock();
    await holder;
    const recorded = await review;
    serializedDecisionId = recorded.decisionId;
    serializedRunVersion = recorded.version;
    expect(serializedDecisionId).not.toBe(decisionId);
  });

  it("serializes canonical review with Image Library archive authority", async () => {
    let releaseReview!: () => void;
    let markReviewReady!: () => void;
    const reviewReady = new Promise<void>((resolve) => { markReviewReady = resolve; });
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    const review = prisma.$transaction(async (tx) => {
      const recorded = await recordCreativeReviewDecision({
        runId,
        itemId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: serializedRunVersion,
        supersedesDecisionId: serializedDecisionId,
        decision: "approved",
        identityConsistency: "passed",
        score: 98,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "Refresh canonical evidence while holding media authority",
        requestId: `asset-studio-media-serialized-review-${suffix}`,
      }, tx);
      markReviewReady();
      await reviewGate;
      return recorded;
    });
    await reviewReady;

    let libraryMutationSettled = false;
    const concurrentArchive = patchContentAsset(
      new Request(`http://localhost/api/v1/admin/content/assets/${candidateAssetId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          status: "archived",
          reason: "Attempt to archive while canonical review is committing",
          confirmation: candidateAssetId,
        }),
      }),
      candidateAssetId,
    ).then((response) => {
      libraryMutationSettled = true;
      return { status: "fulfilled" as const, response };
    }, (error: unknown) => {
      libraryMutationSettled = true;
      return { status: "rejected" as const, error };
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(libraryMutationSettled).toBe(false);

    releaseReview();
    const recorded = await review;
    serializedDecisionId = recorded.decisionId;
    serializedRunVersion = recorded.version;
    await expect(concurrentArchive).resolves.toMatchObject({
      status: "rejected",
      error: {
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
          dependencies: expect.arrayContaining([
            expect.objectContaining({
              kind: "creative_run_asset",
              runId,
              itemId,
              status: "approved",
            }),
          ]),
        },
      },
    });
  });

  it("stages only an approved identity-consistent portrait without mutating the live Character", async () => {
    let releaseSelection!: () => void;
    let markSelectionReady!: () => void;
    const selectionReady = new Promise<void>((resolve) => { markSelectionReady = resolve; });
    const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
    const selection = prisma.$transaction(async (tx) => {
      const result = await selectCharacterDraftImage({
        characterId,
        expectedProjectVersion: 1,
        purpose: "character_cover",
        runId,
        itemId,
        assetId: candidateAssetId,
        reviewDecisionId: serializedDecisionId,
        actor: { id: actorId, role: "admin" },
        reason: "Use the approved identity-consistent portrait in the next Release",
        requestId: `asset-studio-select-${suffix}`,
      }, tx);
      markSelectionReady();
      await selectionGate;
      return result;
    });
    await selectionReady;

    let libraryMutationSettled = false;
    const concurrentLibraryMutation = patchContentAsset(
      new Request(`http://localhost/api/v1/admin/content/assets/${candidateAssetId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          status: "archived",
          reason: "Attempt to archive while Character selection is committing",
          confirmation: candidateAssetId,
        }),
      }),
      candidateAssetId,
    ).then((response) => {
      libraryMutationSettled = true;
      return { status: "fulfilled" as const, response };
    }, (error: unknown) => {
      libraryMutationSettled = true;
      return { status: "rejected" as const, error };
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(libraryMutationSettled).toBe(false);

    releaseSelection();
    const result = await selection;
    await expect(concurrentLibraryMutation).resolves.toMatchObject({
      status: "rejected",
      error: {
        status: 409,
        details: { code: "asset_authority_dependency_active" },
      },
    });

    expect(result).toMatchObject({
      characterId,
      projectVersion: 2,
      draftImageAssetId: candidateAssetId,
      draftAssetPack: { character_cover: candidateAssetId },
      deepLink: `/admin/characters/${characterId}?tab=preview`,
    });
    await expect(prisma.characterProject.findUnique({ where: { id: projectId } })).resolves.toMatchObject({
      version: 2,
      draftImageAssetId: candidateAssetId,
      draftAssetPack: {
        character_cover: {
          assetId: candidateAssetId,
          runId,
          itemId,
          reviewDecisionId: serializedDecisionId,
          generationJobId: jobId,
        },
      },
    });
    await expect(prisma.character.findUnique({ where: { id: characterId } })).resolves.toMatchObject({
      imageAssetId: currentAssetId,
    });
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 2,
      purpose: "character_hero",
      runId: heroRunId,
      itemId: heroItemId,
      assetId: heroAssetId,
      reviewDecisionId: heroDecisionId,
      actor: { id: actorId, role: "admin" },
      reason: "Pin the approved hero in the next Character Release",
      requestId: `asset-studio-hero-${suffix}`,
    })).resolves.toMatchObject({
      projectVersion: 3,
      selectedPurpose: "character_hero",
      draftAssetPack: { character_cover: candidateAssetId, character_hero: heroAssetId },
    });
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 3,
      purpose: "character_chat",
      runId: chatRunId,
      itemId: chatItemId,
      assetId: chatAssetId,
      reviewDecisionId: chatDecisionId,
      actor: { id: actorId, role: "admin" },
      reason: "Pin the approved chat image in the next Character Release",
      requestId: `asset-studio-chat-${suffix}`,
    })).resolves.toMatchObject({
      projectVersion: 4,
      selectedPurpose: "character_chat",
      draftAssetPack: {
        character_cover: candidateAssetId,
        character_hero: heroAssetId,
        character_chat: chatAssetId,
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: replacementRouteQualificationId,
        routeFingerprint: replacementRouteFingerprint,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `asset-studio-route-matrix-q2-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.99,
        result: "qualified",
        evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(getCharacterWorkspace(characterId)).resolves.toMatchObject({
      project: {
        version: 4,
        draftAssetPack: {
          character_cover: candidateAssetId,
          character_hero: heroAssetId,
          character_chat: chatAssetId,
        },
        draftAssetSelections: {
          character_cover: {
            generationRouteFingerprint: routeFingerprint,
            routeCurrent: false,
          },
          character_hero: {
            generationRouteFingerprint: routeFingerprint,
            routeCurrent: false,
          },
          character_chat: {
            generationRouteFingerprint: routeFingerprint,
            routeCurrent: false,
          },
        },
        draftAssetRouteAuthority: {
          status: "stale",
          currentRouteFingerprint: replacementRouteFingerprint,
          stalePurposes: [
            "character_cover",
            "character_hero",
            "character_chat",
          ],
          recoveryPurpose: "character_cover",
        },
      },
    });
    await expect(selectCharacterDraftImage({
      characterId,
      expectedProjectVersion: 4,
      purpose: "character_hero",
      runId: heroRunId,
      itemId: heroItemId,
      assetId: heroAssetId,
      reviewDecisionId: heroDecisionId,
      actor: { id: actorId, role: "admin" },
      reason: "An older route candidate must remain history instead of being reselected",
      requestId: `asset-studio-stale-route-select-${suffix}`,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "draft_asset_generation_route_stale",
        currentRouteFingerprint: replacementRouteFingerprint,
        assetRouteFingerprint: routeFingerprint,
      },
    });
    await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }))
      .resolves.toMatchObject({ version: 4 });
    await expect(recordCreativeReviewDecision({
      runId,
      itemId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: serializedRunVersion,
      supersedesDecisionId: serializedDecisionId,
      decision: "rejected",
      identityConsistency: "failed",
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: false,
        noVisibleText: true,
      },
      reason: "Attempt to revoke a candidate already pinned by Character draft authority",
      requestId: `asset-studio-bound-review-${suffix}`,
    })).rejects.toMatchObject({ status: 409 });
    await expect(prisma.creativeReviewDecision.findFirst({
      where: { runItemId: itemId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })).resolves.toMatchObject({ id: serializedDecisionId, decision: "approved" });
    const previewToken = issueCharacterPreviewToken({
      characterId,
      contentVersionId: contentId,
      releaseId: null,
      servingVersion: null,
      imageAssetId: candidateAssetId,
      assetPack: {
        character_cover: candidateAssetId,
        character_hero: heroAssetId,
        character_chat: chatAssetId,
      },
      label: "Draft Preview",
    }, env.BETTER_AUTH_SECRET);
    await expect(loadCharacterRendererPreview(previewToken)).resolves.toMatchObject({
      authority: {
        characterId,
        contentVersionId: contentId,
        releaseId: null,
        imageAssetId: candidateAssetId,
        assetPack: {
          character_cover: candidateAssetId,
          character_hero: heroAssetId,
          character_chat: chatAssetId,
        },
        label: "Draft Preview",
      },
      assetPack: {
        character_cover: { assetId: candidateAssetId },
        character_hero: { assetId: heroAssetId },
        character_chat: { assetId: chatAssetId },
      },
      character: { title: "Aria", image: `/assets/${candidateAssetId}.webp` },
    });
    const exactDraftAssetPack = (await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { draftAssetPack: true },
    })).draftAssetPack;
    await prisma.characterProject.update({
      where: { id: projectId },
      data: {
        draftAssetPack: {
          character_cover: candidateAssetId,
          character_chat: chatAssetId,
        },
      },
    });
    await expect(loadCharacterRendererPreview(previewToken)).resolves.toBeNull();
    await prisma.characterProject.update({
      where: { id: projectId },
      data: { draftAssetPack: toInputJson(exactDraftAssetPack) },
    });

    const activeReferenceSetBeforeReplacement =
      await prisma.referenceSetRevision.findFirstOrThrow({
        where: { visualProfileId, status: "active" },
      });
    const replacementReferenceRequest = {
      visualProfileId,
      expectedActiveReferenceSetRevisionId:
        activeReferenceSetBeforeReplacement.id,
      expectedActiveReferenceSetRevision:
        activeReferenceSetBeforeReplacement.revision,
      selectorVersion: "asset-studio-test-v2",
      references: [{
        mediaAssetId: currentAssetId,
        role: "identity_anchor" as const,
        weight: 1,
      }],
      reason: {
        code: "reference_authority_changed",
        summary: "Publish a replacement Reference Set and invalidate the old draft pack",
      },
      confirmation: `PUBLISH REFERENCES ${characterId}`,
    };
    const blockingRevisionId = `asset-studio-blocking-revision-${suffix}`;
    const blockingReleaseId = `asset-studio-blocking-release-${suffix}`;
    await prisma.characterRevision.create({
      data: {
        id: blockingRevisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: blockingReleaseId,
        projectId,
        revisionId: blockingRevisionId,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {
          placements: [{ slotKey: "character_avatar", assetId: candidateAssetId }],
        },
        snapshotHash: `asset-studio-blocking-release-${suffix}`,
        status: "draft",
      },
    });
    try {
      await expect(prisma.$transaction((tx) =>
        publishCharacterReferenceSet({
          characterId,
          actor: { id: actorId, role: "admin" },
          requestId: `asset-studio-blocked-reference-switch-${suffix}`,
          request: replacementReferenceRequest,
          tx,
        })
      )).rejects.toMatchObject({ status: 409 });
      await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }))
        .resolves.toMatchObject({ version: 4, draftImageAssetId: candidateAssetId });
    } finally {
      await prisma.characterRelease.delete({ where: { id: blockingReleaseId } });
      await prisma.characterRevision.delete({ where: { id: blockingRevisionId } });
    }

    const replacementReferenceSet = await prisma.$transaction((tx) =>
      publishCharacterReferenceSet({
        characterId,
        actor: { id: actorId, role: "admin" },
        requestId: `asset-studio-reference-switch-${suffix}`,
        request: replacementReferenceRequest,
        tx,
      })
    );
    expect(replacementReferenceSet).toMatchObject({ revision: 2, status: "active" });
    await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({
      version: 5,
      draftImageAssetId: null,
      draftAssetPack: {},
    });
    await expect(getCharacterWorkspace(characterId)).resolves.toMatchObject({
      project: {
        version: 5,
        draftImageAssetId: null,
        draftAssetPack: {},
      },
      preview: { draft: { imageUrl: null } },
    });

    await prisma.characterProject.update({
      where: { id: projectId },
      data: {
        draftImageAssetId: candidateAssetId,
        draftAssetPack: {
          character_cover: {
            assetId: candidateAssetId,
            runId,
            itemId,
            reviewDecisionId: decisionId,
            generationJobId: jobId,
          },
          character_hero: {
            assetId: heroAssetId,
            runId: heroRunId,
            itemId: heroItemId,
            reviewDecisionId: heroDecisionId,
            generationJobId: heroJobId,
          },
        },
      },
    });
    const visualProfileResponse = await createCharacterVisualProfile(new Request(
      `http://localhost/api/v1/admin/content/characters/${characterId}/visual-profiles`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "idempotency-key": `asset-studio-visual-switch-${suffix}`,
        },
        body: JSON.stringify({
          identityPrompt: "Aria with a deliberately revised canonical identity",
          reason: "Create Visual Identity v2 and invalidate every V1-bound draft selection",
          confirmation: `${characterId}:visual-profile`,
        }),
      },
    ), characterId);
    expect(visualProfileResponse.status).toBe(200);
    await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({
      version: 6,
      draftImageAssetId: null,
      draftAssetPack: {},
    });
    await expect(getCharacterWorkspace(characterId)).resolves.toMatchObject({
      project: {
        version: 6,
        draftImageAssetId: null,
        draftAssetPack: {},
      },
      visual: {
        activeIdentity: { version: 2 },
        activeReferenceSet: null,
        readiness: { ready: false },
      },
      preview: { draft: { imageUrl: null } },
    });
  });
});
