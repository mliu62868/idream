import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";
import { proposeCharacterRelease, reviewCharacterRelease, validateCharacterRelease } from "./release-lifecycle";
import { changeCharacterServingState, publishCharacterRelease } from "../commands/authoritative";
import { CHARACTER_RELEASE_POLICY_VERSION, executeCharacterReleaseCommand } from "./release-executor";

describe("Character Release proposal and review lifecycle", () => {
  const suffix = randomUUID();
  const actorId = `release-lifecycle-admin-${suffix}`;
  const characterId = `release-lifecycle-character-${suffix}`;
  const assetId = `release-lifecycle-asset-${suffix}`;
  const profileId = `release-lifecycle-profile-${suffix}`;
  const referenceSetId = `release-lifecycle-reference-${suffix}`;
  const projectId = `release-lifecycle-project-${suffix}`;
  const contentId = `release-lifecycle-content-${suffix}`;
  const revisionId = `release-lifecycle-revision-${suffix}`;
  const routeFingerprint = `release-lifecycle-route-${suffix}`;
  const qaRunId = `release-lifecycle-qa-${suffix}`;
  const qaEvidenceHash = `release-lifecycle-qa-hash-${suffix}`;
  const headers = { "x-idream-user-id": actorId, "x-idream-role": "admin", "x-request-id": `release-lifecycle-${suffix}` };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" } });
    await prisma.mediaAsset.create({ data: { id: assetId, ownerId: actorId, type: "image", url: `https://assets.test/${assetId}.webp`, safetyStatus: "passed", metadata: {} } });
    await prisma.character.create({ data: { id: characterId, creatorId: actorId, name: "Release Candidate", age: 24, description: "Ready for release lifecycle", visibility: "private", status: "draft", appearance: {}, advancedDetails: {}, imageAssetId: assetId } });
    await prisma.characterServing.create({ data: { characterId, state: "inactive" } });
    const profile = await prisma.characterVisualProfile.create({ data: { id: profileId, characterId, version: 1, status: "active", style: "realistic", identityPrompt: "same adult character", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [assetId], referenceAssetIds: [assetId], adapterRefs: {}, createdFrom: "test" } });
    await prisma.characterVisualProfile.update({ where: { id: profile.id }, data: { immutableHash: characterVisualProfileSnapshotHash(profile) } });
    await prisma.referenceSetRevision.create({ data: { id: referenceSetId, visualProfileId: profileId, revision: 1, status: "active", selectorVersion: "v1", createdFrom: "test" } });
    await prisma.characterVisualReferenceSnapshot.create({ data: { referenceSetRevisionId: referenceSetId, mediaAssetId: assetId, position: 0, role: "primary_face", weight: 1, selectorVersion: "v1", selectionReason: "release lifecycle fixture" } });
    await prisma.referenceSetRevision.update({ where: { id: referenceSetId }, data: { snapshotHash: referenceSetSnapshotHash({ visualProfileId: profileId, revision: 1, selectorVersion: "v1", references: [{ mediaAssetId: assetId, position: 0, role: "primary_face", weight: 1 }] }) } });
    await prisma.generationRouteQualification.create({ data: { routeFingerprint, generationProfileKey: "portrait", generationProfileVersion: 1, workflowKey: "identity", workflowVersion: 1, style: "realistic", matrixKey: "realistic-avatar", sampleCount: 40, passCount: 40, identityMatch: 1, result: "qualified", evidence: {}, policyVersion: CHARACTER_RELEASE_POLICY_VERSION } });
    await prisma.characterContentVersion.create({ data: { id: contentId, characterId, version: 1, contentHash: `release-lifecycle-content-hash-${suffix}`, personaSnapshot: { name: "Released Candidate", age: 25, gender: "female", relationshipArchetype: "companion", characterPromise: "Complete persona", description: "Complete persona", systemPrompt: "Stay consistent" }, openingSnapshot: { firstMessage: "Hello" }, appearanceSnapshot: { style: "realistic" }, sourceType: "test", createdById: actorId } });
    await prisma.characterProject.create({ data: { id: projectId, characterId, ownerId: actorId, phase: "qa", audience: {}, successCriteria: ["five_turn_qa"], activeKey: `official:${characterId}` } });
    await prisma.characterRevision.create({ data: { id: revisionId, projectId, revision: 1, characterContentVersionId: contentId, projectSnapshot: {}, createdById: actorId } });
    await prisma.characterQaRun.create({ data: { id: qaRunId, characterId, projectId, characterContentVersionId: contentId, projectVersion: 1, ownerId: actorId, status: "passed", checks: [], evidenceHash: qaEvidenceHash } });
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
    await prisma.releaseCheckResult.deleteMany({ where: { validationRunId: { in: validations.map((row) => row.id) } } });
    await prisma.releaseValidationRun.deleteMany({ where: { id: { in: validations.map((row) => row.id) } } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: releases.map((row) => row.id) } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterQaRun.deleteMany({ where: { id: qaRunId } });
    await prisma.characterRevision.deleteMany({ where: { id: revisionId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { id: contentId } });
    await prisma.generationRouteQualification.deleteMany({ where: { routeFingerprint } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { referenceSetRevisionId: referenceSetId } });
    await prisma.referenceSetRevision.deleteMany({ where: { id: referenceSetId } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: profileId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
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
    const proposed = await proposeCharacterRelease({ request: proposalRequest(), characterId, expectedProjectVersion: 1, qaRunId, reason: "Five-turn QA and visual evidence passed" });
    expect(proposed).toMatchObject({ projectId, revisionId, characterContentVersionId: contentId, visualProfileId: profileId, referenceSetRevisionId: referenceSetId, status: "in_review", version: 1 });
    expect(proposed.snapshotHash).toHaveLength(64);
    const reviewRequest = new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/releases/${proposed.id}/review`,
      { method: "POST", headers },
    );
    const approved = await reviewCharacterRelease({ request: reviewRequest, characterId, releaseId: proposed.id, expectedVersion: proposed.version, decision: "approved", reason: "Independent reviewer approved immutable snapshot" });
    expect(approved).toMatchObject({ status: "approved", version: 2, snapshotHash: proposed.snapshotHash });
    await expect(prisma.adminAuditLog.count({ where: { actorId, targetId: proposed.id } })).resolves.toBe(2);
    const validationRequest = new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/releases/${proposed.id}/validation`,
      { method: "POST", headers },
    );
    const validation = await validateCharacterRelease({ request: validationRequest, characterId, releaseId: proposed.id, expectedVersion: approved.version });
    expect(validation).toMatchObject({ result: "passed", readiness: "ready", snapshotHash: proposed.snapshotHash, policyVersion: CHARACTER_RELEASE_POLICY_VERSION });
    const acceptPublish = async (tab: string) => publishCharacterRelease(new Request(`http://localhost/api/v2/admin/characters/${characterId}/releases/${proposed.id}/commands/publish`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `publish-${tab}-${suffix}` },
      body: JSON.stringify({ entityVersion: approved.version, reason: { code: "launch_approved", summary: "Publish the reviewed and validated snapshot" }, confirmation: `${characterId}:${proposed.id}:publish` }),
    }), characterId, proposed.id);
    const acceptedFromTabs = await Promise.all([acceptPublish("tab-a"), acceptPublish("tab-b")]);
    expect(acceptedFromTabs.map((response) => response.status)).toEqual([202, 202]);
    const publishCommandIds = await Promise.all(acceptedFromTabs.map(async (response) => (await response.json()).data.commandId as string));
    const publishOutcomes = await Promise.all(publishCommandIds.map((commandId, index) => executeCharacterReleaseCommand(prisma, {
      commandId,
      workerId: `release-lifecycle-worker-${index}-${suffix}`,
    })));
    expect(publishOutcomes.filter((outcome) => outcome.status === "succeeded")).toHaveLength(1);
    expect(publishOutcomes.filter((outcome) => outcome.status === "failed")).toHaveLength(1);
    await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({ state: "live", currentReleaseId: proposed.id, version: 2 });
    const retireRequest = new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/retire`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `retire-${suffix}` },
      body: JSON.stringify({ entityVersion: 2, reason: { code: "portfolio_retirement", summary: "Retire after explicit portfolio decision" }, confirmation: `${characterId}:retire` }),
    });
    const accepted = await changeCharacterServingState(retireRequest, characterId, "retire");
    const commandId = (await accepted.json()).data.commandId as string;
    await expect(prisma.controlPlaneCommand.findUnique({ where: { id: commandId } })).resolves.toMatchObject({
      commandType: "character.serving.retire",
    });
    await expect(executeCharacterReleaseCommand(prisma, { commandId, workerId: `release-lifecycle-worker-${suffix}` })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.characterProject.findUnique({ where: { id: projectId } })).resolves.toMatchObject({ phase: "retired", activeKey: null });
    await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({ state: "retired", version: 3 });
    await expect(prisma.characterReleaseEvent.findFirst({
      where: { characterId, commandId },
    })).resolves.toMatchObject({ type: "character.serving.retired" });

    const resumeRequest = new Request(`http://localhost/api/v2/admin/characters/${characterId}/commands/resume`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": `resume-retired-${suffix}` },
      body: JSON.stringify({ entityVersion: 3, reason: { code: "invalid_resume", summary: "Retired is terminal, not paused" }, confirmation: `${characterId}:resume` }),
    });
    const resumeResponse = await changeCharacterServingState(resumeRequest, characterId, "resume");
    expect(resumeResponse.status).toBe(422);
  });
});
