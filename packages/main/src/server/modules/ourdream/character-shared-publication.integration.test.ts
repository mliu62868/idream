import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectOk, purgeTestData } from "@/server/test/helpers";
import { getCharacterWorkspace } from "../admin-v2/characters/workspace";
import { prepareApprovedCustomerCharacterPublication } from "../admin-v2/characters/publication-prep";
import { characterPreviewPrompt } from "./character-draft-write";
import { listCharacterImageSources } from "../admin-v2/characters/image-sources";
import { selectCharacterDraftImage } from "../admin-v2/characters/asset-studio";
import { resolveCustomerIdentitySource } from "../admin-v2/characters/customer-identity-source";
import { createCharacterRelease } from "../admin-v2/characters/release-lifecycle";
import { CHARACTER_RELEASE_POLICY_VERSION, evaluateCharacterReleaseSnapshot } from "../admin-v2/characters/release-validation";
import { executeCharacterReleaseCommand } from "../admin-v2/characters/release-executor";
import { acceptControlPlaneCommand } from "../admin-v2/shared/control-plane-command";
import { ensureOperationalGenerationRoute } from "../admin-v2/characters/visual-authority";
import { env } from "@/server/lib/env";
import { recoveredGenerationFixture } from "@/server/test/recovered-generation-fixture";
import { characterImageQualifications } from "../admin-v2/characters/image-qualification";
import { toInputJson } from "../admin-v2/shared/prisma-json";

const prefix = `zt-shared-create-${randomUUID()}-`;
afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function submit(suffix: string, visibility: "public" | "unlisted" | "private", recovered = false) {
  const userId = `${prefix}${suffix}`;
  await createUser({ id: userId, dataClass: "customer" });
  const created = await api("POST", "character-drafts", {
    userId, ageGate: true, body: { name: `Avery ${suffix}`, age: 25, gender: "female", style: "realistic" },
  });
  expectOk(created);
  const draftId = created.data.draft.id as string;
  expectOk(await api("PATCH", `character-drafts/${draftId}`, {
    userId, ageGate: true,
    body: { expectedUpdatedAt: (await prisma.characterDraft.findUniqueOrThrow({ where: { id: draftId } })).updatedAt.toISOString(), age: 25, advancedDetails: { description: "A warm radio host", firstMessage: "Welcome back." } },
  }));
  const draft = await prisma.characterDraft.findUniqueOrThrow({ where: { id: draftId } });
  const asset = await prisma.mediaAsset.create({ data: {
    ownerId: userId, type: "image", url: `/user-content/${userId}.png`, storageKey: `${userId}.png`,
    visibility: "private", safetyStatus: "passed", metadata: { synthetic: false, provider: "comfyui", source: "character_preview" },
  } });
  const preview = await prisma.characterPreviewJob.create({ data: {
    draftId, status: "completed", resultAssetId: asset.id, completedAt: new Date(),
  } });
  const recipe = await prisma.generationRecipe.create({ data: {
    id: `${userId}-recipe`, recipeKey: `${userId}-recipe`, label: "Identity", body: "Identity portrait",
    presetOrder: [], safetyHints: {}, sampleMatrix: [],
  } });
  const job = await prisma.generationJob.create({ data: {
    userId, mode: "image", controls: {}, presetIds: [], sourceType: "character_preview", sourceId: preview.id,
    recipeId: recipe.recipeKey, recipeVersion: recipe.version,
    prompt: characterPreviewPrompt(draft),
    sourceMeta: { draftId, previewJobId: preview.id }, provider: "comfyui", model: "redqw21",
    profileId: "profile_image_default_v1", profileVersion: 6, status: "completed", deliveredOutputCount: 1, completedAt: new Date(),
  } });
  const attempt = await prisma.generationAttempt.create({ data: {
    requestId: job.id, attemptNo: 1, provider: "comfyui", profileKey: job.profileId, profileVersion: job.profileVersion,
    workflowKey: job.model, workflowVersion: 3, status: "succeeded", finishedAt: new Date(),
  } });
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: {
    sourceJobId: job.id, storageKey: `gen/${job.id}/attempts/${attempt.id}/image-1.png`,
  } });
  const recovery = recovered ? await prisma.$transaction(tx => recoveredGenerationFixture(tx, asset.id, userId)) : null;
  if (!recovery) {
    const artifact = await prisma.generationArtifact.create({ data: {
      attemptId: attempt.id, ordinal: 0, terminalRecordChecksum: `${userId}-terminal`, validationState: "valid", assetId: asset.id,
    } });
    await prisma.generationDelivery.create({ data: {
      requestId: job.id, artifactId: artifact.id, targetType: "user_library", targetId: userId, status: "delivered", deliveredAt: new Date(),
    } });
  }
  expectOk(await api("POST", `character-drafts/${draftId}/preview-anchor`, {
    userId, ageGate: true, body: { previewJobId: preview.id },
  }));
  const result = await api("POST", `character-drafts/${draftId}/submit`, {
    userId, ageGate: true, body: { visibility },
  });
  expectOk(result);
  const characterId = result.data.character.id as string;
  const submission = await prisma.characterSubmission.findFirstOrThrow({ where: { characterId } });
  return { userId, draftId, characterId, submission, character: result.data.character, asset, job, attempt: recovery?.attempt ?? attempt, recovery };
}

