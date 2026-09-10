import { recoveredGenerationFixture } from "@/server/test/recovered-generation-fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { canonicalSha256 } from "../shared/canonical-json";
import { CHARACTER_RELEASE_POLICY_VERSION, evaluateCharacterReleaseSnapshot, type CharacterReleaseSnapshotCandidate } from "./release-validation";
import { characterReleaseSnapshotHash, characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";
import { createCharacterSoulVersion } from "./soul-version";

const P = "zt-release-history-";

beforeAll(() => purgeTestData(P));
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });

// These candidates isolate image authority. Soul/revision validation is covered
// separately; no persisted Release or live Serving is needed to judge images.
async function imageCandidate(suffix: string, attemptVersion = 1, bootstrapIdentity = false) {
  const id = `${P}${suffix}`;
  const ownerId = `${id}-owner`;
  await createUser({ id: ownerId });
  await createCharacter({ id, creatorId: ownerId, visibility: "private" });
  const project = await prisma.characterProject.create({ data: { characterId: id } });
  const anchor = await prisma.mediaAsset.create({ data: {
    id: `${id}-anchor`, ownerId, characterId: id, type: "image", safetyStatus: "passed",
    url: `/user-content/${id}-anchor.webp`, storageKey: `${id}/anchor.webp`, metadata: { synthetic: false },
  } });
  const bootstrapJobId = `${id}-character_cover-job`;
  const visual = {
    characterId: id, version: 3, status: "active", style: "realistic", identityPrompt: "Stable adult portrait identity",
    faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {},
    negativeIdentityPrompt: null, anchorAssetIds: [anchor.id],
    adapterRefs: bootstrapIdentity ? { bootstrapIdentity: true, generationJobId: bootstrapJobId } : {},
    createdFrom: bootstrapIdentity ? `identity_bootstrap:${bootstrapJobId}` : "test",
    evidenceState: bootstrapIdentity ? "reviewed_bootstrap" : "qualified",
  };
  const profile = await prisma.characterVisualProfile.create({ data: { ...visual, immutableHash: characterVisualProfileSnapshotHash(visual) } });
  const referenceHash = referenceSetSnapshotHash({
    visualProfileId: profile.id, revision: 1, selectorVersion: "v1",
    references: [{ mediaAssetId: anchor.id, position: 0, role: "identity_anchor", weight: 1 }],
  });
  const referenceSet = await prisma.referenceSetRevision.create({ data: {
    visualProfileId: profile.id, revision: 1, status: "active",
    createdFrom: bootstrapIdentity ? `identity_bootstrap:${bootstrapJobId}` : "test", snapshotHash: referenceHash,
    references: { create: { mediaAssetId: anchor.id, position: 0, role: "identity_anchor", selectionReason: "Test identity", weight: 1 } },
  } });
  const workflowKey = "redcraft-krea2-identity-edit";
  const workflowVersion = (await generationWorkflowDescriptor(workflowKey))!.version;
  const currentProfileKey = `${id}-current-route`;
  await prisma.generationModelProfile.create({ data: {
    profileKey: currentProfileKey, label: "Current route", mode: "image", runner: "comfyui", pipelineModel: workflowKey,
    workflowKey, runnerConfig: { capabilities: { referenceImages: true, initImage: true } },
    allowedOrientations: ["4:5"], version: 5, status: "active", enabled: true, rolloutPercent: 100,
  } });
  const route = await prisma.generationRouteQualification.create({ data: {
    routeFingerprint: `${id}-route`, generationProfileKey: currentProfileKey, generationProfileVersion: 5,
    workflowKey, workflowVersion, style: "realistic", matrixKey: "operator-single-image-v1",
    sampleCount: 1, passCount: 1, identityMatch: 1, result: "qualified",
    evidence: { authorityMode: "operator_single_image", evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
    policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
  } });
  const placements = [];
  const provenance = [];
  for (const [slotKey, purpose] of [
    ["character_avatar", "character_cover"], ["character_hero", "character_hero"], ["character_chat", "character_chat"],
  ]) {
    const batch = await prisma.contentProductionBatch.create({ data: {
      title: `${id}-${purpose}`, purpose: purpose!, targetType: "character", targetId: id, createdById: ownerId, presetIds: [],
    } });
    const itemId = `${id}-${purpose}-item`;
    const establishesIdentity = bootstrapIdentity && purpose === "character_cover";
    const manifest = establishesIdentity ? [] : [{ mediaAssetId: anchor.id, referenceSetRevisionId: referenceSet.id, snapshotHash: referenceHash, role: "identity_anchor" }];
    const job = await prisma.generationJob.create({ data: {
      id: `${id}-${purpose}-job`, userId: ownerId, characterId: id, mode: "image", provider: "comfyui", profileId: `${id}-historical-qwen`, profileVersion: 1,
      model: "qwen-image-edit-img2img", controls: {}, presetIds: [], status: "completed", deliveredOutputCount: 1,
      visualProfileId: establishesIdentity ? null : profile.id,
      visualProfileVersion: establishesIdentity ? null : profile.version,
      referenceSetRevisionId: establishesIdentity ? null : referenceSet.id,
      referenceAssetIds: establishesIdentity ? [] : [anchor.id], referenceManifest: manifest, sourceType: "content_production_item", sourceId: itemId,
      sourceMeta: { batchId: batch.id, purpose, targetType: "character", targetId: id, bootstrapIdentity: establishesIdentity, referenceSetRevisionId: establishesIdentity ? null : referenceSet.id },
      completedAt: new Date(),
    } });
    const asset = establishesIdentity ? await prisma.mediaAsset.update({
      where: { id: anchor.id }, data: { sourceJobId: job.id, metadata: { synthetic: false, provider: "comfyui" } },
    }) : await prisma.mediaAsset.create({ data: {
      id: `${id}-${purpose}-asset`, ownerId, characterId: id, type: "image", sourceJobId: job.id, safetyStatus: "passed",
      url: `/user-content/${id}-${purpose}.webp`, storageKey: `${id}/${purpose}.webp`, metadata: { synthetic: false, provider: "comfyui" },
    } });
    const item = await prisma.contentProductionItem.create({ data: { id: itemId, batchId: batch.id, jobId: job.id, mediaAssetId: asset.id, tags: [], status: "approved" } });
    const attempt = await prisma.$transaction(async (tx) => {
      const running = await tx.generationAttempt.create({ data: {
        requestId: job.id, attemptNo: 1, provider: "comfyui", profileKey: job.profileId, profileVersion: attemptVersion,
        workflowKey: job.model, workflowVersion: 1, status: "running",
        events: { create: {
          id: `${id}-${purpose}-terminal`, sequence: 1, eventType: "generation.attempt.succeeded.v1", outcome: "succeeded",
          terminalScope: "terminal", occurredAt: new Date(), payload: {}, payloadHash: canonicalSha256({}),
        } },
      } });
      return tx.generationAttempt.update({ where: { id: running.id }, data: { status: "succeeded", finishedAt: new Date(), terminalSequence: 1 } });
    });
    const review = await prisma.creativeReviewDecision.create({ data: {
      runItemId: item.id, artifactId: asset.id, decision: "approved", identityConsistency: "passed", score: 98,
      reason: "Approved stable identity", reviewerId: ownerId,
      evidence: { artifactFree: true, singleSubject: true, intentMatch: true, noVisibleText: true },
    } });
    placements.push({ slotKey: slotKey!, assetId: asset.id, slotVersion: 1, runId: batch.id, itemId: item.id, generationJobId: job.id, reviewDecisionId: review.id, bootstrapIdentity: establishesIdentity });
    provenance.push({
      slotKey: slotKey!, assetId: asset.id, generationJobId: job.id, bootstrapIdentity: establishesIdentity, provider: job.provider,
      attemptId: attempt.id, attemptNo: attempt.attemptNo, generationProfileKey: job.profileId, generationProfileVersion: job.profileVersion,
      workflowKey: job.model, workflowVersion: 1, visualProfileId: job.visualProfileId, visualProfileVersion: job.visualProfileVersion,
      referenceSetRevisionId: job.referenceSetRevisionId, referenceManifestHash: canonicalSha256(manifest),
    });
  }
  const snapshot = {
    projectId: project.id, revisionId: null, characterContentVersionId: null, visualProfileId: profile.id,
    visualProfileVersion: profile.version, referenceSetRevisionId: referenceSet.id,
    generationProvenance: { schemaVersion: "character-release-generation-provenance-v2", policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      requiredReleaseRoute: { routeFingerprint: route.routeFingerprint, matrixKey: route.matrixKey, generationProfileKey: currentProfileKey, generationProfileVersion: 5, workflowKey, workflowVersion }, placements: provenance },
    releasePlacementManifest: { schemaVersion: 2, placements },
  };
  return { ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot), legacy: false, rollbackOfReleaseId: null } satisfies CharacterReleaseSnapshotCandidate;
}

