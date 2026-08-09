import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";
import { proposeCharacterRelease, reviewCharacterRelease, validateCharacterRelease } from "./release-lifecycle";
import { changeCharacterServingState, publishCharacterRelease } from "../commands/authoritative";
import { executeCharacterReleaseCommand } from "./release-executor";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { env } from "@/server/lib/env";
import { canonicalSha256 } from "../shared/canonical-json";
import { characterQaCheckKeySchema } from "@idream/shared/admin";
import { compileCharacterSoul } from "@idream/shared";
import { createCharacterQaRun } from "./qa";
import { toInputJson } from "../shared/prisma-json";
import { characterSoulQaEvidence } from "@/server/test/character-soul-evidence";

describe("Character Release proposal and review lifecycle", () => {
  const suffix = randomUUID();
  const actorId = `release-lifecycle-admin-${suffix}`;
  const characterId = `release-lifecycle-character-${suffix}`;
  const assetId = `release-lifecycle-asset-${suffix}`;
  const draftAssetId = `release-lifecycle-draft-asset-${suffix}`;
  const heroAssetId = `release-lifecycle-hero-asset-${suffix}`;
  const chatAssetId = `release-lifecycle-chat-asset-${suffix}`;
  const coverRunId = `release-lifecycle-cover-run-${suffix}`;
  const coverItemId = `release-lifecycle-cover-item-${suffix}`;
  const coverJobId = `release-lifecycle-cover-job-${suffix}`;
  const coverDecisionId = `release-lifecycle-cover-decision-${suffix}`;
  const heroRunId = `release-lifecycle-hero-run-${suffix}`;
  const heroItemId = `release-lifecycle-hero-item-${suffix}`;
  const heroJobId = `release-lifecycle-hero-job-${suffix}`;
  const heroDecisionId = `release-lifecycle-hero-decision-${suffix}`;
  const chatRunId = `release-lifecycle-chat-run-${suffix}`;
  const chatItemId = `release-lifecycle-chat-item-${suffix}`;
  const chatJobId = `release-lifecycle-chat-job-${suffix}`;
  const chatDecisionId = `release-lifecycle-chat-decision-${suffix}`;
  const postProposalRejectDecisionId = `release-lifecycle-post-proposal-reject-${suffix}`;
  const profileId = `release-lifecycle-profile-${suffix}`;
  const referenceSetId = `release-lifecycle-reference-${suffix}`;
  const projectId = `release-lifecycle-project-${suffix}`;
  const contentId = `release-lifecycle-content-${suffix}`;
  const revisionId = `release-lifecycle-revision-${suffix}`;
  const routeFingerprint = `release-lifecycle-route-${suffix}`;
  const routeQualificationId = `release-lifecycle-route-qualification-${suffix}`;
  const generationProfileId = `release-lifecycle-generation-profile-${suffix}`;
  const generationProfileKey = `release-lifecycle-generation-${suffix}`;
  const qaRunId = `release-lifecycle-qa-${suffix}`;
  const failedQaRunId = `release-lifecycle-qa-failed-${suffix}`;
  const recoveredQaRunId = `release-lifecycle-qa-recovered-${suffix}`;
  const postProposalFailedQaRunId = `release-lifecycle-qa-post-proposal-failed-${suffix}`;
  const replacementQaRunId = `release-lifecycle-qa-replacement-${suffix}`;
  const qaEvidenceHash = `release-lifecycle-qa-hash-${suffix}`;
  const headers = { "x-idream-user-id": actorId, "x-idream-role": "admin", "x-request-id": `release-lifecycle-${suffix}` };
  const draftAssetPack = {
    character_cover: { assetId: draftAssetId, runId: coverRunId, itemId: coverItemId, reviewDecisionId: coverDecisionId, generationJobId: coverJobId, generationRouteFingerprint: routeFingerprint },
    character_hero: { assetId: heroAssetId, runId: heroRunId, itemId: heroItemId, reviewDecisionId: heroDecisionId, generationJobId: heroJobId, generationRouteFingerprint: routeFingerprint },
    character_chat: { assetId: chatAssetId, runId: chatRunId, itemId: chatItemId, reviewDecisionId: chatDecisionId, generationJobId: chatJobId, generationRouteFingerprint: routeFingerprint },
  };
  let visualProfileHash = "";
  let referenceSetHash = "";
  let soulEvidence!: ReturnType<typeof characterSoulQaEvidence>;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" } });
    await prisma.mediaAsset.create({ data: { id: assetId, ownerId: actorId, type: "image", url: `https://assets.test/${assetId}.webp`, safetyStatus: "passed", metadata: {} } });
    await prisma.character.create({ data: { id: characterId, creatorId: actorId, name: "Release Candidate", age: 24, description: "Ready for release lifecycle", visibility: "private", status: "draft", appearance: {}, advancedDetails: {}, imageAssetId: assetId } });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { characterId },
    });
    await prisma.mediaAsset.create({ data: { id: draftAssetId, ownerId: actorId, characterId, type: "image", url: `https://assets.test/${draftAssetId}.webp`, safetyStatus: "passed", metadata: {} } });
    await prisma.mediaAsset.createMany({ data: [
      { id: heroAssetId, ownerId: actorId, characterId, type: "image", url: `https://assets.test/${heroAssetId}.webp`, safetyStatus: "passed", metadata: {} },
      { id: chatAssetId, ownerId: actorId, characterId, type: "image", url: `https://assets.test/${chatAssetId}.webp`, safetyStatus: "passed", metadata: {} },
    ] });
    for (const fixture of [
      { runId: coverRunId, itemId: coverItemId, jobId: coverJobId, decisionId: coverDecisionId, assetId: draftAssetId, purpose: "character_cover" },
      { runId: heroRunId, itemId: heroItemId, jobId: heroJobId, decisionId: heroDecisionId, assetId: heroAssetId, purpose: "character_hero" },
      { runId: chatRunId, itemId: chatItemId, jobId: chatJobId, decisionId: chatDecisionId, assetId: chatAssetId, purpose: "character_chat" },
    ]) {
      await prisma.contentProductionBatch.create({ data: { id: fixture.runId, title: fixture.purpose, purpose: fixture.purpose, targetType: "character", targetId: characterId, presetIds: [], count: 1, totalItems: 1, completedItems: 1, approvedItems: 1, status: "reviewing", lifecycleState: "active", workflowStage: "placement", verificationState: "pending", createdById: actorId } });
      await prisma.contentProductionItem.create({ data: { id: fixture.itemId, batchId: fixture.runId, mediaAssetId: fixture.assetId, itemIndex: 0, status: "approved", tags: [] } });
      await prisma.creativeReviewDecision.create({ data: {
        id: fixture.decisionId,
        runItemId: fixture.itemId,
        artifactId: fixture.assetId,
        decision: "approved",
        identityConsistency: "passed",
        score: 92,
        evidence: { artifactFree: true, singleSubject: true, intentMatch: true, noVisibleText: true },
        reason: "Approved release asset",
        reviewerId: actorId,
      } });
    }
    await prisma.characterServing.create({ data: { characterId, state: "inactive" } });
    const profile = await prisma.characterVisualProfile.create({ data: { id: profileId, characterId, version: 1, status: "active", style: "realistic", identityPrompt: "same adult character", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [assetId], adapterRefs: {}, createdFrom: "test" } });
    visualProfileHash = characterVisualProfileSnapshotHash(profile);
    await prisma.characterVisualProfile.update({ where: { id: profile.id }, data: { immutableHash: visualProfileHash } });
    await prisma.referenceSetRevision.create({ data: { id: referenceSetId, visualProfileId: profileId, revision: 1, status: "active", selectorVersion: "v1", createdFrom: "test" } });
    await prisma.characterVisualReferenceSnapshot.create({
      data: {
        referenceSetRevisionId: referenceSetId,
        mediaAssetId: assetId,
        position: 0,
        role: "primary_face",
        weight: 1,
        selectorVersion: "v1",
        selectionReason: "release lifecycle fixture",
      },
    });
    const referenceManifest = [
      { mediaAssetId: assetId, position: 0, role: "primary_face", weight: 1 },
    ];
    referenceSetHash = referenceSetSnapshotHash({ visualProfileId: profileId, revision: 1, selectorVersion: "v1", references: referenceManifest });
    await prisma.referenceSetRevision.update({ where: { id: referenceSetId }, data: { snapshotHash: referenceSetHash } });
    await prisma.generationModelProfile.create({ data: {
      id: generationProfileId,
      profileKey: generationProfileKey,
      label: "Release lifecycle test",
      pipelineModel: "qwen-image-edit-img2img",
      workflowKey: "qwen-image-edit-img2img",
      runner: "comfyui",
      runnerConfig: { capabilities: { referenceImages: true, initImage: true } },
      allowedOrientations: ["4:5"],
      status: "active",
      enabled: true,
      rolloutPercent: 100,
    } });
    await prisma.generationRouteQualification.create({ data: { id: routeQualificationId, routeFingerprint, generationProfileKey, generationProfileVersion: 1, workflowKey: "qwen-image-edit-img2img", workflowVersion: 1, style: "realistic", matrixKey: "realistic-avatar", sampleCount: 40, passCount: 40, identityMatch: 1, result: "qualified", evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION }, policyVersion: CHARACTER_RELEASE_POLICY_VERSION } });
    for (const fixture of [
      { runId: coverRunId, itemId: coverItemId, jobId: coverJobId, assetId: draftAssetId, purpose: "character_cover" },
      { runId: heroRunId, itemId: heroItemId, jobId: heroJobId, assetId: heroAssetId, purpose: "character_hero" },
      { runId: chatRunId, itemId: chatItemId, jobId: chatJobId, assetId: chatAssetId, purpose: "character_chat" },
    ]) {
      await prisma.generationJob.create({ data: {
        id: fixture.jobId,
        userId: actorId,
        characterId,
        visualProfileId: profileId,
        visualProfileVersion: 1,
        consistencyMode: "strict",
        referenceAssetIds: [assetId],
        referenceSetRevisionId: referenceSetId,
        referenceManifest: referenceManifest.map((reference) => ({
          ...reference,
          selectorVersion: "v1",
          selectionReason: "Release lifecycle identity authority",
          referenceSetRevisionId: referenceSetId,
          referenceSetRevision: 1,
          snapshotHash: referenceSetHash,
        })),
        mode: "image",
        controls: {},
        presetIds: [],
        model: "qwen-image-edit-img2img",
        profileId: generationProfileKey,
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
          generationRouteQualificationId: routeQualificationId,
          generationRouteFingerprint: routeFingerprint,
        },
        completedAt: new Date(),
        finishedAt: new Date(),
      } });
      await prisma.generationAttempt.create({ data: {
        id: `${fixture.jobId}-attempt`,
        requestId: fixture.jobId,
        attemptNo: 1,
        provider: "comfyui",
        profileKey: generationProfileKey,
        profileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        status: "succeeded",
        creativeRunItemId: fixture.itemId,
        finishedAt: new Date(),
      } });
      await prisma.contentProductionItem.update({ where: { id: fixture.itemId }, data: { jobId: fixture.jobId } });
      await prisma.mediaAsset.update({ where: { id: fixture.assetId }, data: { sourceJobId: fixture.jobId } });
    }
    await prisma.generationAttempt.create({
      data: {
        id: `${coverJobId}-failed-retry`,
        requestId: coverJobId,
        attemptNo: 2,
        provider: "mock-after-success",
        profileKey: generationProfileKey,
        profileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        status: "failed",
        creativeRunItemId: coverItemId,
        finishedAt: new Date(),
      },
    });
    const compiledSoul = compileCharacterSoul({
      name: "Released Candidate",
      age: 25,
      gender: "female",
      relationshipArchetype: "companion",
      characterPromise: "A consistent release candidate",
      personality: "Observant, direct, and emotionally grounded.",
      values: ["honesty"],
      wants: ["build mutual trust"],
      fears: ["breaking a confidence"],
      contradictions: ["careful but spontaneously playful"],
      backstory: "She learned to value dependable companionship through years of community work.",
      tone: "Warm and concise.",
      cadence: "Measured sentences with occasional dry humor.",
      vocabulary: ["grounded", "specific"],
      voiceHabits: ["asks one focused follow-up"],
      voiceAvoid: ["generic reassurance"],
      interaction: {
        initiative: "Offer a concrete next step.",
        curiosity: "Ask about motives, not just events.",
        pacing: "Let emotional turns breathe.",
        affection: "Show care through attentive recall.",
        conflict: "Name disagreement without escalating.",
        repair: "Acknowledge impact and propose repair.",
      },
      canon: {
        facts: ["She works with local community groups."],
        unknowns: ["The user's private history unless disclosed."],
      },
      exampleDialogue: ["I hear the decision. What part feels hardest to carry?"],
      negativeDialogue: [{
        assistant: "Everything will be fine.",
        reason: "Generic reassurance ignores the user's actual concern.",
      }],
    });
    if (!compiledSoul.ok) throw new Error("release fixture Soul must compile");
    soulEvidence = characterSoulQaEvidence({
      characterContentVersionId: contentId,
      personaSnapshot: compiledSoul.snapshot,
    });
    await prisma.characterContentVersion.create({ data: { id: contentId, characterId, version: 1, contentHash: compiledSoul.snapshot.compiled.fingerprint, personaSnapshot: toInputJson(compiledSoul.snapshot), openingSnapshot: { firstMessage: "Hello" }, appearanceSnapshot: { style: "realistic" }, sourceType: "test", createdById: actorId } });
    await prisma.characterProject.create({ data: { id: projectId, characterId, ownerId: actorId, phase: "qa", audience: {}, successCriteria: ["five_turn_qa"], draftImageAssetId: draftAssetId, draftAssetPack, activeKey: `official:${characterId}` } });
    await prisma.characterRevision.create({ data: { id: revisionId, projectId, revision: 1, characterContentVersionId: contentId, projectSnapshot: {}, createdById: actorId } });
    await prisma.characterQaRun.create({ data: {
      ...soulEvidence,
      id: qaRunId,
      characterId,
      projectId,
      characterContentVersionId: contentId,
      projectVersion: 1,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      visualProfileHash,
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      referenceSetHash,
      draftAssetPackHash: canonicalSha256(draftAssetPack),
      ownerId: actorId,
      status: "passed",
      checks: [],
      evidenceHash: qaEvidenceHash,
    } });
  });

  afterAll(async () => {
    const releases = await prisma.characterRelease.findMany({ where: { projectId }, select: { id: true } });
    const validations = await prisma.releaseValidationRun.findMany({ where: { releaseId: { in: releases.map((row) => row.id) } }, select: { id: true } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [...releases.map((row) => row.id), characterId, projectId] } } });
    const commands = await prisma.controlPlaneCommand.findMany({ where: { actorId }, select: { id: true } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commands.map((row) => row.id) } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commands.map((row) => row.id) } } });
    await prisma.characterReleaseEvent.deleteMany({ where: { characterId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.releaseMonitor.deleteMany({
      where: { releaseId: { in: releases.map((row) => row.id) } },
    });
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { in: releases.map((row) => row.id) } },
    });
    await prisma.releaseCheckResult.deleteMany({ where: { validationRunId: { in: validations.map((row) => row.id) } } });
    await prisma.releaseValidationRun.deleteMany({ where: { id: { in: validations.map((row) => row.id) } } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: releases.map((row) => row.id) } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { id: { in: [coverDecisionId, heroDecisionId, chatDecisionId, postProposalRejectDecisionId] } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: [coverJobId, heroJobId, chatJobId] } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: [coverJobId, heroJobId, chatJobId] } } });
    await prisma.contentProductionItem.deleteMany({ where: { id: { in: [coverItemId, heroItemId, chatItemId] } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: [coverRunId, heroRunId, chatRunId] } } });
    await prisma.characterQaRun.deleteMany({ where: { projectId } });
    await prisma.characterRevision.deleteMany({ where: { id: revisionId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { id: contentId } });
    await prisma.generationRouteQualification.deleteMany({ where: { routeFingerprint } });
    await prisma.generationModelProfile.deleteMany({ where: { id: generationProfileId } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { referenceSetRevisionId: referenceSetId } });
    await prisma.referenceSetRevision.deleteMany({ where: { id: referenceSetId } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: profileId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [assetId, draftAssetId, heroAssetId, chatAssetId] } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("pins exact immutable inputs, then records an explicit review decision", async () => {
    const proposalRequest = () => new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/releases`,
      { method: "POST", headers },
    );
    await expect(proposeCharacterRelease({ request: proposalRequest(), characterId, expectedProjectVersion: 1, qaRunId: `missing-${qaRunId}`, reason: "An arbitrary QA reference must not pass" }))
      .rejects.toMatchObject({ status: 409 });
    const sealedReferenceSet = await prisma.referenceSetRevision.findUniqueOrThrow({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { safetyStatus: "blocked" },
    });
    await expect(proposeCharacterRelease({
      request: proposalRequest(),
      characterId,
      expectedProjectVersion: 1,
      qaRunId,
      reason: "Every pinned reference must remain available",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        blockers: expect.arrayContaining([
          "active_reference_set_media_unavailable",
        ]),
      },
    });
    await expect(prisma.referenceSetRevision.findUnique({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    })).resolves.toEqual(sealedReferenceSet);
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { safetyStatus: "passed" },
    });
    await prisma.characterQaRun.create({ data: {
      ...soulEvidence,
      id: failedQaRunId,
      characterId,
      projectId,
      characterContentVersionId: contentId,
      projectVersion: 1,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      visualProfileHash,
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      referenceSetHash,
      draftAssetPackHash: canonicalSha256(draftAssetPack),
      ownerId: actorId,
      status: "failed",
      checks: [],
      evidenceHash: `${qaEvidenceHash}-failed`,
      createdAt: new Date("2032-01-01T00:00:00.000Z"),
    } });
    await expect(proposeCharacterRelease({
      request: proposalRequest(),
      characterId,
      expectedProjectVersion: 1,
      qaRunId,
      reason: "An older passed QA Run must not survive a later failure",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        blockers: expect.arrayContaining(["character_qa_not_latest_authority"]),
      },
    });
    await prisma.characterQaRun.create({ data: {
      ...soulEvidence,
      id: recoveredQaRunId,
      characterId,
      projectId,
      characterContentVersionId: contentId,
      projectVersion: 1,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      visualProfileHash,
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      referenceSetHash,
      draftAssetPackHash: canonicalSha256(draftAssetPack),
      ownerId: actorId,
      status: "passed",
      checks: [],
      evidenceHash: `${qaEvidenceHash}-recovered`,
      createdAt: new Date("2032-01-01T00:01:00.000Z"),
    } });
    const firstProposed = await proposeCharacterRelease({ request: proposalRequest(), characterId, expectedProjectVersion: 1, qaRunId: recoveredQaRunId, reason: "The latest QA Run recovered this exact snapshot" });
    expect(firstProposed).toMatchObject({ projectId, revisionId, characterContentVersionId: contentId, visualProfileId: profileId, referenceSetRevisionId: referenceSetId, status: "in_review", version: 1 });
    expect(firstProposed.releasePlacementManifest).toMatchObject({
      schemaVersion: 2,
      placements: [
        { slotKey: "character_avatar", assetId: draftAssetId, generationJobId: coverJobId },
        { slotKey: "character_hero", assetId: heroAssetId, generationJobId: heroJobId },
        { slotKey: "character_chat", assetId: chatAssetId, generationJobId: chatJobId },
      ],
    });
    expect(firstProposed.generationProvenance).toMatchObject({
      schemaVersion: "character-release-generation-provenance-v2",
      placements: expect.arrayContaining([
        expect.objectContaining({
          slotKey: "character_avatar",
          generationJobId: coverJobId,
          attemptId: `${coverJobId}-attempt`,
          attemptNo: 1,
          provider: "comfyui",
        }),
      ]),
      characterQa: {
        qaRunId: recoveredQaRunId,
        characterId,
        projectId,
        characterContentVersionId: contentId,
        projectVersion: 1,
        visualProfileId: profileId,
        visualProfileVersion: 1,
        visualProfileHash,
        referenceSetRevisionId: referenceSetId,
        referenceSetRevision: 1,
        referenceSetHash,
        draftAssetPackHash: canonicalSha256(draftAssetPack),
      },
    });
    expect(firstProposed.snapshotHash).toHaveLength(64);
    const projectAfterProposal = await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { version: true },
    });
    expect(projectAfterProposal.version).toBe(2);
    await expect(createCharacterQaRun(
      new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/qa-runs`,
        { method: "POST", headers },
      ),
      characterId,
      {
        entityVersion: projectAfterProposal.version,
        ...soulEvidence,
        checks: characterQaCheckKeySchema.options.map((key, index) => ({
          key,
          result: index === 0 ? "failed" : "passed",
          evidenceRef: `release-candidate-qa:${key}`,
          comment: index === 0
            ? "The candidate failed a later QA check"
            : "The surface remained stable",
          fixDeepLink: `/admin/characters/${characterId}?tab=preview`,
        })),
        reason: "A failed QA Run must not bypass the proposed Release snapshot",
      },
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "active_character_release_blocks_qa",
        releaseId: firstProposed.id,
        releaseStatus: "in_review",
      },
    });
    const firstReviewRequest = new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/releases/${firstProposed.id}/review`,
      { method: "POST", headers },
    );
    const withdrawn = await reviewCharacterRelease({
      request: firstReviewRequest,
      characterId,
      releaseId: firstProposed.id,
      expectedVersion: firstProposed.version,
      decision: "changes_requested",
      reason: "The immutable candidate needs a new production pass",
    });
    expect(withdrawn).toMatchObject({ status: "withdrawn", version: 2, snapshotHash: firstProposed.snapshotHash });
    await expect(prisma.characterProject.findUnique({ where: { id: projectId } })).resolves.toMatchObject({
      phase: "producing",
      version: 3,
    });
    await expect(reviewCharacterRelease({
      request: firstReviewRequest,
      characterId,
      releaseId: firstProposed.id,
      expectedVersion: withdrawn.version,
      decision: "approved",
      reason: "Withdrawn snapshots are terminal",
    })).rejects.toMatchObject({ status: 409 });
    await expect(proposeCharacterRelease({
      request: proposalRequest(),
      characterId,
      expectedProjectVersion: 3,
      qaRunId,
      reason: "Stale QA must not authorize a replacement snapshot",
    })).rejects.toMatchObject({
      status: 409,
      details: { blockers: expect.arrayContaining(["character_qa_authority_mismatch"]) },
    });
    await prisma.characterQaRun.create({ data: {
      ...soulEvidence,
      id: replacementQaRunId,
      characterId,
      projectId,
      characterContentVersionId: contentId,
      projectVersion: 3,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      visualProfileHash,
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      referenceSetHash,
      draftAssetPackHash: canonicalSha256(draftAssetPack),
      ownerId: actorId,
      status: "passed",
      checks: [],
      evidenceHash: `${qaEvidenceHash}-replacement`,
    } });
    const proposed = await proposeCharacterRelease({
      request: proposalRequest(),
      characterId,
      expectedProjectVersion: 3,
      qaRunId: replacementQaRunId,
      reason: "Replacement QA passed against the current draft authority",
    });
    const reviewRequest = new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/releases/${proposed.id}/review`,
      { method: "POST", headers },
    );
    const approved = await reviewCharacterRelease({ request: reviewRequest, characterId, releaseId: proposed.id, expectedVersion: proposed.version, decision: "approved", reason: "Independent reviewer approved immutable snapshot" });
    expect(approved).toMatchObject({ status: "approved", version: 2, snapshotHash: proposed.snapshotHash });
    await expect(
      prisma.characterProject.findUnique({ where: { id: projectId } }),
    ).resolves.toMatchObject({ phase: "launch_ready", version: 5 });
    await expect(prisma.adminAuditLog.count({ where: { actorId, targetId: proposed.id } })).resolves.toBe(2);
    const validationRequest = new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/releases/${proposed.id}/validation`,
      { method: "POST", headers },
    );
    await prisma.characterQaRun.create({ data: {
      ...soulEvidence,
      id: postProposalFailedQaRunId,
      characterId,
      projectId,
      characterContentVersionId: contentId,
      projectVersion: 3,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      visualProfileHash,
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      referenceSetHash,
      draftAssetPackHash: canonicalSha256(draftAssetPack),
      ownerId: actorId,
      status: "failed",
      checks: [],
      evidenceHash: `${qaEvidenceHash}-post-proposal-failed`,
      createdAt: new Date("2033-01-01T00:00:00.000Z"),
    } });
    const supersededQaValidation = await validateCharacterRelease({
      request: validationRequest,
      characterId,
      releaseId: proposed.id,
      expectedVersion: approved.version,
    });
    expect(supersededQaValidation).toMatchObject({
      result: "failed",
      readiness: "blocked",
    });
    expect(supersededQaValidation.checks).toContainEqual(
      expect.objectContaining({
        key: "character_qa_passed",
        passed: false,
        evidence: expect.objectContaining({
          qaRunId: replacementQaRunId,
          latestAuthorityQaRunId: postProposalFailedQaRunId,
          latestAuthorityStatus: "failed",
        }),
      }),
    );
    await prisma.characterQaRun.delete({
      where: { id: postProposalFailedQaRunId },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { safetyStatus: "blocked" },
    });
    const blockedReferenceValidation = await validateCharacterRelease({
      request: validationRequest,
      characterId,
      releaseId: proposed.id,
      expectedVersion: approved.version,
    });
    expect(blockedReferenceValidation).toMatchObject({
      result: "failed",
      readiness: "blocked",
    });
    expect(blockedReferenceValidation.checks).toContainEqual(
      expect.objectContaining({
        key: "reference_set_published_snapshot",
        passed: false,
        evidence: expect.objectContaining({
          unavailableReferenceMediaIds: [assetId],
        }),
      }),
    );
    await expect(prisma.referenceSetRevision.findUnique({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    })).resolves.toEqual(sealedReferenceSet);
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { safetyStatus: "passed" },
    });
    await prisma.creativeReviewDecision.create({ data: {
      id: postProposalRejectDecisionId,
      runItemId: heroItemId,
      artifactId: heroAssetId,
      decision: "rejected",
      identityConsistency: "failed",
      reason: "Post-proposal review drift must fail closed",
      reviewerId: actorId,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    } });
    const blockedValidation = await validateCharacterRelease({ request: validationRequest, characterId, releaseId: proposed.id, expectedVersion: approved.version });
    expect(blockedValidation).toMatchObject({ result: "failed", readiness: "blocked" });
    expect(blockedValidation.checks).toContainEqual(expect.objectContaining({
      key: "release_asset_review_authority",
      passed: false,
    }));
    await prisma.creativeReviewDecision.delete({ where: { id: postProposalRejectDecisionId } });
    await prisma.generationJob.update({ where: { id: heroJobId }, data: { visualProfileId: null } });
    const blockedGenerationValidation = await validateCharacterRelease({ request: validationRequest, characterId, releaseId: proposed.id, expectedVersion: approved.version });
    expect(blockedGenerationValidation).toMatchObject({ result: "failed", readiness: "blocked" });
    expect(blockedGenerationValidation.checks).toContainEqual(expect.objectContaining({
      key: "release_asset_generation_authority",
      passed: false,
    }));
    await prisma.generationJob.update({ where: { id: heroJobId }, data: { visualProfileId: profileId } });
    await prisma.mediaAsset.update({
      where: { id: chatAssetId },
      data: { metadata: { synthetic: true, source: "mock" } },
    });
    const blockedSyntheticValidation = await validateCharacterRelease({
      request: validationRequest,
      characterId,
      releaseId: proposed.id,
      expectedVersion: approved.version,
    });
    expect(blockedSyntheticValidation).toMatchObject({
      result: "failed",
      readiness: "blocked",
    });
    expect(blockedSyntheticValidation.checks).toContainEqual(
      expect.objectContaining({
        key: "release_assets_customer_publishable",
        passed: false,
        evidence: expect.objectContaining({
          syntheticPlacementSlots: ["character_chat"],
        }),
      }),
    );
    await prisma.mediaAsset.update({
      where: { id: chatAssetId },
      data: { metadata: {} },
    });
    const validation = await validateCharacterRelease({ request: validationRequest, characterId, releaseId: proposed.id, expectedVersion: approved.version });
    expect(validation).toMatchObject({ result: "passed", readiness: "ready", snapshotHash: proposed.snapshotHash, policyVersion: CHARACTER_RELEASE_POLICY_VERSION });
    const acceptPublish = async (tab: string) => publishCharacterRelease(new Request(`http://localhost/api/v2/admin/characters/${characterId}/releases/${proposed.id}/commands/publish`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `publish-${tab}-${suffix}` },
      body: JSON.stringify({ entityVersion: approved.version, reason: { code: "launch_approved", summary: "Publish the reviewed and validated snapshot" }, confirmation: `${characterId}:${proposed.id}:publish` }),
    }), characterId, proposed.id);

    const customerServingEffects = async () => ({
      serving: await prisma.characterServing.findUnique({
        where: { characterId },
        select: {
          state: true,
          currentReleaseId: true,
          scheduledReleaseId: true,
          scheduledAt: true,
          version: true,
        },
      }),
      release: await prisma.characterRelease.findUnique({
        where: { id: proposed.id },
        select: { status: true, version: true, publishedAt: true },
      }),
      character: await prisma.character.findUnique({
        where: { id: characterId },
        select: {
          imageAssetId: true,
          status: true,
          visibility: true,
        },
      }),
      project: await prisma.characterProject.findUnique({
        where: { id: projectId },
        select: { phase: true, version: true },
      }),
      assets: await prisma.mediaAsset.findMany({
        where: { id: { in: [draftAssetId, heroAssetId, chatAssetId] } },
        select: { id: true, visibility: true },
        orderBy: { id: "asc" },
      }),
      publishedEvents: await prisma.characterReleaseEvent.count({
        where: { releaseId: proposed.id, type: "character.release.published" },
      }),
      publishedOutbox: await prisma.mainOutboxEvent.count({
        where: {
          aggregateId: proposed.id,
          eventType: "character.release.published.v2",
        },
      }),
      monitors: await prisma.releaseMonitor.count({
        where: { releaseId: proposed.id },
      }),
    });
    const effectsBeforeDriftedPublish = await customerServingEffects();

    await prisma.mediaAsset.update({
      where: { id: draftAssetId },
      data: { metadata: { synthetic: true, source: "mock-after-approval" } },
    });
    const syntheticPublish = await acceptPublish("synthetic-drift");
    expect(syntheticPublish.status).toBe(202);
    const syntheticPublishCommandId = (await syntheticPublish.json()).data.commandId as string;
    await expect(executeCharacterReleaseCommand(prisma, {
      commandId: syntheticPublishCommandId,
      workerId: `release-lifecycle-synthetic-drift-${suffix}`,
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "release_validation_failed",
    });
    await expect(customerServingEffects()).resolves.toEqual(effectsBeforeDriftedPublish);
    const syntheticPublishValidation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: proposed.id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    await expect(prisma.releaseCheckResult.findUnique({
      where: {
        validationRunId_checkKey: {
          validationRunId: syntheticPublishValidation.id,
          checkKey: "release_assets_customer_publishable",
        },
      },
    })).resolves.toMatchObject({
      result: "failed",
      evidence: expect.objectContaining({
        placements: expect.arrayContaining([
          expect.objectContaining({
            slotKey: "character_avatar",
            assetId: draftAssetId,
            reasons: expect.arrayContaining(["metadata_synthetic"]),
          }),
        ]),
      }),
    });
    await prisma.mediaAsset.update({
      where: { id: draftAssetId },
      data: { metadata: {} },
    });
    await expect(validateCharacterRelease({
      request: validationRequest,
      characterId,
      releaseId: proposed.id,
      expectedVersion: approved.version,
    })).resolves.toMatchObject({ result: "passed", readiness: "ready" });

    await prisma.generationJob.update({
      where: { id: coverJobId },
      data: { provider: "mock-after-approval" },
    });
    await prisma.generationAttempt.update({
      where: { id: `${coverJobId}-attempt` },
      data: { provider: "mock-after-approval" },
    });
    const mockProviderPublish = await acceptPublish("mock-provider-drift");
    expect(mockProviderPublish.status).toBe(202);
    const mockProviderCommandId = (await mockProviderPublish.json()).data.commandId as string;
    await expect(executeCharacterReleaseCommand(prisma, {
      commandId: mockProviderCommandId,
      workerId: `release-lifecycle-provider-drift-${suffix}`,
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "release_validation_failed",
    });
    await expect(customerServingEffects()).resolves.toEqual(effectsBeforeDriftedPublish);
    const mockProviderValidation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: proposed.id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    await expect(prisma.releaseCheckResult.findUnique({
      where: {
        validationRunId_checkKey: {
          validationRunId: mockProviderValidation.id,
          checkKey: "release_assets_customer_publishable",
        },
      },
    })).resolves.toMatchObject({
      result: "failed",
      evidence: expect.objectContaining({
        placements: expect.arrayContaining([
          expect.objectContaining({
            slotKey: "character_avatar",
            assetId: draftAssetId,
            reasons: expect.arrayContaining([
              "job_provider_mock",
              "latest_attempt_provider_mock",
            ]),
          }),
        ]),
      }),
    });
    await prisma.generationJob.update({
      where: { id: coverJobId },
      data: { provider: "comfyui" },
    });
    await prisma.generationAttempt.update({
      where: { id: `${coverJobId}-attempt` },
      data: { provider: "comfyui" },
    });
    await expect(validateCharacterRelease({
      request: validationRequest,
      characterId,
      releaseId: proposed.id,
      expectedVersion: approved.version,
    })).resolves.toMatchObject({ result: "passed", readiness: "ready" });

    const acceptedFromTabs = await Promise.all([acceptPublish("tab-a"), acceptPublish("tab-b")]);
    const tabResults = await Promise.all(acceptedFromTabs.map(async (response) => ({
      status: response.status,
      body: await response.json(),
    })));
    expect(tabResults.map((result) => result.status).sort((left, right) => left - right))
      .toEqual([202, 409]);
    const acceptedTab = tabResults.find((result) => result.status === 202);
    const conflictedTab = tabResults.find((result) => result.status === 409);
    if (!acceptedTab || !conflictedTab) {
      throw new Error("Expected one accepted publish command and one active-command conflict");
    }
    const publishCommandId = acceptedTab.body.data.commandId as string;
    expect(conflictedTab.body).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: {
          activeCommandId: publishCommandId,
          activeCommandType: "character.release.publish",
          activeCommandStatus: "accepted",
        },
      },
    });
    await expect(executeCharacterReleaseCommand(prisma, {
      commandId: publishCommandId,
      workerId: `release-lifecycle-worker-${suffix}`,
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({ state: "live", currentReleaseId: proposed.id, version: 2 });
    await expect(prisma.character.findUnique({ where: { id: characterId } })).resolves.toMatchObject({ imageAssetId: draftAssetId });
    await expect(
      prisma.mediaAsset.findMany({
        where: { id: { in: [draftAssetId, heroAssetId, chatAssetId] } },
        select: { id: true, visibility: true },
        orderBy: { id: "asc" },
      }),
    ).resolves.toEqual(
      [draftAssetId, heroAssetId, chatAssetId]
        .sort()
        .map((id) => ({ id, visibility: "public_pack" })),
    );
    await expect(prisma.characterProject.findUnique({ where: { id: projectId } })).resolves.toMatchObject({ phase: "live_management" });

    const pauseForHeroDrift = await changeCharacterServingState(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/pause`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": `pause-hero-drift-${suffix}`,
        },
        body: JSON.stringify({
          entityVersion: 2,
          reason: {
            code: "incident_hold",
            summary: "Pause while verifying the full release asset pack",
          },
          confirmation: `${characterId}:pause`,
        }),
      }),
      characterId,
      "pause",
    );
    expect(pauseForHeroDrift.status).toBe(202);
    const pauseForHeroDriftCommandId =
      (await pauseForHeroDrift.json()).data.commandId as string;
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: pauseForHeroDriftCommandId,
        workerId: `release-lifecycle-pause-hero-drift-${suffix}`,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const pinnedQualification =
      await prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId: proposed.id },
      });
    if (!pinnedQualification.validationRunId) {
      throw new Error("Generated Release fixture must pin a validation run");
    }

    await prisma.mediaAsset.update({
      where: { id: heroAssetId },
      data: { safetyStatus: "blocked" },
    });
    const rejectedHeroDriftResume = await changeCharacterServingState(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/resume`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": `resume-hero-drift-${suffix}`,
        },
        body: JSON.stringify({
          entityVersion: 3,
          reason: {
            code: "incident_recovery",
            summary: "Attempt resume after a non-avatar placement drift",
          },
          confirmation: `${characterId}:resume`,
        }),
      }),
      characterId,
      "resume",
    );
    expect(rejectedHeroDriftResume.status).toBe(202);
    const rejectedHeroDriftResumeCommandId =
      (await rejectedHeroDriftResume.json()).data.commandId as string;
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: rejectedHeroDriftResumeCommandId,
        workerId: `release-lifecycle-resume-hero-drift-${suffix}`,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "serving_resume_validation_failed",
    });
    await expect(
      prisma.characterServing.findUnique({ where: { characterId } }),
    ).resolves.toMatchObject({
      state: "paused",
      currentReleaseId: proposed.id,
      version: 3,
    });
    await expect(
      prisma.character.findUnique({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      status: "archived",
      visibility: "private",
      imageAssetId: draftAssetId,
    });
    const heroDriftValidation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: proposed.id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    await expect(
      prisma.releaseCheckResult.findUnique({
        where: {
          validationRunId_checkKey: {
            validationRunId: heroDriftValidation.id,
            checkKey: "release_asset_manifest_available",
          },
        },
      }),
    ).resolves.toMatchObject({
      result: "failed",
      evidence: expect.objectContaining({
        unavailablePlacementSlots: ["character_hero"],
      }),
    });
    await prisma.mediaAsset.update({
      where: { id: heroAssetId },
      data: { safetyStatus: "passed" },
    });
    const staleGeneratedRelease = await prisma.characterRelease.update({
      where: { id: proposed.id },
      data: { readiness: "stale", version: { increment: 1 } },
    });
    const recoveredHeroDriftResume = await changeCharacterServingState(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/resume`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": `resume-hero-drift-recovered-${suffix}`,
        },
        body: JSON.stringify({
          entityVersion: 3,
          reason: {
            code: "incident_recovery",
            summary: "Resume after restoring the full release asset pack",
          },
          confirmation: `${characterId}:resume`,
        }),
      }),
      characterId,
      "resume",
    );
    expect(recoveredHeroDriftResume.status).toBe(202);
    const recoveredHeroDriftResumeCommandId =
      (await recoveredHeroDriftResume.json()).data.commandId as string;
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: recoveredHeroDriftResumeCommandId,
        workerId: `release-lifecycle-resume-hero-recovered-${suffix}`,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      prisma.characterServing.findUnique({ where: { characterId } }),
    ).resolves.toMatchObject({
      state: "live",
      currentReleaseId: proposed.id,
      version: 4,
    });
    await expect(
      prisma.characterRelease.findUniqueOrThrow({
        where: { id: proposed.id },
      }),
    ).resolves.toMatchObject({
      readiness: "ready",
      version: staleGeneratedRelease.version + 1,
    });
    await expect(
      prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId: proposed.id },
      }),
    ).resolves.toEqual(pinnedQualification);
    const recoveredResumeValidation =
      await prisma.releaseValidationRun.findFirstOrThrow({
        where: { releaseId: proposed.id },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      });
    expect(recoveredResumeValidation).toMatchObject({
      result: "passed",
      finishedAt: expect.any(Date),
    });
    expect(recoveredResumeValidation.id).not.toBe(
      pinnedQualification.validationRunId,
    );
    const expectedResumeEvidence = {
      authorityKind: "generated_release",
      qualificationId: pinnedQualification.id,
      qualificationValidationRunId: pinnedQualification.validationRunId,
      resumeValidationRunId: recoveredResumeValidation.id,
    };
    await expect(
      prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: recoveredHeroDriftResumeCommandId },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({
        releaseReadiness: "ready",
        releaseVersion: staleGeneratedRelease.version + 1,
        resumeEvidence: expectedResumeEvidence,
      }),
    });
    await expect(
      prisma.characterReleaseEvent.findFirstOrThrow({
        where: {
          releaseId: proposed.id,
          commandId: recoveredHeroDriftResumeCommandId,
          type: "character.serving.resumed",
        },
      }),
    ).resolves.toMatchObject({
      toState: expect.objectContaining({
        releaseReadiness: "ready",
        releaseVersion: staleGeneratedRelease.version + 1,
        resumeEvidence: expectedResumeEvidence,
      }),
    });

    await prisma.characterProject.update({ where: { id: projectId }, data: { phase: "qa" } });
    const evidenceBeforeRejectedRetire = await Promise.all([
      prisma.characterReleaseEvent.count({ where: { characterId } }),
      prisma.adminAuditLog.count({ where: { actorId, action: "character.serving.retire.executed" } }),
      prisma.mainOutboxEvent.count({ where: { aggregateId: proposed.id, eventType: "character.serving.retired.v2" } }),
    ]);
    const rejectedRetireRequest = new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/retire`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `retire-invalid-phase-${suffix}` },
      body: JSON.stringify({ entityVersion: 4, reason: { code: "portfolio_retirement", summary: "Retire after explicit portfolio decision" }, confirmation: `${characterId}:retire` }),
    });
    const rejectedRetire = await changeCharacterServingState(rejectedRetireRequest, characterId, "retire");
    expect(rejectedRetire.status).toBe(202);
    const rejectedCommandId = (await rejectedRetire.json()).data.commandId as string;
    await expect(
      prisma.controlPlaneCommand.findUnique({ where: { id: rejectedCommandId } }),
    ).resolves.toMatchObject({
      commandType: "character.serving.retire",
      status: "accepted",
    });
    await expect(
      prisma.characterProject.findUnique({ where: { id: projectId } }),
    ).resolves.toMatchObject({
      phase: "qa",
    });
    await expect(executeCharacterReleaseCommand(prisma, { commandId: rejectedCommandId, workerId: `release-lifecycle-invalid-retire-${suffix}` })).resolves.toMatchObject({
      status: "failed",
      errorCode: "project_phase_conflict",
    });
    await expect(prisma.characterProject.findUnique({ where: { id: projectId } })).resolves.toMatchObject({ phase: "qa", activeKey: `official:${characterId}` });
    await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({ state: "live", version: 4 });
    await expect(Promise.all([
      prisma.characterReleaseEvent.count({ where: { characterId } }),
      prisma.adminAuditLog.count({ where: { actorId, action: "character.serving.retire.executed" } }),
      prisma.mainOutboxEvent.count({ where: { aggregateId: proposed.id, eventType: "character.serving.retired.v2" } }),
    ])).resolves.toEqual(evidenceBeforeRejectedRetire);

    await prisma.characterProject.update({ where: { id: projectId }, data: { phase: "live_management" } });
    const cancelledScheduledAt = new Date("2099-01-01T00:00:00.000Z");
    await prisma.characterServing.update({
      where: { characterId },
      data: {
        scheduledReleaseId: proposed.id,
        scheduledAt: cancelledScheduledAt,
      },
    });
    const retireRequest = new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/retire`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `retire-${suffix}` },
      body: JSON.stringify({ entityVersion: 4, reason: { code: "portfolio_retirement", summary: "Retire after explicit portfolio decision" }, confirmation: `${characterId}:retire` }),
    });
    const accepted = await changeCharacterServingState(retireRequest, characterId, "retire");
    const commandId = (await accepted.json()).data.commandId as string;
    await expect(prisma.controlPlaneCommand.findUnique({ where: { id: commandId } })).resolves.toMatchObject({
      commandType: "character.serving.retire",
    });
    await expect(executeCharacterReleaseCommand(prisma, { commandId, workerId: `release-lifecycle-worker-${suffix}` })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.characterProject.findUnique({ where: { id: projectId } })).resolves.toMatchObject({ phase: "retired", activeKey: null });
    await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({
      state: "retired",
      version: 5,
      scheduledReleaseId: null,
      scheduledAt: null,
    });
    await expect(prisma.characterReleaseEvent.findFirst({
      where: { characterId, commandId },
    })).resolves.toMatchObject({
      type: "character.serving.retired",
      fromState: {
        scheduledReleaseId: proposed.id,
        scheduledAt: cancelledScheduledAt.toISOString(),
      },
      toState: {
        scheduledReleaseId: null,
        scheduledAt: null,
        cancelledScheduledReleaseId: proposed.id,
      },
    });

    const resumeRequest = new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/resume`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `resume-retired-${suffix}` },
      body: JSON.stringify({ entityVersion: 5, reason: { code: "invalid_resume", summary: "Retired is terminal, not paused" }, confirmation: `${characterId}:resume` }),
    });
    const resumeResponse = await changeCharacterServingState(resumeRequest, characterId, "resume");
    expect(resumeResponse.status).toBe(422);

    // Keep one-way revocation as the terminal scenario. The fixture resets the
    // already-tested Serving lifecycle to paused, but never deletes, recreates,
    // or un-revokes the pinned qualification.
    await prisma.characterProject.update({
      where: { id: projectId },
      data: {
        phase: "live_management",
        activeKey: `official:${characterId}`,
      },
    });
    const revokedResumeServing = await prisma.characterServing.update({
      where: { characterId },
      data: {
        state: "paused",
        version: { increment: 1 },
      },
    });
    const releaseBeforeRevokedResume =
      await prisma.characterRelease.findUniqueOrThrow({
        where: { id: proposed.id },
      });
    const validationsBeforeRevokedResume =
      await prisma.releaseValidationRun.count({
        where: { releaseId: proposed.id },
      });
    await prisma.publicCatalogQualification.update({
      where: { id: pinnedQualification.id },
      data: { revokedAt: new Date("2026-07-17T14:00:00.000Z") },
    });
    const revokedQualificationResume = await changeCharacterServingState(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/resume`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": `resume-revoked-qualification-${suffix}`,
        },
        body: JSON.stringify({
          entityVersion: revokedResumeServing.version,
          reason: {
            code: "incident_recovery",
            summary: "Fresh validation must not replace revoked pinned authority",
          },
          confirmation: `${characterId}:resume`,
        }),
      }),
      characterId,
      "resume",
    );
    expect(revokedQualificationResume.status).toBe(202);
    const revokedQualificationResumeCommandId =
      (await revokedQualificationResume.json()).data.commandId as string;
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: revokedQualificationResumeCommandId,
        workerId: `release-lifecycle-resume-revoked-qualification-${suffix}`,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "serving_resume_qualification_invalid",
    });
    const revokedQualificationFreshValidation =
      await prisma.releaseValidationRun.findFirstOrThrow({
        where: { releaseId: proposed.id },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      });
    expect(revokedQualificationFreshValidation).toMatchObject({
      result: "passed",
      finishedAt: expect.any(Date),
    });
    expect(revokedQualificationFreshValidation.id).not.toBe(
      pinnedQualification.validationRunId,
    );
    await expect(
      prisma.releaseValidationRun.count({
        where: { releaseId: proposed.id },
      }),
    ).resolves.toBe(validationsBeforeRevokedResume + 1);
    await expect(
      prisma.characterRelease.findUniqueOrThrow({
        where: { id: proposed.id },
      }),
    ).resolves.toEqual(releaseBeforeRevokedResume);
    await expect(
      prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).resolves.toMatchObject({
      state: "paused",
      currentReleaseId: proposed.id,
      version: revokedResumeServing.version,
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      status: "archived",
      visibility: "private",
      imageAssetId: draftAssetId,
    });
    await expect(
      prisma.characterReleaseEvent.count({
        where: {
          releaseId: proposed.id,
          commandId: revokedQualificationResumeCommandId,
          type: "character.serving.resumed",
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { id: pinnedQualification.id },
      }),
    ).resolves.toMatchObject({
      releaseId: proposed.id,
      revokedAt: new Date("2026-07-17T14:00:00.000Z"),
    });
  });
});
