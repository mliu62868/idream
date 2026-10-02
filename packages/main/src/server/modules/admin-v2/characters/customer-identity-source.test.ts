import { describe, expect, it } from "vitest";
import { resolveCustomerIdentitySource } from "./customer-identity-source";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";

// This adapter drives the real receipt and media/Attempt validators without a
// database. The published -> paused -> resume executor remains an integration test.
function fixture() {
  const character = { id: "customer-character", source: "user", creatorId: "creator", creator: { dataClass: "customer" },
    status: "approved", visibility: "public", deletedAt: null as Date | null, imageAssetId: "preview-asset" };
  const content = { id: "content", characterId: character.id, contentHash: "content-hash", sourceId: "draft" };
  const submission = { id: "submission", characterId: character.id, submitterId: "creator", status: "approved" };
  const job = { id: "preview-job", userId: "creator", sourceType: "character_preview", sourceId: "preview", status: "completed",
    mode: "image", deliveredOutputCount: 1, completedAt: new Date("2026-10-02T01:01:34.199Z"), characterId: null,
    visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, referenceManifest: null, referenceAssetIds: null,
    provider: "comfyui", model: "redqw21", profileId: "profile_image_default_v1", profileVersion: 6,
    sourceMeta: { draftId: "draft", previewJobId: "preview" } };
  const asset = { id: "preview-asset", ownerId: "creator", characterId: character.id, type: "image", sourceJobId: job.id,
    deletedAt: null as Date | null, safetyStatus: "passed", storageKey: "gen/preview-job/attempts/attempt/image-1.png",
    metadata: { synthetic: false, provider: "comfyui", platformAsset: { status: "draft" } } };
  const attempt = { id: "attempt", requestId: job.id, attemptNo: 1, status: "succeeded", provider: "comfyui",
    profileKey: job.profileId, profileVersion: 6, workflowKey: "redqw21", workflowVersion: 3 };
  const artifact = { id: "artifact", attemptId: attempt.id, assetId: asset.id, validationState: "valid", archiveState: "active" };
  const delivery = { id: "delivery", artifactId: artifact.id, requestId: job.id, targetId: "creator", targetType: "user_library",
    status: "delivered", deliveredAt: new Date() };
  const preview = { id: "preview", draftId: "draft", status: "completed", resultAssetId: asset.id,
    draft: { ownerId: "creator", previewJobId: "preview", editsCharacterId: null, advancedDetails: { submittedCharacterId: character.id } } };
  const profile = { id: "visual", characterId: character.id, version: 1, status: "active", style: "realistic", identityPrompt: "Avery",
    negativeIdentityPrompt: null, faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, immutableHash: "" };
  profile.immutableHash = characterVisualProfileSnapshotHash(profile);
  const referenceSet = { id: "references", visualProfileId: profile.id, revision: 1, status: "active", selectorVersion: "selected-v1",
    snapshotHash: "", references: [{ mediaAssetId: asset.id, position: 0, role: "primary_face", weight: 1 }] };
  referenceSet.snapshotHash = referenceSetSnapshotHash(referenceSet);
  const receipt = { schemaVersion: "customer-selected-preview-v1", characterId: character.id, creatorId: "creator",
    submissionId: submission.id, contentVersionId: content.id, contentHash: content.contentHash, assetId: asset.id,
    draftId: "draft", previewJobId: preview.id, artifactId: artifact.id, deliveryId: delivery.id,
    visualProfileId: profile.id, visualProfileVersion: 1, visualProfileHash: profile.immutableHash,
    referenceSetRevisionId: referenceSet.id, referenceSetHash: referenceSet.snapshotHash,
    generation: { generationJobId: job.id, jobCharacterId: null, provider: "comfyui", generationProfileKey: job.profileId,
      generationProfileVersion: 6, workflowKey: "redqw21", workflowVersion: 3, attemptId: attempt.id, attemptNo: 1,
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, referenceAssetIds: null,
      referenceManifestHash: null, deliveredOutputCount: 1, completedAt: job.completedAt.toISOString() } };
  const project = { id: "project", characterId: character.id };
  const revision = { id: "receipt-revision", projectId: project.id, characterContentVersionId: content.id, projectSnapshot: { customerIdentity: receipt } };
  const identityPlacement = { slotKey: "character_avatar", assetId: asset.id, slotVersion: 1,
    generationJobId: job.id, customerIdentityRevisionId: revision.id };
  const release = { id: "published-release", projectId: project.id, project, status: "published", publishedAt: new Date() as Date | null,
    characterContentVersionId: content.id, visualProfileId: profile.id, visualProfileVersion: 1, referenceSetRevisionId: referenceSet.id,
    releasePlacementManifest: { schemaVersion: 2, placements: [
      identityPlacement,
      { slotKey: "character_hero", assetId: "hero", slotVersion: 1 },
      { slotKey: "character_chat", assetId: "chat", slotVersion: 1 },
    ] } };
  const serving = { state: "paused", currentReleaseId: release.id, currentRelease: release };
  const db = {
    character: { findUnique: async () => character },
    characterSubmission: { findFirst: async () => submission.status === "approved" ? submission : null },
    characterContentVersion: { findFirst: async () => content },
    characterProject: { findFirst: async () => project },
    characterRevision: { findMany: async () => [revision] },
    characterVisualProfile: { findFirst: async () => profile },
    referenceSetRevision: { findFirst: async () => referenceSet },
    mediaAsset: { findUnique: async () => asset },
    generationJob: { findUnique: async () => job, findMany: async () => [job] },
    characterPreviewJob: { findUnique: async () => preview },
    generationAttempt: { findUnique: async () => attempt, findMany: async () => [attempt] },
    generationArtifact: { findMany: async () => [artifact] },
    generationDelivery: { findFirst: async () => delivery.status === "delivered" ? delivery : null },
    characterServing: { findUnique: async () => serving },
  } as unknown as Parameters<typeof resolveCustomerIdentitySource>[0];
  const input = { characterId: character.id, revisionId: revision.id, visualProfileId: profile.id,
    referenceSetRevisionId: referenceSet.id, releaseId: release.id };
  return { db, input, character, content, submission, asset, job, attempt, delivery, profile, referenceSet, receipt, identityPlacement, release, serving };
}