function evaluate(candidate: CharacterReleaseSnapshotCandidate) {
  return prisma.$transaction((tx) => evaluateCharacterReleaseSnapshot(tx, candidate, CHARACTER_RELEASE_POLICY_VERSION, new Date()));
}

function candidateSnapshotHash(candidate: CharacterReleaseSnapshotCandidate) {
  // Hash only the immutable snapshot payload, never its existing hash or
  // Release lifecycle flags, matching the actual proposal/validation contract.
  return characterReleaseSnapshotHash({
    projectId: candidate.projectId, revisionId: candidate.revisionId,
    characterContentVersionId: candidate.characterContentVersionId,
    visualProfileId: candidate.visualProfileId, visualProfileVersion: candidate.visualProfileVersion,
    referenceSetRevisionId: candidate.referenceSetRevisionId,
    generationProvenance: candidate.generationProvenance,
    releasePlacementManifest: candidate.releasePlacementManifest,
  });
}

describe("Release historical image authority", () => {
  it.each([false, true])("validates placements chosen after generation while retaining exact origins (bootstrap: %s)", async (bootstrap) => {
    const candidate = await imageCandidate(`cross-placement-${bootstrap}`, 1, bootstrap);
    const placementSlots = ["character_hero", "character_chat", "character_avatar"];
    candidate.releasePlacementManifest.placements.forEach((placement, index) => {
      placement.slotKey = placementSlots[index]!;
    });
    candidate.generationProvenance.placements.forEach((placement, index) => {
      placement.slotKey = placementSlots[index]!;
    });
    candidate.snapshotHash = candidateSnapshotHash(candidate);

    const result = await evaluate(candidate);
    for (const key of ["release_avatar_manifest_available", "release_asset_manifest_available", "release_assets_customer_publishable", "release_asset_source_authority", "release_asset_generation_authority", "snapshot_hash_matches"]) {
      expect(result.checks.find((check) => check.key === key), key).toMatchObject({ passed: true });
    }
  });

  it("rejects a generated image whose Job purpose no longer matches its actual Run", async () => {
    const candidate = await imageCandidate("purpose-tamper");
    const placement = candidate.releasePlacementManifest.placements[0]!;
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: placement.generationJobId } });
    await prisma.generationJob.update({ where: { id: job.id }, data: {
      sourceMeta: {
        batchId: placement.runId, purpose: "character_hero", targetType: "character", targetId: job.characterId,
        bootstrapIdentity: false, referenceSetRevisionId: job.referenceSetRevisionId,
      },
    } });
    const result = await evaluate(candidate);
    expect(result.checks.find((check) => check.key === "release_asset_generation_authority")).toMatchObject({ passed: false });
  });

  it("rejects a manifest Run substituted independently of the generated image", async () => {
    const candidate = await imageCandidate("run-tamper");
    candidate.releasePlacementManifest.placements[0]!.runId = candidate.releasePlacementManifest.placements[1]!.runId;
    candidate.snapshotHash = candidateSnapshotHash(candidate);
    const result = await evaluate(candidate);
    expect(result.checks.find((check) => check.key === "release_asset_generation_authority")).toMatchObject({ passed: false });
  });

  it("keeps reviewed images valid after the production route moves from Qwen to RedCraft", async () => {
    const result = await evaluate(await imageCandidate("route-upgrade"));
    for (const key of ["generation_route_qualified", "visual_identity_exact_version", "reference_set_published_snapshot", "release_asset_manifest_available", "release_assets_customer_publishable", "release_asset_source_authority", "release_asset_generation_authority"]) {
      expect(result.checks.find((check) => check.key === key), key).toMatchObject({ passed: true });
    }
  });

  it("accepts the exact adopted unknown Artifact and rejects a changed resolution Receipt", async () => {
    const candidate = await imageCandidate("recovered-output");
    const placement = candidate.generationProvenance.placements[1]!;
    const rollback = new Error("recovered release fixture rollback");
    await expect(prisma.$transaction(async (tx) => {
      const recovered = await recoveredGenerationFixture(tx, placement.assetId as string, `${P}recovered-output-owner`);
      placement.attemptId = recovered.attempt.id;
      placement.attemptNo = recovered.attempt.attemptNo;
      const evaluateRecovered = () => evaluateCharacterReleaseSnapshot(tx, candidate, CHARACTER_RELEASE_POLICY_VERSION, new Date());
      const valid = await evaluateRecovered();
      for (const key of ["release_assets_customer_publishable", "release_asset_source_authority", "release_asset_generation_authority"]) {
        expect(valid.checks.find((check) => check.key === key), key).toMatchObject({ passed: true });
      }
      await tx.inboundEventReceipt.update({ where: { id: recovered.receipt.id }, data: { payloadHash: "0".repeat(64) } });
      const invalid = await evaluateRecovered();
      expect(invalid.checks.find((check) => check.key === "release_assets_customer_publishable")).toMatchObject({ passed: false });
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("rejects disagreement between a historical Job and its successful Attempt", async () => {
    const result = await evaluate(await imageCandidate("attempt-tamper", 2));
    expect(result.checks.find((check) => check.key === "release_asset_generation_authority")).toMatchObject({ passed: false });
  });

  it("rejects a tampered immutable provenance pin even after the route upgrade", async () => {
    const candidate = await imageCandidate("pin-tamper");
    candidate.generationProvenance.placements[0]!.workflowVersion = 99;
    const result = await evaluate(candidate);
    expect(result.checks.find((check) => check.key === "release_asset_generation_authority")).toMatchObject({ passed: false });
  });

  it("rejects images pinned to a different Character visual identity version", async () => {
    const candidate = await imageCandidate("identity-change");
    const result = await evaluate({ ...candidate, visualProfileVersion: candidate.visualProfileVersion + 1 });
    expect(result.checks.find((check) => check.key === "release_asset_generation_authority")).toMatchObject({ passed: false });
  });

  it("retains image authority for a new Soul version while requiring its actual immutable revision", async () => {
    const candidate = await imageCandidate("soul-only");
    const characterId = `${P}soul-only`;
    const content = await prisma.characterContentVersion.create({ data: {
      characterId, version: 1, contentHash: `${characterId}-legacy`,
      personaSnapshot: { name: "Mara", age: 28, gender: "female", personality: "Measured and observant." },
      openingSnapshot: { firstMessage: "Old opening." }, appearanceSnapshot: { style: "realistic", structured: {} }, sourceType: "test",
    } });
    const oldRevision = await prisma.characterRevision.create({ data: {
      projectId: candidate.projectId, revision: 1, characterContentVersionId: content.id, projectSnapshot: {},
    } });
    const updated = await createCharacterSoulVersion({
      characterId, expectedProjectVersion: 1, expectedContentVersionId: content.id,
      actor: { id: `${characterId}-owner`, role: "admin" }, reason: "Update opening only", requestId: `${characterId}-soul`,
      persona: { name: "Mara", age: 28, gender: "female", characterPromise: "A precise place to put the day down.",
        detailsMarkdown: "Measured, observant, and gently challenging. Warm and concise. A former night-shift radio host.",
        firstMessage: "What followed you home tonight?" },
    });
    const currentRevision = await prisma.characterRevision.findFirstOrThrow({ where: { projectId: candidate.projectId, revision: updated.revision } });
    const currentCandidate = { ...candidate, revisionId: currentRevision.id, characterContentVersionId: currentRevision.characterContentVersionId };
    currentCandidate.snapshotHash = characterReleaseSnapshotHash({
      projectId: currentCandidate.projectId, revisionId: currentCandidate.revisionId,
      characterContentVersionId: currentCandidate.characterContentVersionId, visualProfileId: currentCandidate.visualProfileId,
      visualProfileVersion: currentCandidate.visualProfileVersion, referenceSetRevisionId: currentCandidate.referenceSetRevisionId,
      generationProvenance: currentCandidate.generationProvenance, releasePlacementManifest: currentCandidate.releasePlacementManifest,
    });
    const result = await evaluate(currentCandidate);
    for (const key of ["release_asset_generation_authority", "revision_is_immutable_and_pinned", "soul_snapshot_valid", "soul_release_policy", "snapshot_hash_matches"]) {
      expect(result.checks.find((check) => check.key === key), key).toMatchObject({ passed: true });
    }
    const tampered = await evaluate({ ...currentCandidate, revisionId: oldRevision.id });
    expect(tampered.checks.find((check) => check.key === "revision_is_immutable_and_pinned")).toMatchObject({ passed: false });
  });
});
