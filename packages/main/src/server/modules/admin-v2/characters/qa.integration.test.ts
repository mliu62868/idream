import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterQaCheckKeySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { POST as createQaRunRoute } from "@/app/api/v2/admin/characters/[id]/qa-runs/route";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import { createCharacterQaRun } from "./qa";
import { lockMediaAssetAuthority } from "./generation-authority-lock";
import { compileCharacterSoul } from "@idream/shared";
import { characterSoulQaEvidence } from "@/server/test/character-soul-evidence";

describe("Character QA evidence authority", () => {
  const suffix = randomUUID();
  const actorId = `character-qa-admin-${suffix}`;
  const deniedActorId = `character-qa-denied-${suffix}`;
  const characterId = `character-qa-character-${suffix}`;
  const projectId = `character-qa-project-${suffix}`;
  const contentId = `character-qa-content-${suffix}`;
  const visualProfileId = `character-qa-profile-${suffix}`;
  const referenceSetId = `character-qa-reference-set-${suffix}`;
  const referenceAssetId = `character-qa-reference-asset-${suffix}`;
  const secondaryReferenceAssetId = `character-qa-reference-asset-secondary-${suffix}`;
  const draftCoverAssetId = `character-qa-draft-cover-${suffix}`;
  const draftHeroAssetId = `character-qa-draft-hero-${suffix}`;
  const draftChatAssetId = `character-qa-draft-chat-${suffix}`;
  const draftCoverRunId = `character-qa-cover-run-${suffix}`;
  const draftHeroRunId = `character-qa-hero-run-${suffix}`;
  const draftChatRunId = `character-qa-chat-run-${suffix}`;
  const draftCoverItemId = `character-qa-cover-item-${suffix}`;
  const draftHeroItemId = `character-qa-hero-item-${suffix}`;
  const draftChatItemId = `character-qa-chat-item-${suffix}`;
  const draftCoverJobId = `character-qa-cover-job-${suffix}`;
  const draftHeroJobId = `character-qa-hero-job-${suffix}`;
  const draftChatJobId = `character-qa-chat-job-${suffix}`;
  const draftCoverDecisionId = `character-qa-cover-decision-${suffix}`;
  const draftHeroDecisionId = `character-qa-hero-decision-${suffix}`;
  const draftChatDecisionId = `character-qa-chat-decision-${suffix}`;
  const routeModelProfileId = `character-qa-route-profile-${suffix}`;
  const routeProfileKey = `character-qa-route-profile-key-${suffix}`;
  const routeQ1Id = `character-qa-route-q1-${suffix}`;
  const routeQ2Id = `character-qa-route-q2-${suffix}`;
  const routeQ1Fingerprint = `character-qa-route-fingerprint-q1-${suffix}`;
  const routeQ2Fingerprint = `character-qa-route-fingerprint-q2-${suffix}`;
  const draftAssetPack = {
    character_cover: {
      assetId: draftCoverAssetId,
      runId: draftCoverRunId,
      itemId: draftCoverItemId,
      reviewDecisionId: draftCoverDecisionId,
      generationJobId: draftCoverJobId,
      generationRouteFingerprint: routeQ1Fingerprint,
    },
    character_hero: {
      assetId: draftHeroAssetId,
      runId: draftHeroRunId,
      itemId: draftHeroItemId,
      reviewDecisionId: draftHeroDecisionId,
      generationJobId: draftHeroJobId,
      generationRouteFingerprint: routeQ1Fingerprint,
    },
    character_chat: {
      assetId: draftChatAssetId,
      runId: draftChatRunId,
      itemId: draftChatItemId,
      reviewDecisionId: draftChatDecisionId,
      generationJobId: draftChatJobId,
      generationRouteFingerprint: routeQ1Fingerprint,
    },
  };
  const compiledSoul = compileCharacterSoul({
    name: "QA authority character",
    age: 28,
    gender: "female",
    relationshipArchetype: "trusted companion",
    characterPromise: "A precise and dependable companion",
    personality: "Observant and direct",
    tone: "Warm and concise",
    cadence: "Measured sentences",
    vocabulary: ["tell me"],
    voiceHabits: ["asks one precise question"],
    voiceAvoid: ["generic assistant language"],
    backstory: "An adult companion with a stable history",
    values: ["honesty"],
    wants: ["connection"],
    fears: ["misunderstanding"],
    contradictions: ["bold but careful"],
    interaction: { initiative: "balanced", curiosity: "specific", pacing: "steady", affection: "earned", conflict: "direct", repair: "explicit" },
    canon: { facts: ["Adult"], unknowns: ["Unstated facts stay unknown"] },
    dialogue: {
      positive: [{ context: "opening", user: "Hello", assistant: "Tell me what matters.", demonstrates: ["direct"] }],
      negative: [{ assistant: "How may I assist?", reason: "generic" }],
    },
  });
  if (!compiledSoul.ok || compiledSoul.diagnostics.length > 0) {
    throw new Error("QA fixture Soul failed to compile");
  }
  const compiledSoulSnapshot = compiledSoul.snapshot;

  function soulEvidence(result: "passed" | "failed" = "passed") {
    return characterSoulQaEvidence({
      characterContentVersionId: contentId,
      personaSnapshot: compiledSoulSnapshot,
      result,
    });
  }

  function checks(result: "passed" | "failed" = "passed") {
    return characterQaCheckKeySchema.options.map((key, index) => ({
      key,
      result: index === 0 ? result : "passed" as const,
      evidenceRef: `qa://evidence/${suffix}/${key}`,
      comment: `Verified ${key} against the signed renderer snapshot`,
      fixDeepLink: `/admin/characters/${characterId}?tab=preview`,
    }));
  }

  function request(userId: string, body: { entityVersion: number } & Record<string, unknown>) {
    return new Request(`http://localhost/api/v2/admin/characters/${characterId}/qa-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": userId,
        "x-idream-role": userId === actorId ? "admin" : "user",
        "idempotency-key": randomUUID(),
        "x-request-id": randomUUID(),
        "if-match": String(body.entityVersion),
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@example.test`, role: "admin" },
      { id: deniedActorId, email: `${deniedActorId}@example.test`, role: "user" },
    ] });
    await prisma.character.create({ data: {
      id: characterId,
      name: "QA authority character",
      age: 28,
      description: "QA fixture",
      appearance: {},
      advancedDetails: {},
    } });
    await prisma.characterProject.create({ data: {
      id: projectId,
      characterId,
      phase: "qa",
      audience: {},
      successCriteria: ["complete_qa"],
      draftAssetPack,
    } });
    await prisma.characterContentVersion.create({ data: {
      id: contentId,
      characterId,
      version: 1,
      contentHash: `character-qa-content-hash-${suffix}`,
      personaSnapshot: toInputJson(compiledSoulSnapshot),
      openingSnapshot: { firstMessage: "Hello" },
      appearanceSnapshot: {},
      sourceType: "test",
    } });
    await prisma.characterRevision.create({ data: {
      id: `character-qa-revision-${suffix}`,
      projectId,
      revision: 1,
      characterContentVersionId: contentId,
      projectSnapshot: {},
    } });
    await prisma.mediaAsset.createMany({
      data: [{
        id: referenceAssetId,
        ownerId: actorId,
        characterId,
        type: "image",
        url: `memory://${referenceAssetId}`,
        storageKey: `test-fixtures/${referenceAssetId}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      }, {
        id: secondaryReferenceAssetId,
        ownerId: actorId,
        characterId,
        type: "image",
        url: `memory://${secondaryReferenceAssetId}`,
        storageKey: `test-fixtures/${secondaryReferenceAssetId}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      }, ...[
        draftCoverAssetId,
        draftHeroAssetId,
        draftChatAssetId,
      ].map((id) => ({
        id,
        ownerId: actorId,
        characterId,
        type: "image",
        url: `memory://${id}`,
        storageKey: `test-fixtures/${id}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      }))],
    });
    const profile = await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Canonical QA identity",
        negativeIdentityPrompt: null,
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [referenceAssetId],
        adapterRefs: {},
        evidenceState: "reviewed_bootstrap",
        createdFrom: "qa_fixture",
      },
    });
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { immutableHash: characterVisualProfileSnapshotHash(profile) },
    });
    const referenceSet = await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "v1",
        createdFrom: "qa_fixture",
        references: {
          create: {
            mediaAssetId: referenceAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
            selectionReason: "QA fixture identity authority",
          },
        },
      },
      include: { references: { orderBy: { position: "asc" } } },
    });
    const sealedReferenceSetHash = referenceSetSnapshotHash(referenceSet);
    await prisma.referenceSetRevision.update({
      where: { id: referenceSetId },
      data: { snapshotHash: sealedReferenceSetHash },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: routeModelProfileId,
        profileKey: routeProfileKey,
        label: "Character QA route authority fixture",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit-img2img",
        workflowKey: "qwen-image-edit-img2img",
        runnerConfig: { capabilities: { referenceImages: true } },
        allowedOrientations: ["4:5"],
        version: 1,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: routeQ1Id,
        routeFingerprint: routeQ1Fingerprint,
        generationProfileKey: routeProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `character-qa-route-matrix-q1-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.97,
        result: "qualified",
        evidence: {
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(Date.now() - 60_000),
      },
    });
    for (const fixture of [
      {
        purpose: "character_cover",
        assetId: draftCoverAssetId,
        runId: draftCoverRunId,
        itemId: draftCoverItemId,
        jobId: draftCoverJobId,
        decisionId: draftCoverDecisionId,
      },
      {
        purpose: "character_hero",
        assetId: draftHeroAssetId,
        runId: draftHeroRunId,
        itemId: draftHeroItemId,
        jobId: draftHeroJobId,
        decisionId: draftHeroDecisionId,
      },
      {
        purpose: "character_chat",
        assetId: draftChatAssetId,
        runId: draftChatRunId,
        itemId: draftChatItemId,
        jobId: draftChatJobId,
        decisionId: draftChatDecisionId,
      },
    ]) {
      await prisma.contentProductionBatch.create({
        data: {
          id: fixture.runId,
          title: `QA ${fixture.purpose}`,
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
      await prisma.generationJob.create({
        data: {
          id: fixture.jobId,
          userId: actorId,
          characterId,
          visualProfileId,
          visualProfileVersion: 1,
          consistencyMode: "strict",
          referenceAssetIds: [referenceAssetId],
          referenceSetRevisionId: referenceSetId,
          referenceManifest: [{
            mediaAssetId: referenceAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
            selectorVersion: "v1",
            selectionReason: "QA fixture identity authority",
            referenceSetRevisionId: referenceSetId,
            referenceSetRevision: 1,
            snapshotHash: sealedReferenceSetHash,
          }],
          mode: "image",
          controls: {},
          presetIds: [],
          model: "qwen-image-edit-img2img",
          profileId: routeProfileKey,
          profileVersion: 1,
          orientation: "4:5",
          outputCount: 1,
          deliveredOutputCount: 1,
          status: "completed",
          provider: "comfyui",
          sourceType: "content_production_item",
          sourceId: fixture.itemId,
          sourceMeta: {
            batchId: fixture.runId,
            purpose: fixture.purpose,
            targetType: "character",
            targetId: characterId,
            bootstrapIdentity: false,
            referenceSetRevisionId: referenceSetId,
            generationRouteQualificationId: routeQ1Id,
            generationRouteFingerprint: routeQ1Fingerprint,
          },
          completedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: `${fixture.jobId}-attempt`,
          requestId: fixture.jobId,
          attemptNo: 1,
          provider: "comfyui",
          profileKey: routeProfileKey,
          profileVersion: 1,
          workflowKey: "qwen-image-edit-img2img",
          workflowVersion: 1,
          status: "succeeded",
          finishedAt: new Date(),
        },
      });
      await prisma.contentProductionItem.create({
        data: {
          id: fixture.itemId,
          batchId: fixture.runId,
          jobId: fixture.jobId,
          mediaAssetId: fixture.assetId,
          itemIndex: 0,
          status: "approved",
          tags: [],
        },
      });
      await prisma.creativeReviewDecision.create({
        data: {
          id: fixture.decisionId,
          runItemId: fixture.itemId,
          artifactId: fixture.assetId,
          decision: "approved",
          identityConsistency: "passed",
          score: 94,
          evidence: {
            quality: {
              artifactFree: true,
              singleSubject: true,
              intentMatch: true,
              noVisibleText: true,
            },
          },
          reason: "QA fixture approved identity and visible quality",
          reviewerId: actorId,
        },
      });
      await prisma.mediaAsset.update({
        where: { id: fixture.assetId },
        data: { sourceJobId: fixture.jobId },
      });
    }
  });

  afterAll(async () => {
    const qaRunIds = (await prisma.characterQaRun.findMany({ where: { characterId }, select: { id: true } })).map((run) => run.id);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: qaRunIds } } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "character.qa.run.create" } });
    await prisma.characterQaRun.deleteMany({ where: { characterId } });
    await prisma.creativeReviewDecision.deleteMany({
      where: {
        runItemId: {
          in: [draftCoverItemId, draftHeroItemId, draftChatItemId],
        },
      },
    });
    await prisma.generationAttempt.deleteMany({
      where: {
        requestId: {
          in: [draftCoverJobId, draftHeroJobId, draftChatJobId],
        },
      },
    });
    await prisma.contentProductionItem.deleteMany({
      where: {
        id: { in: [draftCoverItemId, draftHeroItemId, draftChatItemId] },
      },
    });
    await prisma.generationJob.deleteMany({
      where: {
        id: { in: [draftCoverJobId, draftHeroJobId, draftChatJobId] },
      },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: {
        id: { in: [draftCoverRunId, draftHeroRunId, draftChatRunId] },
      },
    });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.generationRouteQualification.deleteMany({
      where: { id: { in: [routeQ1Id, routeQ2Id] } },
    });
    await prisma.generationModelProfile.deleteMany({ where: { id: routeModelProfileId } });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            referenceAssetId,
            secondaryReferenceAssetId,
            draftCoverAssetId,
            draftHeroAssetId,
            draftChatAssetId,
          ],
        },
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, deniedActorId] } } });
    await prisma.$disconnect();
  });

  it("records all seven checks as immutable evidence and derives the result", async () => {
    const response = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "Complete renderer and conversation QA",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(response.status).toBe(201);
    const data = (await response.json()).data;
    expect(data).toMatchObject({
      characterId,
      projectId,
      characterContentVersionId: contentId,
      projectVersion: 1,
      visualProfileId,
      visualProfileVersion: 1,
      visualProfileHash: expect.any(String),
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      referenceSetHash: expect.any(String),
      draftAssetPackHash: canonicalSha256(draftAssetPack),
      ownerId: actorId,
      status: "passed",
      checks: expect.arrayContaining([expect.objectContaining({ key: "five_turn_conversation", ownerId: actorId })]),
    });
    await expect(prisma.characterQaRun.findUnique({ where: { id: data.id } })).resolves.toMatchObject({
      status: "passed",
      evidenceHash: data.evidenceHash,
      visualProfileId,
      referenceSetRevisionId: referenceSetId,
      draftAssetPackHash: canonicalSha256(draftAssetPack),
    });
  });

  it("rejects QA when sealed visual or reference authority has drifted", async () => {
    const profile = await prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: visualProfileId },
    });
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { identityPrompt: "Drifted identity prompt" },
    });
    const profileDrift = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "A drifted sealed profile must not be accepted",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(profileDrift.status).toBe(409);
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { identityPrompt: profile.identityPrompt },
    });

    const referenceSet = await prisma.referenceSetRevision.findUniqueOrThrow({
      where: { id: referenceSetId },
    });
    await prisma.referenceSetRevision.update({
      where: { id: referenceSetId },
      data: { snapshotHash: `${referenceSet.snapshotHash}:drifted` },
    });
    const referenceDrift = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "A drifted sealed reference set must not be accepted",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(referenceDrift.status).toBe(409);
    await prisma.referenceSetRevision.update({
      where: { id: referenceSetId },
      data: { snapshotHash: referenceSet.snapshotHash },
    });
  });

  it("rejects QA when one sealed Reference Set image becomes unavailable without changing the snapshot hash", async () => {
    const sealedReferenceSet = await prisma.referenceSetRevision.findUniqueOrThrow({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    });
    await prisma.mediaAsset.update({
      where: { id: referenceAssetId },
      data: { safetyStatus: "blocked" },
    });

    const response = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "Mutable reference availability must be revalidated",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        details: {
          unavailableReferenceMediaIds: [referenceAssetId],
        },
      },
    });
    await expect(prisma.referenceSetRevision.findUnique({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    })).resolves.toEqual(sealedReferenceSet);

    await prisma.mediaAsset.update({
      where: { id: referenceAssetId },
      data: { safetyStatus: "passed" },
    });
  });

  it("rejects bootstrap-only cover QA until cover, hero, and chat are complete", async () => {
    await prisma.characterProject.update({
      where: { id: projectId },
      data: {
        draftAssetPack: {
          character_cover: {
            assetId: referenceAssetId,
            bootstrapIdentity: true,
          },
        },
      },
    });
    try {
      const response = await createQaRunRoute(request(actorId, {
        entityVersion: 1,
        checks: checks(),
        reason: "Bootstrap cover alone cannot authorize Character QA",
      }), { params: Promise.resolve({ id: characterId }) });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          details: {
            code: "draft_asset_pack_not_qa_ready",
            blockers: ["draft_asset_pack_incomplete"],
            missingPurposes: ["character_hero", "character_chat"],
            deepLink: `/admin/characters/${characterId}?tab=assets`,
          },
        },
      });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectId },
        data: { draftAssetPack },
      });
    }
  });

  it("rejects QA when selected pack media, latest review, or generation lineage drifts", async () => {
    const qaCountBefore = await prisma.characterQaRun.count({
      where: { characterId },
    });
    await prisma.mediaAsset.update({
      where: { id: draftHeroAssetId },
      data: { safetyStatus: "blocked" },
    });
    try {
      const unavailable = await createQaRunRoute(request(actorId, {
        entityVersion: 1,
        checks: checks(),
        reason: "A blocked selected hero cannot authorize QA",
      }), { params: Promise.resolve({ id: characterId }) });
      expect(unavailable.status).toBe(409);
      await expect(unavailable.json()).resolves.toMatchObject({
        error: {
          details: {
            code: "draft_asset_pack_authority_invalid",
            invalidAssetPurposes: ["character_hero"],
            deepLink: `/admin/characters/${characterId}?tab=assets`,
          },
        },
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: draftHeroAssetId },
        data: { safetyStatus: "passed" },
      });
    }

    const newerRejectedDecisionId =
      `character-qa-hero-newer-rejection-${suffix}`;
    await prisma.creativeReviewDecision.create({
      data: {
        id: newerRejectedDecisionId,
        runItemId: draftHeroItemId,
        artifactId: draftHeroAssetId,
        decision: "rejected",
        identityConsistency: "failed",
        evidence: {
          quality: {
            artifactFree: false,
            singleSubject: true,
            intentMatch: false,
            noVisibleText: true,
          },
        },
        reason: "Latest immutable review revokes the earlier approval",
        reviewerId: actorId,
      },
    });
    try {
      const reviewDrift = await createQaRunRoute(request(actorId, {
        entityVersion: 1,
        checks: checks(),
        reason: "An earlier approval cannot survive a newer rejection",
      }), { params: Promise.resolve({ id: characterId }) });
      expect(reviewDrift.status).toBe(409);
      await expect(reviewDrift.json()).resolves.toMatchObject({
        error: {
          details: {
            code: "draft_asset_pack_authority_invalid",
            invalidLineagePurposes: ["character_hero"],
          },
        },
      });
    } finally {
      await prisma.creativeReviewDecision.delete({
        where: { id: newerRejectedDecisionId },
      });
    }

    await prisma.mediaAsset.update({
      where: { id: draftHeroAssetId },
      data: { sourceJobId: null },
    });
    try {
      const lineageDrift = await createQaRunRoute(request(actorId, {
        entityVersion: 1,
        checks: checks(),
        reason: "Mutable generation lineage must still match the selected pointer",
      }), { params: Promise.resolve({ id: characterId }) });
      expect(lineageDrift.status).toBe(409);
      await expect(lineageDrift.json()).resolves.toMatchObject({
        error: {
          details: {
            code: "draft_asset_pack_authority_invalid",
            invalidLineagePurposes: ["character_hero"],
          },
        },
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: draftHeroAssetId },
        data: { sourceJobId: draftHeroJobId },
      });
    }
    await expect(prisma.characterQaRun.count({
      where: { characterId },
    })).resolves.toBe(qaCountBefore);
  });

  it("serializes QA with every discovered More-like source authority", async () => {
    const originalJob = await prisma.generationJob.findUniqueOrThrow({
      where: { id: draftHeroJobId },
      select: {
        referenceAssetIds: true,
        referenceManifest: true,
      },
    });
    const referenceSet = await prisma.referenceSetRevision.findUniqueOrThrow({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    });
    const canonicalManifest = Array.isArray(originalJob.referenceManifest)
      ? originalJob.referenceManifest
      : [];
    await prisma.generationJob.update({
      where: { id: draftHeroJobId },
      data: {
        referenceAssetIds: [referenceAssetId, secondaryReferenceAssetId],
        referenceManifest: [
          ...canonicalManifest,
          {
            mediaAssetId: secondaryReferenceAssetId,
            role: "source_image",
            sourceJobId: draftCoverJobId,
            referenceSetRevisionId: referenceSetId,
            snapshotHash: referenceSet.snapshotHash,
          },
        ],
      },
    });

    let releaseQa!: () => void;
    let markQaAuthorityRead!: () => void;
    const qaAuthorityRead = new Promise<void>((resolve) => {
      markQaAuthorityRead = resolve;
    });
    const qaGate = new Promise<void>((resolve) => {
      releaseQa = resolve;
    });
    try {
      const input = {
        entityVersion: 1,
        checks: checks(),
        ...soulEvidence(),
        reason: "QA must lock every discovered More-like source before reading authority",
      };
      const qaTransaction = prisma.$transaction(async (tx) => {
        let failure: unknown;
        try {
          await createCharacterQaRun(
            request(actorId, input),
            characterId,
            input,
            {
              tx,
              actor: { id: actorId, role: "admin" },
              requestId: `character-qa-source-lock-${suffix}`,
            },
          );
        } catch (error) {
          failure = error;
        }
        markQaAuthorityRead();
        await qaGate;
        expect(failure).toMatchObject({
          status: 409,
          details: {
            code: "draft_asset_pack_authority_invalid",
            invalidLineagePurposes: ["character_hero"],
          },
        });
      });
      await qaAuthorityRead;

      let sourceMutationSettled = false;
      const sourceMutation = prisma.$transaction(async (tx) => {
        await lockMediaAssetAuthority(tx, secondaryReferenceAssetId);
        await tx.mediaAsset.update({
          where: { id: secondaryReferenceAssetId },
          data: { safetyStatus: "blocked" },
        });
      }).then(() => {
        sourceMutationSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(sourceMutationSettled).toBe(false);

      releaseQa();
      await qaTransaction;
      await sourceMutation;
      await expect(prisma.mediaAsset.findUniqueOrThrow({
        where: { id: secondaryReferenceAssetId },
      })).resolves.toMatchObject({ safetyStatus: "blocked" });
    } finally {
      releaseQa();
      await prisma.mediaAsset.update({
        where: { id: secondaryReferenceAssetId },
        data: { safetyStatus: "passed" },
      });
      await prisma.generationJob.update({
        where: { id: draftHeroJobId },
        data: {
          referenceAssetIds: Array.isArray(originalJob.referenceAssetIds)
            ? originalJob.referenceAssetIds
            : [],
          referenceManifest: Array.isArray(originalJob.referenceManifest)
            ? originalJob.referenceManifest
            : [],
        },
      });
    }
  });

  it("rejects QA immediately when a newer exact route supersedes the route pinned by the draft pack", async () => {
    await prisma.generationRouteQualification.create({
      data: {
        id: routeQ2Id,
        routeFingerprint: routeQ2Fingerprint,
        generationProfileKey: routeProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `character-qa-route-matrix-q2-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.99,
        result: "qualified",
        evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.characterProject.update({
      where: { id: projectId },
      data: { draftAssetPack },
    });
    try {
      const response = await createQaRunRoute(request(actorId, {
        entityVersion: 1,
        checks: checks(),
        reason: "QA must fail before Release when the selected image route is stale",
      }), { params: Promise.resolve({ id: characterId }) });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          details: {
            code: "draft_asset_generation_route_stale",
            currentRouteFingerprint: routeQ2Fingerprint,
            stalePurposes: [
              "character_cover",
              "character_hero",
              "character_chat",
            ],
            recoveryPurpose: "character_cover",
            deepLink: `/admin/characters/${characterId}?tab=assets`,
          },
        },
      });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectId },
        data: { draftAssetPack },
      });
      await prisma.generationRouteQualification.deleteMany({
        where: { id: routeQ2Id },
      });
    }
  });

  it("derives failed, rejects incomplete evidence, stale versions, and missing permission", async () => {
    const failed = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks("failed"),
      reason: "Record a failed renderer check",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(failed.status).toBe(201);
    await expect(failed.json()).resolves.toMatchObject({ data: { status: "failed" } });

    const incomplete = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks().slice(0, 6),
      reason: "Incomplete evidence must fail",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(incomplete.status).toBe(400);

    const stale = await createQaRunRoute(request(actorId, {
      entityVersion: 2,
      checks: checks(),
      reason: "Stale project version must fail",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(stale.status).toBe(409);

    const denied = await createQaRunRoute(request(deniedActorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "Permission must be enforced",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(denied.status).toBe(403);
  });
});
