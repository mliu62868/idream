import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { compileCharacterSoul } from "@idream/shared";
import { characterSoulBehaviorEvaluatorVersion } from "@idream/shared/admin";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { characterSoulQaEvidence } from "@/server/test/character-soul-evidence";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-policy";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
  characterReleaseSnapshotHash,
} from "./release-snapshot";
import {
  characterReleaseProposalBlockers,
  evaluateCharacterReleaseSnapshot,
  releaseCheckKeys,
  type CharacterReleaseSnapshotCandidate,
} from "./release-validation";

// SPEC: 发布合法性规则引擎的直接测试 —— 18 道闸每道至少一个失败场景 + 一个全通过场景。
// INTENT: 这台引擎此前只被发布/恢复的集成测试间接覆盖，11 个 check key（含 Soul 四道门）从未被
// 任何测试点名。它现在同时是提案闸，任何一道闸失灵都会让一个必然发布失败的候选进入评审队列。
describe("Character Release validation authority", () => {
  const suffix = randomUUID();
  const id = (name: string) => `release-validation-${name}-${suffix}`;
  const actorId = id("admin");
  const characterId = id("character");
  const referenceAssetId = id("reference-asset");
  const projectId = id("project");
  const contentId = id("content");
  const revisionId = id("revision");
  const profileId = id("profile");
  const referenceSetId = id("reference-set");
  const routeFingerprint = id("route");
  const routeQualificationId = id("route-qualification");
  const generationProfileId = id("generation-profile");
  const generationProfileKey = id("generation-key");
  const qaRunId = id("qa-run");

  const slots = [
    { slotKey: "character_avatar", purpose: "character_cover", name: "cover" },
    { slotKey: "character_hero", purpose: "character_hero", name: "hero" },
    { slotKey: "character_chat", purpose: "character_chat", name: "chat" },
  ] as const;
  const slotIds = slots.map((slot) => ({
    ...slot,
    assetId: id(`${slot.name}-asset`),
    runId: id(`${slot.name}-run`),
    itemId: id(`${slot.name}-item`),
    jobId: id(`${slot.name}-job`),
    decisionId: id(`${slot.name}-decision`),
    attemptId: id(`${slot.name}-attempt`),
  }));
  const avatar = slotIds[0]!;

  let baseCandidate!: CharacterReleaseSnapshotCandidate;

  const evaluate = (overrides: Partial<CharacterReleaseSnapshotCandidate> = {}) =>
    prisma.$transaction((tx) =>
      evaluateCharacterReleaseSnapshot(
        tx,
        { ...baseCandidate, ...overrides },
        CHARACTER_RELEASE_POLICY_VERSION,
        new Date(),
      ),
    );

  const failedKeys = async (
    overrides: Partial<CharacterReleaseSnapshotCandidate> = {},
  ) => (await evaluate(overrides)).failed.map((check) => check.key);

  /** 临时改写一行事实，跑一次引擎，再恢复原状。 */
  const withDrift = async <T>(
    apply: () => Promise<unknown>,
    revert: () => Promise<unknown>,
    run: () => Promise<T>,
  ) => {
    await apply();
    try {
      return await run();
    } finally {
      await revert();
    }
  };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" } });
    await prisma.character.create({ data: { id: characterId, creatorId: actorId, name: "Validation Candidate", age: 24, description: "Release validation fixture", visibility: "private", status: "draft", appearance: {}, advancedDetails: {} } });
    await prisma.mediaAsset.create({ data: { id: referenceAssetId, ownerId: actorId, characterId, type: "image", url: `https://assets.test/${referenceAssetId}.webp`, safetyStatus: "passed", metadata: {} } });
    await prisma.mediaAsset.createMany({
      data: slotIds.map((slot) => ({ id: slot.assetId, ownerId: actorId, characterId, type: "image" as const, url: `https://assets.test/${slot.assetId}.webp`, safetyStatus: "passed", metadata: {} })),
    });

    const profile = await prisma.characterVisualProfile.create({ data: { id: profileId, characterId, version: 1, status: "active", style: "realistic", identityPrompt: "same adult character", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [referenceAssetId], adapterRefs: {}, createdFrom: "test" } });
    const visualProfileHash = characterVisualProfileSnapshotHash(profile);
    await prisma.characterVisualProfile.update({ where: { id: profileId }, data: { immutableHash: visualProfileHash } });

    await prisma.referenceSetRevision.create({ data: { id: referenceSetId, visualProfileId: profileId, revision: 1, status: "active", selectorVersion: "v1", createdFrom: "test" } });
    await prisma.characterVisualReferenceSnapshot.create({ data: { referenceSetRevisionId: referenceSetId, mediaAssetId: referenceAssetId, position: 0, role: "primary_face", weight: 1, selectorVersion: "v1", selectionReason: "validation fixture" } });
    const referenceManifest = [{ mediaAssetId: referenceAssetId, position: 0, role: "primary_face", weight: 1 }];
    const referenceSetHash = referenceSetSnapshotHash({ visualProfileId: profileId, revision: 1, selectorVersion: "v1", references: referenceManifest });
    await prisma.referenceSetRevision.update({ where: { id: referenceSetId }, data: { snapshotHash: referenceSetHash } });

    await prisma.generationModelProfile.create({ data: { id: generationProfileId, profileKey: generationProfileKey, label: "Release validation", pipelineModel: "qwen-image-edit-img2img", workflowKey: "qwen-image-edit-img2img", runner: "comfyui", runnerConfig: { capabilities: { referenceImages: true, initImage: true } }, allowedOrientations: ["4:5"], status: "active", enabled: true, rolloutPercent: 100 } });
    await prisma.generationRouteQualification.create({ data: { id: routeQualificationId, routeFingerprint, generationProfileKey, generationProfileVersion: 1, workflowKey: "qwen-image-edit-img2img", workflowVersion: 1, style: "realistic", matrixKey: "realistic-avatar", sampleCount: 40, passCount: 40, identityMatch: 1, result: "qualified", evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION }, policyVersion: CHARACTER_RELEASE_POLICY_VERSION } });

    for (const slot of slotIds) {
      await prisma.contentProductionBatch.create({ data: { id: slot.runId, title: slot.purpose, purpose: slot.purpose, targetType: "character", targetId: characterId, presetIds: [], count: 1, totalItems: 1, completedItems: 1, approvedItems: 1, status: "reviewing", lifecycleState: "active", workflowStage: "placement", verificationState: "pending", createdById: actorId } });
      await prisma.contentProductionItem.create({ data: { id: slot.itemId, batchId: slot.runId, mediaAssetId: slot.assetId, itemIndex: 0, status: "approved", tags: [] } });
      await prisma.creativeReviewDecision.create({ data: { id: slot.decisionId, runItemId: slot.itemId, artifactId: slot.assetId, decision: "approved", identityConsistency: "passed", score: 92, evidence: { artifactFree: true, singleSubject: true, intentMatch: true, noVisibleText: true }, reason: "Approved", reviewerId: actorId } });
      await prisma.generationJob.create({ data: {
        id: slot.jobId, userId: actorId, characterId, visualProfileId: profileId, visualProfileVersion: 1,
        consistencyMode: "strict", referenceAssetIds: [referenceAssetId], referenceSetRevisionId: referenceSetId,
        referenceManifest: referenceManifest.map((reference) => ({ ...reference, selectorVersion: "v1", selectionReason: "identity authority", referenceSetRevisionId: referenceSetId, referenceSetRevision: 1, snapshotHash: referenceSetHash })),
        mode: "image", controls: {}, presetIds: [], model: "qwen-image-edit-img2img", profileId: generationProfileKey, profileVersion: 1,
        orientation: "4:5", outputCount: 1, deliveredOutputCount: 1, status: "completed", provider: "comfyui",
        sourceType: "content_production_item", sourceId: slot.itemId,
        sourceMeta: { batchId: slot.runId, purpose: slot.purpose, targetType: "character", targetId: characterId, bootstrapIdentity: false, referenceSetRevisionId: referenceSetId, generationRouteQualificationId: routeQualificationId, generationRouteFingerprint: routeFingerprint },
        completedAt: new Date(), finishedAt: new Date(),
      } });
      await prisma.generationAttempt.create({ data: { id: slot.attemptId, requestId: slot.jobId, attemptNo: 1, provider: "comfyui", profileKey: generationProfileKey, profileVersion: 1, workflowKey: "qwen-image-edit-img2img", workflowVersion: 1, status: "succeeded", creativeRunItemId: slot.itemId, finishedAt: new Date() } });
      await prisma.contentProductionItem.update({ where: { id: slot.itemId }, data: { jobId: slot.jobId } });
      await prisma.mediaAsset.update({ where: { id: slot.assetId }, data: { sourceJobId: slot.jobId } });
    }

    const compiledSoul = compileCharacterSoul({
      name: "Validated Candidate", age: 25, gender: "female", relationshipArchetype: "companion",
      characterPromise: "A consistent validation candidate",
      personality: "Observant, direct, and emotionally grounded.",
      values: ["honesty"], wants: ["build mutual trust"], fears: ["breaking a confidence"],
      contradictions: ["careful but spontaneously playful"],
      backstory: "She learned to value dependable companionship through years of community work.",
      tone: "Warm and concise.", cadence: "Measured sentences with occasional dry humor.",
      vocabulary: ["grounded", "specific"], voiceHabits: ["asks one focused follow-up"], voiceAvoid: ["generic reassurance"],
      interaction: { initiative: "Offer a concrete next step.", curiosity: "Ask about motives, not just events.", pacing: "Let emotional turns breathe.", affection: "Show care through attentive recall.", conflict: "Name disagreement without escalating.", repair: "Acknowledge impact and propose repair." },
      canon: { facts: ["She works with local community groups."], unknowns: ["The user's private history unless disclosed."] },
      exampleDialogue: ["I hear the decision. What part feels hardest to carry?"],
      negativeDialogue: [{ assistant: "Everything will be fine.", reason: "Generic reassurance ignores the user's actual concern." }],
    });
    if (!compiledSoul.ok) throw new Error("validation fixture Soul must compile");
    const soulEvidence = characterSoulQaEvidence({ characterContentVersionId: contentId, personaSnapshot: compiledSoul.snapshot });

    await prisma.characterContentVersion.create({ data: { id: contentId, characterId, version: 1, contentHash: compiledSoul.snapshot.compiled.fingerprint, personaSnapshot: toInputJson(compiledSoul.snapshot), openingSnapshot: { firstMessage: "Hello" }, appearanceSnapshot: { style: "realistic" }, sourceType: "test", createdById: actorId } });

    const draftAssetPack = Object.fromEntries(slotIds.map((slot) => [slot.purpose, { assetId: slot.assetId, runId: slot.runId, itemId: slot.itemId, reviewDecisionId: slot.decisionId, generationJobId: slot.jobId, generationRouteFingerprint: routeFingerprint }]));
    await prisma.characterProject.create({ data: { id: projectId, characterId, ownerId: actorId, phase: "qa", audience: {}, successCriteria: ["five_turn_qa"], draftImageAssetId: avatar.assetId, draftAssetPack, activeKey: `official:${characterId}` } });
    await prisma.characterRevision.create({ data: { id: revisionId, projectId, revision: 1, characterContentVersionId: contentId, projectSnapshot: {}, createdById: actorId } });
    await prisma.characterQaRun.create({ data: {
      ...soulEvidence, id: qaRunId, characterId, projectId, characterContentVersionId: contentId, projectVersion: 1,
      visualProfileId: profileId, visualProfileVersion: 1, visualProfileHash,
      referenceSetRevisionId: referenceSetId, referenceSetRevision: 1, referenceSetHash,
      draftAssetPackHash: canonicalSha256(draftAssetPack), ownerId: actorId, status: "passed", checks: [],
      evidenceHash: id("qa-evidence"),
    } });

    const snapshot = {
      projectId,
      revisionId,
      characterContentVersionId: contentId,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      generationProvenance: {
        schemaVersion: "character-release-generation-provenance-v2",
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        requiredReleaseRoute: { routeFingerprint, matrixKey: "realistic-avatar", generationProfileKey, generationProfileVersion: 1, workflowKey: "qwen-image-edit-img2img", workflowVersion: 1 },
        visualAuthority: { visualProfileId: profileId, visualProfileVersion: 1, visualProfileHash, referenceSetRevisionId: referenceSetId, referenceSetHash },
        placements: slotIds.map((slot) => ({
          slotKey: slot.slotKey, assetId: slot.assetId, runId: slot.runId, itemId: slot.itemId,
          reviewDecisionId: slot.decisionId, generationJobId: slot.jobId,
          generationRouteFingerprint: routeFingerprint, bootstrapIdentity: false,
          generationProfileKey, generationProfileVersion: 1,
          workflowKey: "qwen-image-edit-img2img", workflowVersion: 1,
          visualProfileId: profileId, visualProfileVersion: 1, referenceSetRevisionId: referenceSetId,
          referenceAssetIds: [referenceAssetId],
          referenceManifestHash: canonicalSha256(referenceManifest.map((reference) => ({ ...reference, selectorVersion: "v1", selectionReason: "identity authority", referenceSetRevisionId: referenceSetId, referenceSetRevision: 1, snapshotHash: referenceSetHash }))),
          provider: "comfyui", deliveredOutputCount: 1,
          attemptId: slot.attemptId, attemptNo: 1, completedAt: null,
        })),
        characterQa: { status: "passed", qaRunId, evidenceHash: id("qa-evidence"), characterId, projectId, characterContentVersionId: contentId, projectVersion: 1, visualProfileId: profileId, visualProfileVersion: 1, visualProfileHash, referenceSetRevisionId: referenceSetId, referenceSetRevision: 1, referenceSetHash, draftAssetPackHash: canonicalSha256(draftAssetPack) },
      },
      releasePlacementManifest: {
        schemaVersion: 2,
        placements: slotIds.map((slot) => ({ slotKey: slot.slotKey, assetId: slot.assetId, slotVersion: 1, runId: slot.runId, itemId: slot.itemId, reviewDecisionId: slot.decisionId, generationJobId: slot.jobId })),
      },
    };
    baseCandidate = {
      ...snapshot,
      snapshotHash: characterReleaseSnapshotHash(snapshot),
      legacy: false,
      rollbackOfReleaseId: null,
    };
  });

  afterAll(async () => {
    await prisma.characterQaRun.deleteMany({ where: { projectId } });
    await prisma.characterRevision.deleteMany({ where: { id: revisionId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { in: slotIds.map((slot) => slot.itemId) } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: slotIds.map((slot) => slot.jobId) } } });
    await prisma.contentProductionItem.deleteMany({ where: { id: { in: slotIds.map((slot) => slot.itemId) } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: slotIds.map((slot) => slot.jobId) } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: slotIds.map((slot) => slot.runId) } } });
    await prisma.generationRouteQualification.deleteMany({ where: { routeFingerprint } });
    await prisma.generationModelProfile.deleteMany({ where: { id: generationProfileId } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { referenceSetRevisionId: referenceSetId } });
    await prisma.referenceSetRevision.deleteMany({ where: { id: referenceSetId } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: profileId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [referenceAssetId, ...slotIds.map((slot) => slot.assetId)] } } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("passes every declared check for an intact snapshot, and declares exactly those checks", async () => {
    const evaluation = await evaluate();
    expect(evaluation.failed).toEqual([]);
    expect(evaluation.checks.map((check) => check.key).sort())
      .toEqual([...releaseCheckKeys].sort());
    expect(evaluation.snapshotHash).toBe(baseCandidate.snapshotHash);
  });

  it("fails release_generation_authority_kind when the provenance is not the governed v2 shape", async () => {
    await expect(failedKeys({
      generationProvenance: { ...(baseCandidate.generationProvenance as object), schemaVersion: "character-release-generation-provenance-v1" },
    })).resolves.toContain("release_generation_authority_kind");
  });

  it("fails project_character_authority when the Project or its Character row is gone", async () => {
    await expect(failedKeys({ projectId: `${projectId}-missing` }))
      .resolves.toContain("project_character_authority");
    const orphaned = await evaluate({ projectId: `${projectId}-missing` });
    expect(orphaned.checks.find((check) => check.key === "project_character_authority")?.evidence)
      .toMatchObject({ characterExists: false });
  });

  it("fails revision_is_immutable_and_pinned when no revision is pinned", async () => {
    await expect(failedKeys({ revisionId: null }))
      .resolves.toContain("revision_is_immutable_and_pinned");
  });

  it("fails soul_snapshot_valid and opening_complete when the pinned content cannot produce a Soul or an opening", async () => {
    const brokenContentId = id("broken-content");
    await prisma.characterContentVersion.create({ data: { id: brokenContentId, characterId, version: 2, contentHash: brokenContentId, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: { style: "realistic" }, sourceType: "test", createdById: actorId } });
    const keys = await failedKeys({ characterContentVersionId: brokenContentId });
    expect(keys).toContain("soul_snapshot_valid");
    expect(keys).toContain("opening_complete");
    await prisma.characterContentVersion.delete({ where: { id: brokenContentId } });
  });

  it("fails soul_release_policy when a governed Soul still carries authoring diagnostics", async () => {
    const partialSoul = compileCharacterSoul({
      name: "Partial Soul", age: 22, gender: "female", relationshipArchetype: "companion",
      characterPromise: "An incomplete authoring pass",
      personality: "Reserved.", values: [], wants: [], fears: [], contradictions: [],
      backstory: "", tone: "", cadence: "", vocabulary: [], voiceHabits: [], voiceAvoid: [],
      canon: { facts: [], unknowns: [] }, exampleDialogue: [], negativeDialogue: [],
    });
    if (!partialSoul.ok) throw new Error("partial Soul fixture must still compile");
    expect(partialSoul.diagnostics.length).toBeGreaterThan(0);
    const partialContentId = id("partial-content");
    await prisma.characterContentVersion.create({ data: { id: partialContentId, characterId, version: 3, contentHash: partialSoul.snapshot.compiled.fingerprint, personaSnapshot: toInputJson(partialSoul.snapshot), openingSnapshot: { firstMessage: "Hi" }, appearanceSnapshot: { style: "realistic" }, sourceType: "test", createdById: actorId } });
    await expect(failedKeys({ characterContentVersionId: partialContentId }))
      .resolves.toContain("soul_release_policy");
    // legacy Release 保留 schemaVersion 0 的显式提示词，同一份内容对它不是阻塞。
    await expect(failedKeys({ characterContentVersionId: partialContentId, legacy: true }))
      .resolves.not.toContain("soul_release_policy");
    await prisma.characterContentVersion.delete({ where: { id: partialContentId } });
  });

  it("fails soul_behavior_evaluation when the evidence came from a retired evaluator", async () => {
    const run = await prisma.characterQaRun.findUniqueOrThrow({ where: { id: qaRunId } });
    const behavior = run.behaviorEvaluation as Record<string, unknown>;
    expect(behavior.evaluatorVersion).toBe(characterSoulBehaviorEvaluatorVersion);
    await expect(withDrift(
      () => prisma.characterQaRun.update({ where: { id: qaRunId }, data: { behaviorEvaluation: toInputJson({ ...behavior, evaluatorVersion: "character-soul-evaluator-3" }) } }),
      () => prisma.characterQaRun.update({ where: { id: qaRunId }, data: { behaviorEvaluation: toInputJson(behavior) } }),
      () => failedKeys(),
    )).resolves.toContain("soul_behavior_evaluation");
  });

  it("fails soul_live_model_canaries when a required chat tier has no passing canary", async () => {
    const run = await prisma.characterQaRun.findUniqueOrThrow({ where: { id: qaRunId } });
    await expect(withDrift(
      () => prisma.characterQaRun.update({ where: { id: qaRunId }, data: { liveCanaries: toInputJson([]) } }),
      () => prisma.characterQaRun.update({ where: { id: qaRunId }, data: { liveCanaries: run.liveCanaries ?? undefined } }),
      () => failedKeys(),
    )).resolves.toContain("soul_live_model_canaries");
  });

  it("fails visual_identity_exact_version when the pinned profile version drifted", async () => {
    await expect(failedKeys({ visualProfileVersion: 2 }))
      .resolves.toContain("visual_identity_exact_version");
  });

  it("fails reference_set_published_snapshot when a pinned reference image became unavailable", async () => {
    await expect(withDrift(
      () => prisma.mediaAsset.update({ where: { id: referenceAssetId }, data: { safetyStatus: "blocked" } }),
      () => prisma.mediaAsset.update({ where: { id: referenceAssetId }, data: { safetyStatus: "passed" } }),
      () => failedKeys(),
    )).resolves.toContain("reference_set_published_snapshot");
  });

  it("fails generation_route_qualified when the pinned route is no longer qualified", async () => {
    await expect(withDrift(
      () => prisma.generationRouteQualification.update({ where: { id: routeQualificationId }, data: { evidence: { evaluatorVersion: "retired-evaluator" } } }),
      () => prisma.generationRouteQualification.update({ where: { id: routeQualificationId }, data: { evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION } } }),
      () => failedKeys(),
    )).resolves.toContain("generation_route_qualified");
  });

  it("fails character_qa_passed when the QA authority no longer matches the live snapshot", async () => {
    const drifted = await evaluate({
      liveQaAuthority: { projectVersion: 7, draftAssetPackHash: "drifted" },
    });
    const check = drifted.checks.find((item) => item.key === "character_qa_passed");
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toMatchObject({ authorityMatches: false, authorityStatus: "passed" });
  });

  it("fails release_avatar_manifest_available and release_asset_manifest_available when a placement asset is unavailable", async () => {
    const keys = await withDrift(
      () => prisma.mediaAsset.update({ where: { id: avatar.assetId }, data: { safetyStatus: "blocked" } }),
      () => prisma.mediaAsset.update({ where: { id: avatar.assetId }, data: { safetyStatus: "passed" } }),
      () => failedKeys(),
    );
    expect(keys).toContain("release_avatar_manifest_available");
    expect(keys).toContain("release_asset_manifest_available");
  });

  it("fails release_asset_manifest_available when the manifest is not the exact three-slot pack", async () => {
    const manifest = baseCandidate.releasePlacementManifest as { placements: unknown[] };
    await expect(failedKeys({
      releasePlacementManifest: { schemaVersion: 2, placements: manifest.placements.slice(0, 2) },
    })).resolves.toContain("release_asset_manifest_available");
  });

  it("fails release_assets_customer_publishable when a placement asset is synthetic", async () => {
    await expect(withDrift(
      () => prisma.mediaAsset.update({ where: { id: avatar.assetId }, data: { metadata: { synthetic: true, source: "mock" } } }),
      () => prisma.mediaAsset.update({ where: { id: avatar.assetId }, data: { metadata: {} } }),
      () => failedKeys(),
    )).resolves.toContain("release_assets_customer_publishable");
  });

  it("fails release_asset_review_authority when the latest review decision rejects the pinned artifact", async () => {
    const rejectionId = id("late-rejection");
    await expect(withDrift(
      () => prisma.creativeReviewDecision.create({ data: { id: rejectionId, runItemId: avatar.itemId, artifactId: avatar.assetId, decision: "rejected", identityConsistency: "failed", reason: "Post-proposal drift", reviewerId: actorId, createdAt: new Date("2035-01-01T00:00:00.000Z") } }),
      () => prisma.creativeReviewDecision.delete({ where: { id: rejectionId } }),
      () => failedKeys(),
    )).resolves.toContain("release_asset_review_authority");
  });

  it("fails release_asset_generation_authority when the pinned job lost its identity authority", async () => {
    await expect(withDrift(
      () => prisma.generationJob.update({ where: { id: avatar.jobId }, data: { visualProfileId: null } }),
      () => prisma.generationJob.update({ where: { id: avatar.jobId }, data: { visualProfileId: profileId } }),
      () => failedKeys(),
    )).resolves.toContain("release_asset_generation_authority");
  });

  it("fails snapshot_hash_matches when the stored hash does not cover the snapshot", async () => {
    await expect(failedKeys({ snapshotHash: "0".repeat(64) }))
      .resolves.toContain("snapshot_hash_matches");
  });

  // 提案响应的 code 词表在这台引擎之上，且四道闸的 code 比闸本身更细。
  it("translates engine verdicts into the stable proposal blocker vocabulary", () => {
    expect(characterReleaseProposalBlockers([
      { key: "project_character_authority", evidence: { characterExists: false } },
      { key: "revision_is_immutable_and_pinned", evidence: {} },
      { key: "generation_route_qualified", evidence: {} },
      { key: "release_avatar_manifest_available", evidence: {} },
    ])).toEqual([
      "character_missing",
      "revision_missing",
      "qualified_generation_route_missing",
      "approved_avatar_missing",
    ]);
    expect(characterReleaseProposalBlockers([
      { key: "character_qa_passed", evidence: { authorityStatus: "failed", authorityMatches: true } },
    ])).toEqual(["character_qa_not_passed"]);
    expect(characterReleaseProposalBlockers([
      { key: "character_qa_passed", evidence: { authorityStatus: "passed", authorityMatches: false } },
    ])).toEqual(["character_qa_authority_mismatch"]);
    expect(characterReleaseProposalBlockers([
      { key: "character_qa_passed", evidence: { authorityStatus: "passed", authorityMatches: true } },
    ])).toEqual(["character_qa_not_latest_authority"]);
    expect(characterReleaseProposalBlockers([
      { key: "visual_identity_exact_version", evidence: { immutableHash: null } },
      { key: "reference_set_published_snapshot", evidence: { unavailableReferenceMediaIds: ["a"] } },
    ])).toEqual([
      "active_visual_profile_missing_or_unsealed",
      "active_reference_set_media_unavailable",
    ]);
    // 提案侧本来就没有名字的闸原样透出 check key。
    expect(characterReleaseProposalBlockers([
      { key: "soul_behavior_evaluation", evidence: {} },
      { key: "snapshot_hash_matches", evidence: {} },
    ])).toEqual(["soul_behavior_evaluation", "snapshot_hash_matches"]);
  });
});