describe("customer shared Character publication", () => {
  it("admits an adopted unknown Preview only while its exact recovery receipt remains valid", async () => {
    const fixture = await submit("recovered-preview", "public", true);
    const library = await listCharacterImageSources({ characterId: fixture.characterId, purpose: "character_library" });
    expect(library.items.map(item => item.id)).toEqual([fixture.asset.id]);
    const source = await resolveCustomerIdentitySource(prisma, { characterId: fixture.characterId });
    expect(source?.receipt.generation).toMatchObject({ attemptId: fixture.attempt.id, attemptNo: 2, jobCharacterId: null });
    expect(source?.attempt.status).toBe("unknown");
    await prisma.inboundEventReceipt.update({ where: { id: fixture.recovery!.receipt.id }, data: { payloadHash: "0".repeat(64) } });
    expect(await resolveCustomerIdentitySource(prisma, { characterId: fixture.characterId })).toBeNull();
    expect((await listCharacterImageSources({ characterId: fixture.characterId, purpose: "character_library" })).items).toEqual([]);
  });

  it("hands only the confirmed identity preview to the image library and preserves its real lineage on selection", async () => {
    const fixture = await submit("selected-source", "public");
    await prisma.mediaAsset.create({ data: {
      ownerId: fixture.userId, characterId: fixture.characterId, type: "image", visibility: "private", safetyStatus: "passed",
      storageKey: `${fixture.userId}/other.png`, url: "/other.png", metadata: { synthetic: false, provider: "comfyui" },
    } });
    const library = await listCharacterImageSources({ characterId: fixture.characterId, purpose: "character_library" });
    expect(library.items.map(item => item.id)).toEqual([fixture.asset.id]);
    expect(library.items[0]?.qualification).toMatchObject({ source: "generation", state: "selectable", authority: {
      runId: null, itemId: null, generationJobId: fixture.job.id,
    } });
    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: fixture.characterId } });
    await selectCharacterDraftImage({ characterId: fixture.characterId, assetId: fixture.asset.id, purpose: "character_cover",
      expectedProjectVersion: project.version, reason: "Use the creator's chosen identity", actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID() });
    const selected = await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(selected.draftAssetPack).toMatchObject({ character_cover: {
      assetId: fixture.asset.id, generationJobId: fixture.job.id, customerIdentityRevisionId: expect.any(String),
    } });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: fixture.job.id } })).toMatchObject({
      characterId: null, visualProfileId: null, referenceSetRevisionId: null, sourceType: "character_preview",
    });
    expect(await prisma.contentProductionItem.count({ where: { mediaAssetId: fixture.asset.id } })).toBe(0);
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).toMatchObject({ visibility: "private" });
    await expect(selectCharacterDraftImage({ characterId: fixture.characterId, assetId: fixture.asset.id, purpose: "character_hero",
      expectedProjectVersion: selected.version, reason: "Duplicate asset is never a second placement", actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  });

  it("recovers an existing empty Project by appending one immutable receipt without GET writes", async () => {
    const fixture = await submit("old-project", "private");
    await prisma.character.update({ where: { id: fixture.characterId }, data: { visibility: "public" } });
    const character = await prisma.character.findUniqueOrThrow({ where: { id: fixture.characterId } });
    const project = await prisma.characterProject.create({ data: { characterId: character.id } });
    const oldRevision = await prisma.characterRevision.create({ data: {
      projectId: project.id, revision: 1, characterContentVersionId: character.currentContentVersionId!,
      projectSnapshot: { source: "customer_submission", submissionId: fixture.submission.id },
    } });
    const candidate = await prisma.characterRelease.create({ data: {
      projectId: project.id, revisionId: oldRevision.id, characterContentVersionId: character.currentContentVersionId!,
      visualProfileId: "old-visual-profile", visualProfileVersion: 1, referenceSetRevisionId: "old-reference-set",
      generationProvenance: { schemaVersion: "character-release-generation-provenance-v2", policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        requiredReleaseRoute: { generationProfileKey: "old-profile", generationProfileVersion: 1, workflowKey: "redqw21", workflowVersion: 1 } },
      releasePlacementManifest: { schemaVersion: 2, placements: ["character_avatar", "character_hero", "character_chat"].map(slotKey => ({
        slotKey, assetId: `${fixture.userId}-old-${slotKey}`, slotVersion: 1,
      })) },
      snapshotHash: "legacy-candidate", status: "approved", readiness: "blocked",
    } });
    expect(await getCharacterWorkspace(character.id)).toMatchObject({ project: { id: project.id } });
    await expect(prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: character.id, submissionId: fixture.submission.id,
      actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID(),
    }))).rejects.toMatchObject({ status: 409 });
    expect(await prisma.characterRevision.count({ where: { projectId: project.id } })).toBe(1);
    const withdrawal = await acceptControlPlaneCommand(prisma, { environment: "test", actor: { id: fixture.userId, role: "admin" },
      idempotencyKey: randomUUID(), commandType: "character.release.withdraw", target: { type: "character_release", id: candidate.id },
      expectedVersion: candidate.version, payload: { reason: "Refresh legacy identity preparation" }, retryMode: "idempotent",
      reason: "Refresh legacy identity preparation", requestId: randomUUID(),
    });
    expect(await executeCharacterReleaseCommand(prisma, { commandId: withdrawal.commandId, workerId: fixture.userId })).toMatchObject({ status: "succeeded" });
    await expect(getCharacterWorkspace(character.id)).rejects.toMatchObject({ details: { reason: "customer_publication_prep_missing" } });
    expect(await prisma.characterRevision.count({ where: { projectId: project.id } })).toBe(1);
    const prepare = () => prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: character.id, submissionId: fixture.submission.id, actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID(),
    }));
    const recovered = await prepare();
    expect(recovered).toMatchObject({ projectId: project.id, created: true, projectVersion: 2 });
    expect(await prepare()).toMatchObject({ revisionId: recovered.revisionId, created: false, projectVersion: 2 });
    expect(await prisma.characterRevision.findUniqueOrThrow({ where: { id: oldRevision.id } })).toEqual(oldRevision);
    expect(await prisma.characterRevision.count({ where: { projectId: project.id } })).toBe(2);
    expect((await listCharacterImageSources({ characterId: character.id, purpose: "character_library" })).items.map(item => item.id)).toEqual([fixture.asset.id]);
  });

  it.each(["withdrawn", "deleted", "archived", "synthetic", "wrong-attempt", "wrong-owner", "wrong-character", "unselected", "wrong-submitted-character", "wrong-edit-character"])("rejects a formerly authorized preview after %s", async invalid => {
    const fixture = await submit(`invalid-${invalid}`, "public");
    const source = await resolveCustomerIdentitySource(prisma, { characterId: fixture.characterId });
    expect(source).not.toBeNull();
    if (invalid === "withdrawn") await prisma.character.update({ where: { id: fixture.characterId }, data: { visibility: "private" } });
    if (invalid === "deleted") await prisma.mediaAsset.update({ where: { id: fixture.asset.id }, data: { deletedAt: new Date() } });
    if (invalid === "archived" || invalid === "synthetic") await prisma.mediaAsset.update({ where: { id: fixture.asset.id }, data: {
      metadata: { provider: "comfyui", synthetic: invalid === "synthetic", ...(invalid === "archived" ? { platformAsset: { status: "archived" } } : {}) },
    } });
    if (invalid === "wrong-attempt") await prisma.generationAttempt.update({ where: { id: fixture.attempt.id }, data: { profileVersion: 7 } });
    if (invalid === "wrong-owner") {
      const other = `${fixture.userId}-other`; await createUser({ id: other });
      await prisma.mediaAsset.update({ where: { id: fixture.asset.id }, data: { ownerId: other } });
    }
    if (invalid === "wrong-character") await prisma.mediaAsset.update({ where: { id: fixture.asset.id }, data: { characterId: null } });
    if (invalid === "unselected") await prisma.characterDraft.update({ where: { id: fixture.draftId }, data: { previewJobId: null } });
    if (invalid === "wrong-submitted-character") await prisma.characterDraft.update({ where: { id: fixture.draftId }, data: {
      advancedDetails: { submittedCharacterId: "another-character" },
    } });
    if (invalid === "wrong-edit-character") {
      const other = await submit("edit-target-other", "private");
      await prisma.characterDraft.update({ where: { id: fixture.draftId }, data: { editsCharacterId: other.characterId } });
    }
    expect(await resolveCustomerIdentitySource(prisma, { characterId: fixture.characterId, revisionId: source!.revisionId })).toBeNull();
    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: fixture.characterId } });
    await expect(selectCharacterDraftImage({ characterId: fixture.characterId, assetId: fixture.asset.id, purpose: "character_cover",
      expectedProjectVersion: project.version, reason: "Invalid source must stay blocked", actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID() })).rejects.toMatchObject({ status: invalid === "wrong-character" ? 400 : 409 });
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } })).toEqual(project);
  });

  it.each([false, true])("publishes Preview (recovered=%s) alongside two distinct imports and rechecks consent at execution", async (recovered) => {
    const fixture = await submit(`release-preview-${recovered}`, "public", recovered);
    const actor = { id: fixture.userId, role: "admin" as const };
    await prisma.generationModelProfile.create({ data: {
      profileKey: `${fixture.userId}-route`, label: "Controlled identity route", mode: "image", runner: "comfyui",
      pipelineModel: "redcraft-krea2-identity-edit", workflowKey: "redcraft-krea2-identity-edit", runnerConfig: { capabilities: { referenceImages: true, initImage: true } },
      allowedOrientations: ["4:5"], version: 1, status: "active", enabled: true, rolloutPercent: 100, costMultiplier: 0.0001,
    } });
    await ensureOperationalGenerationRoute(prisma, { style: "realistic", policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION, at: new Date(), requiredReferenceCount: 1, requiredReferenceRoles: ["primary_face"] });
    const project = () => prisma.characterProject.findFirstOrThrow({ where: { characterId: fixture.characterId } });
    for (const purpose of ["character_cover", "character_hero", "character_chat"] as const) {
      const assetId = purpose === "character_cover" ? fixture.asset.id : `${fixture.userId}-${purpose}`;
      if (purpose !== "character_cover") await prisma.mediaAsset.create({ data: {
        id: assetId, ownerId: fixture.userId, characterId: fixture.characterId, type: "image", visibility: "private", safetyStatus: "passed",
        url: `/assets/${assetId}.png`, storageKey: `${assetId}.png`, metadata: {
          source: "admin_asset_upload", sha256: "a".repeat(64), platformAsset: { status: "draft", purpose: "character_library" },
          uploadAuthority: { schemaVersion: "platform-asset-operator-upload-v1", kind: "operator_upload", assetId, uploadedById: fixture.userId, sha256: "a".repeat(64) },
        },
      } });
      await selectCharacterDraftImage({ characterId: fixture.characterId, assetId, purpose, expectedProjectVersion: (await project()).version,
        actor, requestId: randomUUID(), reason: "Select three authorized distinct images" });
    }
    const candidate = await createCharacterRelease({ request: new Request("http://localhost"), characterId: fixture.characterId,
      expectedProjectVersion: (await project()).version, actor, reason: "Publish customer-selected identity" });
    expect(candidate).toMatchObject({ status: "approved", readiness: "ready" });
    expect(candidate.generationProvenance).toMatchObject({ placements: [expect.objectContaining({
      generationJobId: fixture.job.id, attemptId: fixture.attempt.id, jobCharacterId: null,
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, workflowVersion: 3,
      generationProfileVersion: 6, customerIdentityRevisionId: expect.any(String),
    })] });
    await prisma.$queryRaw`SELECT true FROM (SELECT assert_character_release_asset_manifest_v2(${JSON.stringify(candidate.releasePlacementManifest)}::jsonb)) AS checked`;
    const evaluate = () => prisma.$transaction(tx => evaluateCharacterReleaseSnapshot(tx, candidate, CHARACTER_RELEASE_POLICY_VERSION, new Date()));
    const shared = await evaluate(); expect(shared.failed).toEqual([]);
    await prisma.character.update({ where: { id: fixture.characterId }, data: { visibility: "private" } });
    expect((await evaluate()).failed.map(check => check.key)).toContain("release_asset_source_authority");
    const accepted = await acceptControlPlaneCommand(prisma, { environment: "test", actor, idempotencyKey: randomUUID(),
      commandType: "character.release.publish", target: { type: "character_release", id: candidate.id }, expectedVersion: candidate.version,
      payload: { reason: "Publish revoked sharing" }, retryMode: "idempotent", reason: "Publish revoked sharing", requestId: randomUUID() });
    expect(await executeCharacterReleaseCommand(prisma, { commandId: accepted.commandId, workerId: fixture.userId })).toMatchObject({ status: "failed" });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } })).toMatchObject({ state: "inactive", currentReleaseId: null });
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: fixture.asset.id } })).toMatchObject({ visibility: "private" });
    await prisma.character.update({ where: { id: fixture.characterId }, data: { visibility: "public" } });
    const approved = await prisma.characterRelease.findUniqueOrThrow({ where: { id: candidate.id } });
    const publish = await acceptControlPlaneCommand(prisma, { environment: "test", actor, idempotencyKey: randomUUID(),
      commandType: "character.release.publish", target: { type: "character_release", id: candidate.id }, expectedVersion: approved.version,
      payload: { reason: "Publish authorized identity" }, retryMode: "idempotent", reason: "Publish authorized identity", requestId: randomUUID() });
    expect(await executeCharacterReleaseCommand(prisma, { commandId: publish.commandId, workerId: fixture.userId })).toMatchObject({ status: "succeeded" });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } })).toMatchObject({ state: "live", currentReleaseId: candidate.id });
    const visible = await api("GET", `characters/${fixture.characterId}`, { ageGate: true });
    expectOk(visible);
    const changeServing = async (action: "pause" | "resume") => {
      const serving = await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } });
      const reason = `${action} the unchanged published customer identity`;
      const command = await acceptControlPlaneCommand(prisma, { environment: "test", actor, idempotencyKey: randomUUID(),
        commandType: `character.serving.${action}`, target: { type: "character_serving", id: fixture.characterId }, expectedVersion: serving.version,
        payload: { reason }, retryMode: "idempotent", reason, requestId: randomUUID() });
      return executeCharacterReleaseCommand(prisma, { commandId: command.commandId, workerId: fixture.userId });
    };
    {
      const source = await resolveCustomerIdentitySource(prisma, { characterId: fixture.characterId });
      const immutableReceipt = await prisma.characterRevision.findUniqueOrThrow({ where: { id: source!.revisionId } });
      const originalJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: fixture.job.id } });
      const published = await prisma.characterRelease.findUniqueOrThrow({ where: { id: candidate.id } });
      expect(await changeServing("pause")).toMatchObject({ status: "succeeded" });
      const paused = await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } });
      expect(paused).toMatchObject({ state: "paused", currentReleaseId: published.id });
      expect(await prisma.character.findUniqueOrThrow({ where: { id: fixture.characterId } })).toMatchObject({ status: "archived", visibility: "public" });
      await prisma.character.update({ where: { id: fixture.characterId }, data: { visibility: "private" } });
      expect(await changeServing("resume")).toMatchObject({ status: "failed", errorCode: "serving_resume_validation_failed" });
      expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } })).toEqual(paused);
      await prisma.character.update({ where: { id: fixture.characterId }, data: { visibility: "public" } });
      expect(await changeServing("resume")).toMatchObject({ status: "succeeded" });
      expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } })).toMatchObject({ state: "live", currentReleaseId: published.id });
      expect(await prisma.character.findUniqueOrThrow({ where: { id: fixture.characterId } })).toMatchObject({ status: "approved", visibility: "public" });
      expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: published.id } })).toMatchObject({
        snapshotHash: published.snapshotHash, releasePlacementManifest: published.releasePlacementManifest, generationProvenance: published.generationProvenance,
      });
      expect(await prisma.characterRevision.findUniqueOrThrow({ where: { id: source!.revisionId } })).toEqual(immutableReceipt);
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: fixture.job.id } })).toEqual(originalJob);
      const staleVersion = (await project()).version;
      const edit = await api("POST", `characters/${fixture.characterId}/edit-draft`, { userId: fixture.userId, ageGate: true });
      expectOk(edit);
      expectOk(await api("PATCH", `character-drafts/${edit.data.draft.id}`, { userId: fixture.userId, ageGate: true,
        body: { expectedUpdatedAt: edit.data.draft.updatedAt, name: "Avery evening host" },
      }));
      const submitted = await api("POST", `character-drafts/${edit.data.draft.id}/submit`, { userId: fixture.userId, ageGate: true, body: { visibility: "public" } });
      expectOk(submitted);
      expect(submitted.data.pendingPublication).toBe(true);
      await expect(createCharacterRelease({ request: new Request("http://localhost"), characterId: fixture.characterId,
        expectedProjectVersion: staleVersion, actor, reason: "Stale operator view must refresh" })).rejects.toMatchObject({ status: 409 });
      const afterEdit = await project();
      expect(afterEdit.version).toBe(staleVersion + 1);
      expectOk(await api("POST", `character-drafts/${edit.data.draft.id}/submit`, { userId: fixture.userId, ageGate: true, body: { visibility: "public" } }));
      expect((await project()).version).toBe(afterEdit.version);
      const next = await createCharacterRelease({ request: new Request("http://localhost"), characterId: fixture.characterId,
        expectedProjectVersion: (await project()).version, actor, reason: "Publish updated text with the same confirmed identity" });
      expect(next).toMatchObject({ status: "approved", readiness: "ready", visualProfileId: candidate.visualProfileId,
        referenceSetRevisionId: candidate.referenceSetRevisionId });
      expect(next.generationProvenance).toMatchObject({ placements: [expect.objectContaining({
        customerIdentityRevisionId: source!.revisionId, generationJobId: fixture.job.id, attemptId: fixture.attempt.id,
      })] });
      const nextPublish = await acceptControlPlaneCommand(prisma, { environment: "test", actor, idempotencyKey: randomUUID(),
        commandType: "character.release.publish", target: { type: "character_release", id: next.id }, expectedVersion: next.version,
        payload: { reason: "Publish text revision" }, retryMode: "idempotent", reason: "Publish text revision", requestId: randomUUID() });
      expect(await executeCharacterReleaseCommand(prisma, { commandId: nextPublish.commandId, workerId: fixture.userId })).toMatchObject({ status: "succeeded" });
      expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({ status: "superseded" });
      expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } })).toMatchObject({ state: "live", currentReleaseId: next.id });
      const publicDetail = await api("GET", `characters/${fixture.characterId}`, { ageGate: true });
      expectOk(publicDetail);
      expect(publicDetail.data.character.name).toBe("Avery evening host");
      expect(await prisma.characterRevision.findUniqueOrThrow({ where: { id: source!.revisionId } })).toEqual(immutableReceipt);
      expect(next.characterContentVersionId).not.toBe(immutableReceipt.characterContentVersionId);
      expect(await changeServing("pause")).toMatchObject({ status: "succeeded" });
      expect(await changeServing("resume")).toMatchObject({ status: "succeeded" });
      expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId: fixture.characterId } })).toMatchObject({ state: "live", currentReleaseId: next.id });
      expect(await prisma.characterRevision.findUniqueOrThrow({ where: { id: source!.revisionId } })).toEqual(immutableReceipt);
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: fixture.job.id } })).toEqual(originalJob);
    }
  });

  it("recovers a new visual version without rewriting the old receipt and rejects mixed Review or Bootstrap entries", async () => {
    const fixture = await submit("receipt-text-edit", "public");
    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: fixture.characterId } });
    await selectCharacterDraftImage({ characterId: fixture.characterId, assetId: fixture.asset.id, purpose: "character_cover",
      expectedProjectVersion: project.version, reason: "Use confirmed identity", actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID() });
    const selected = await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    const pack = selected.draftAssetPack as Record<string, Record<string, unknown>>;
    const selectedEntry = pack.character_cover!;
    const revisionId = selectedEntry.customerIdentityRevisionId as string;
    const revision = await prisma.characterRevision.findUniqueOrThrow({ where: { id: revisionId } });
    expectOk(await api("PATCH", `characters/${fixture.characterId}`, {
      userId: fixture.userId, ageGate: true, body: { description: "An experienced radio host who loves jazz." },
    }));
    expect(await prisma.characterRevision.findUniqueOrThrow({ where: { id: revisionId } })).toEqual(revision);
    // Pending text edits roll the Visual Profile and intentionally invalidate the
    // draft pack. Explicit preparation binds a new receipt; selection is renewed.
    expect((await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } })).draftAssetPack).toEqual({});
    await expect(getCharacterWorkspace(fixture.characterId)).rejects.toMatchObject({ details: { reason: "customer_publication_prep_missing" } });
    await prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: fixture.characterId, submissionId: fixture.submission.id,
      actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID(),
    }));
    const prepared = await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    expect((await listCharacterImageSources({ characterId: fixture.characterId, purpose: "character_library" })).items.map(item => item.id)).toEqual([fixture.asset.id]);
    await selectCharacterDraftImage({ characterId: fixture.characterId, assetId: fixture.asset.id, purpose: "character_cover",
      expectedProjectVersion: prepared.version, reason: "Confirm image for the updated identity", actor: { id: fixture.userId, role: "admin" }, requestId: randomUUID() });
    const renewed = (await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } })).draftAssetPack as Record<string, Record<string, unknown>>;
    expect(renewed.character_cover!.customerIdentityRevisionId).not.toBe(revisionId);
    expect(await prisma.characterRevision.findUniqueOrThrow({ where: { id: revisionId } })).toEqual(revision);
    const qualification = async () => (await characterImageQualifications(prisma, fixture.characterId, [
      await prisma.mediaAsset.findUniqueOrThrow({ where: { id: fixture.asset.id } }),
    ])).get(fixture.asset.id);
    expect(await qualification()).toMatchObject({ state: "release_qualified", releaseQualifiedPurposes: ["character_cover"] });
    for (const invalid of [{ reviewDecisionId: "unrelated-review" }, { bootstrapIdentity: true }]) {
      await prisma.characterProject.update({ where: { id: project.id }, data: {
        draftAssetPack: toInputJson({ ...renewed, character_cover: { ...renewed.character_cover, ...invalid } }),
      } });
      expect(await qualification()).toMatchObject({ state: "selected", releaseQualifiedPurposes: [] });
    }
  });

  it("returns the created Character and replays its receipt when optional creation telemetry fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_reject_character_created_telemetry()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'character_created' THEN
          RAISE EXCEPTION 'injected character telemetry failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_reject_character_created_telemetry
      BEFORE INSERT ON analytics_events
      FOR EACH ROW EXECUTE FUNCTION test_reject_character_created_telemetry()
    `);
    try {
      const result = await submit("telemetry-failure", "private");
      const replay = await api("POST", `character-drafts/${result.draftId}/submit`, {
        userId: result.userId, ageGate: true, body: { visibility: "private" },
      });
      expectOk(replay);
      expect(replay.data.character.id).toBe(result.characterId);
      const library = await api("GET", "library/created", { userId: result.userId, ageGate: true });
      expectOk(library);
      expect(library.data.items.filter((item: { id: string }) => item.id === result.characterId)).toHaveLength(1);
      expect(library.data.items).toContainEqual(expect.objectContaining({ id: result.characterId, visibility: "private" }));
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS test_reject_character_created_telemetry ON analytics_events");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_reject_character_created_telemetry()");
    }
  });

  it.each(["public", "unlisted"] as const)("routes %s Create directly to publication preparation after automatic checks", async (visibility) => {
    const result = await submit(visibility, visibility);
    expect(result.character).toMatchObject({ visibility, status: "approved" });
    expect(result.submission.status).toBe("approved");
    const replay = await api("POST", `character-drafts/${result.draftId}/submit`, {
      userId: result.userId, ageGate: true, body: { visibility },
    });
    expectOk(replay);
    expect(replay.data.character.id).toBe(result.characterId);
    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId } })).toBe(1);
    const pending = await api("GET", "library/created", { userId: result.userId, ageGate: true });
    expectOk(pending);
    expect(pending.data.items).toContainEqual(expect.objectContaining({
      id: result.characterId, publicationState: "awaiting_publication",
    }));

    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId, status: "pending" } })).toBe(0);
    expect(result.submission.reviewerId).toBeNull();
    expect(await getCharacterWorkspace(result.characterId)).toMatchObject({
      project: { characterId: result.characterId }, serving: { state: "inactive" }, releases: [],
    });
    const approved = await api("GET", "library/created", { userId: result.userId, ageGate: true });
    expectOk(approved);
    expect(approved.data.items).toContainEqual(expect.objectContaining({
      id: result.characterId, visibility, status: "approved", publicationState: "awaiting_publication",
    }));
    // Approval must not expose an unqualified Character to a visitor or the directory.
    expect((await api("GET", `characters/${result.characterId}`, { ageGate: true })).status).toBe(404);
    // The owner still opens it, but must not be handed a Share link that 404s for visitors.
    const ownerView = await api("GET", `characters/${result.characterId}`, { userId: result.userId, ageGate: true });
    expectOk(ownerView);
    expect(ownerView.data.character).toMatchObject({ publicationState: "awaiting_publication", shareable: false });
    const explore = await api("GET", "characters", { ageGate: true, query: { q: `Avery ${visibility}` } });
    expectOk(explore);
    expect(explore.data.items).toEqual([]);
  });

  it("keeps private Create owner-only and rejects publication preparation", async () => {
    const result = await submit("private", "private");
    expect(result.character).toMatchObject({ visibility: "private", status: "approved" });
    expect(result.submission.status).toBe("approved");
    expect(await prisma.characterProject.count({ where: { characterId: result.characterId } })).toBe(0);
    await expect(prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: result.characterId, submissionId: result.submission.id,
      actor: { id: result.userId, role: "admin" }, requestId: randomUUID(),
    }))).rejects.toMatchObject({ status: 409 });
  });

  it("offers the existing preparation recovery for an approved unlisted Character", async () => {
    const result = await submit("legacy-unlisted", "private");
    await prisma.character.update({ where: { id: result.characterId }, data: { visibility: "unlisted" } });
    await expect(getCharacterWorkspace(result.characterId)).rejects.toMatchObject({ details: {
      reason: "customer_publication_prep_missing", submissionId: result.submission.id,
    } });
    const moderatorId = `${prefix}recovery-admin`;
    await createUser({ id: moderatorId, role: "admin" });
    const prepared = await prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: result.characterId, submissionId: result.submission.id,
      actor: { id: moderatorId, role: "admin" }, requestId: randomUUID(),
    }));
    expect(prepared).toMatchObject({ state: "publication_prep", servingState: "inactive" });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: result.characterId } }))
      .toMatchObject({ visibility: "unlisted", status: "approved" });
  });

  it.each(["private", "public"] as const)("prepares publication without manual review when %s changes to unlisted", async (visibility) => {
    const result = await submit(`change-${visibility}`, visibility);
    const updated = await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "unlisted" },
    });
    expectOk(updated);
    expect(updated.data.character).toMatchObject({ visibility: "unlisted", status: "approved", publicationState: "awaiting_publication" });
    const pending = await prisma.characterSubmission.findMany({ where: { characterId: result.characterId, status: "pending" } });
    expect(pending).toHaveLength(0);
    expect(await prisma.characterServing.findUnique({ where: { characterId: result.characterId } })).toMatchObject({ state: "inactive", currentReleaseId: null });
  });
  it("keeps automatic text checks and report removals effective without manual review", async () => {
    const result = await submit("automatic-boundaries", "private");
    expect((await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { description: "underage minor" },
    })).status).toBe(403);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: result.characterId } }))
      .toMatchObject({ description: "A warm radio host", status: "approved" });
    await prisma.character.update({ where: { id: result.characterId }, data: { status: "removed" } });
    expect((await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "public" },
    })).status).toBe(403);
    expect(await prisma.characterProject.count({ where: { characterId: result.characterId } })).toBe(0);
  });

  it("does not create duplicate submissions when sharing preferences are replayed", async () => {
    const result = await submit("sharing-replay", "public");
    for (let i = 0; i < 2; i++) expectOk(await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "unlisted" },
    }));
    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId } })).toBe(1);
    expect(await prisma.characterProject.count({ where: { characterId: result.characterId } })).toBe(1);
  });

});