describe("customer identity receipt for a paused published Release", () => {
  it("keeps the exact immutable source valid after the normal archived pause projection", async () => {
    const f = fixture();
    expect(await resolveCustomerIdentitySource(f.db, f.input)).not.toBeNull();
    f.character.status = "archived";
    expect(await resolveCustomerIdentitySource(f.db, f.input)).toMatchObject({ revisionId: "receipt-revision", job: { characterId: null }, receipt: f.receipt });
    expect(f.character.status).toBe("archived");
    expect(f.serving.state).toBe("paused");
  });

  it.each([
    "different-release", "different-pointer", "not-paused", "not-published", "missing-published-time", "wrong-project",
    "changed-content", "wrong-visual", "wrong-visual-version", "wrong-reference", "wrong-placement", "wrong-receipt-pin", "wrong-job-pin", "private", "rejected-submission",
    "deleted-asset", "archived-asset", "mock-job", "missing-delivery", "wrong-attempt", "changed-receipt",
  ])("still rejects %s while paused", async (drift) => {
    const f = fixture(); f.character.status = "archived";
    if (drift === "different-release") f.input.releaseId = "another-release";
    if (drift === "different-pointer") f.serving.currentReleaseId = "another-release";
    if (drift === "not-paused") f.serving.state = "retired";
    if (drift === "not-published") f.release.status = "withdrawn";
    if (drift === "missing-published-time") f.release.publishedAt = null;
    if (drift === "wrong-project") f.release.projectId = "another-project";
    if (drift === "changed-content") f.content.contentHash = "changed-content";
    if (drift === "wrong-visual") f.release.visualProfileId = "another-visual";
    if (drift === "wrong-visual-version") f.release.visualProfileVersion = 2;
    if (drift === "wrong-reference") f.release.referenceSetRevisionId = "another-reference";
    if (drift === "wrong-placement") f.identityPlacement.assetId = "another-asset";
    if (drift === "wrong-receipt-pin") f.identityPlacement.customerIdentityRevisionId = "another-receipt";
    if (drift === "wrong-job-pin") f.identityPlacement.generationJobId = "another-job";
    if (drift === "private") f.character.visibility = "private";
    if (drift === "rejected-submission") f.submission.status = "rejected";
    if (drift === "deleted-asset") f.asset.deletedAt = new Date();
    if (drift === "archived-asset") f.asset.metadata.platformAsset.status = "archived";
    if (drift === "mock-job") f.job.provider = "mock";
    if (drift === "missing-delivery") f.delivery.status = "failed";
    if (drift === "wrong-attempt") f.attempt.workflowVersion = 4;
    if (drift === "changed-receipt") f.receipt.generation.attemptId = "another-attempt";
    expect(await resolveCustomerIdentitySource(f.db, f.input)).toBeNull();
  });

  it("retains the sealed identity for a published text-only content revision", async () => {
    const f = fixture(); f.character.status = "archived";
    f.release.characterContentVersionId = "newer-text-content";
    expect(await resolveCustomerIdentitySource(f.db, f.input)).toMatchObject({ receipt: f.receipt });
  });

  it("does not admit an archived source without the exact published Release context", async () => {
    const f = fixture(); f.character.status = "archived";
    const { releaseId: _releaseId, ...input } = f.input;
    expect(await resolveCustomerIdentitySource(f.db, input)).toBeNull();
  });
});
