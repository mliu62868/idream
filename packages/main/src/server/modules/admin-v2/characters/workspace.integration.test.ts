import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterWorkspaceDetailSchema, collaborationActivityListResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { POST as refreshReleaseMonitor } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/monitors/[window]/refresh/route";
import { GET as listActivityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import { PATCH as patchCharacterProjectRoute } from "@/app/api/v2/admin/characters/[id]/project/route";
import { GET as getCharacterWorkspaceRoute } from "@/app/api/v2/admin/characters/[id]/route";
import { getCharacterWorkspace, updateCharacterProjectDraft } from "./workspace";
import { loadCharacterRendererPreview } from "./renderer-preview";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import { env } from "@/server/lib/env";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";

describe("Character operator workspace", () => {
  const suffix = randomUUID();
  const characterId = `workspace-character-${suffix}`;
  const projectId = `workspace-project-${suffix}`;
  const contentId = `workspace-content-${suffix}`;
  const revisionId = `workspace-revision-${suffix}`;
  const releaseId = `workspace-release-${suffix}`;
  const requestId = `workspace-request-${suffix}`;
  const readOnlyActorId = `workspace-readonly-${suffix}`;
  const previewAssetId = `workspace-preview-asset-${suffix}`;
  const previewAssetUrl = `/user-content/${previewAssetId}/content.webp`;
  const visualProfileId = `workspace-visual-${suffix}`;
  const referenceSetId = `workspace-reference-set-${suffix}`;
  const qualificationId = `workspace-qualification-${suffix}`;
  const generationProfileId = `workspace-generation-profile-${suffix}`;
  const generationProfileKey = `workspace-generation-${suffix}`;
  const referenceSnapshotHash = referenceSetSnapshotHash({
    visualProfileId,
    revision: 1,
    selectorVersion: "workspace-v1",
    references: [{ mediaAssetId: previewAssetId, position: 0, role: "identity_anchor", weight: 1 }],
  });

  beforeAll(async () => {
    await prisma.user.create({ data: { id: readOnlyActorId, email: `${readOnlyActorId}@example.test`, role: "user" } });
    await prisma.mediaAsset.create({ data: {
      id: previewAssetId,
      ownerId: readOnlyActorId,
      type: "image",
      url: previewAssetUrl,
      visibility: "unlisted",
      safetyStatus: "passed",
      metadata: {},
    } });
    await prisma.adminUserPermission.create({
      data: {
        userId: readOnlyActorId,
        permissionKey: "character.release.read",
        effect: "grant",
        reason: "Verify monitor refresh remains a review-only command",
        createdById: readOnlyActorId,
      },
    });
    await prisma.adminUserPermission.create({
      data: {
        userId: readOnlyActorId,
        permissionKey: "character.project.read",
        effect: "grant",
        reason: "Verify composite workspace requires every exposed authority permission",
        createdById: readOnlyActorId,
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Mara",
        age: 28,
        description: "A precise, grounded evening companion.",
        source: "official",
        appearance: {},
        advancedDetails: { firstMessage: "You made it. What do you need to put down tonight?" },
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "qa",
        audience: {
          audience: "People decompressing after demanding work",
          companionNeed: "A reliable transition out of work mode",
          targetPlacementKeys: ["feed_card"],
        },
        hypothesis: "Specific openings improve qualified conversation",
        differentiation: "Calm direction without generic affirmation",
        successCriteria: ["QCE improves without D7 regression"],
        activeKey: `workspace:${suffix}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `workspace-hash-${suffix}`,
        personaSnapshot: { name: "Mara", description: "A precise, grounded evening companion." },
        openingSnapshot: { firstMessage: "You made it." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "workspace_test",
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {
          placements: [{ slotKey: "character_avatar", assetId: previewAssetId, slotVersion: 1 }],
        },
        snapshotHash: `workspace-snapshot-${suffix}`,
        readiness: "blocked",
        status: "draft",
      },
    });
    await prisma.characterServing.create({
      data: { id: `workspace-serving-${suffix}`, characterId, state: "inactive" },
    });
    const visualProfile = await prisma.characterVisualProfile.create({ data: {
      id: visualProfileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "same adult character",
      faceTraits: { eyes: "brown" }, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {},
      anchorAssetIds: [previewAssetId], referenceAssetIds: [previewAssetId], adapterRefs: {},
      evidenceState: "candidate",
      createdFrom: "workspace_test",
    } });
    await prisma.characterVisualProfile.update({ where: { id: visualProfileId }, data: { immutableHash: characterVisualProfileSnapshotHash(visualProfile) } });
    await prisma.referenceSetRevision.create({ data: {
      id: referenceSetId,
      visualProfileId,
      revision: 1,
      status: "active",
      selectorVersion: "workspace-v1",
      snapshotHash: referenceSnapshotHash,
      createdFrom: "workspace_test",
      references: { create: { mediaAssetId: previewAssetId, position: 0, role: "identity_anchor", selectionReason: "workspace fixture" } },
    } });
    await prisma.generationModelProfile.create({ data: { id: generationProfileId, profileKey: generationProfileKey, label: "Workspace test", pipelineModel: "redcraft-krea2-txt2img", workflowKey: "redcraft-krea2-txt2img", allowedOrientations: ["portrait"], status: "active" } });
    await prisma.generationRouteQualification.create({ data: {
      id: qualificationId,
      routeFingerprint: `workspace-route-${suffix}`,
      generationProfileKey,
      generationProfileVersion: 1,
      workflowKey: "redcraft-krea2-txt2img",
      workflowVersion: 1,
      style: "realistic",
      matrixKey: `workspace-matrix-${suffix}`,
      sampleCount: 40,
      passCount: 40,
      identityMatch: 0.95,
      result: "qualified",
      evidence: { reviewerId: readOnlyActorId, batchIds: ["batch-1"], evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    } });
  });

  afterAll(async () => {
    await prisma.adminUserPermission.deleteMany({ where: { userId: readOnlyActorId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: projectId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: projectId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.generationRouteQualification.deleteMany({ where: { id: qualificationId } });
    await prisma.generationModelProfile.deleteMany({ where: { id: generationProfileId } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { referenceSetRevisionId: referenceSetId } });
    await prisma.referenceSetRevision.deleteMany({ where: { id: referenceSetId } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: visualProfileId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: previewAssetId } });
    await prisma.user.deleteMany({ where: { id: readOnlyActorId } });
    await prisma.$disconnect();
  });

  it("returns a truthful draft preview and incomplete release evidence", async () => {
    const detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.preview).toMatchObject({
      live: null,
      draft: { label: "Draft Preview", contentVersionId: contentId, releaseId, imageUrl: previewAssetUrl, renderUrl: expect.any(String) },
      changedFields: ["new_release"],
    });
    const renderUrl = new URL(detail.preview.draft.renderUrl ?? "");
    const token = renderUrl.pathname.split("/").at(-1);
    if (!token) throw new Error("Expected a signed renderer token");
    await expect(loadCharacterRendererPreview(token)).resolves.toMatchObject({
      authority: { characterId, contentVersionId: contentId, releaseId, label: "Draft Preview" },
      character: { title: "Mara", image: previewAssetUrl },
      openingMessage: "You made it.",
    });
    expect(detail.project).toMatchObject({ productionPackage: "", qaPlan: "" });
    expect(detail.releases[0]).toMatchObject({ release: { readiness: "blocked" }, checks: [], monitors: [] });
    expect(detail.visual).toMatchObject({
      activeIdentity: { id: visualProfileId, version: 1, evidenceState: "candidate" },
      anchors: [{ mediaAssetId: previewAssetId, available: true }],
      activeReferenceSet: { id: referenceSetId, revision: 1, references: [{ mediaAssetId: previewAssetId, available: true }] },
      routeQualifications: [{ id: qualificationId, result: "qualified", stale: false, sampleCount: 40 }],
      readiness: { ready: true, blockers: [], productionDeepLink: `/admin/content/production?characterId=${characterId}` },
    });
  });

  it("fails visual readiness closed when traits, reference snapshot or route capability drifts", async () => {
    await prisma.characterVisualProfile.update({ where: { id: visualProfileId }, data: { faceTraits: {} } });
    let detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.visual.readiness).toMatchObject({ ready: false });
    expect(detail.visual.readiness.blockers.map((blocker) => blocker.code)).toContain("visual_traits_incomplete");
    await prisma.characterVisualProfile.update({ where: { id: visualProfileId }, data: { faceTraits: { eyes: "brown" } } });

    await prisma.referenceSetRevision.update({ where: { id: referenceSetId }, data: { snapshotHash: "drifted-reference-hash" } });
    detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.visual.readiness.blockers.map((blocker) => blocker.code)).toContain("reference_set_unsealed");
    await prisma.referenceSetRevision.update({ where: { id: referenceSetId }, data: { snapshotHash: referenceSnapshotHash } });

    await prisma.generationModelProfile.update({ where: { id: generationProfileId }, data: { status: "archived" } });
    detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.visual.readiness.blockers.map((blocker) => blocker.code)).toContain("generation_route_unqualified");
    expect(detail.visual.routeQualifications[0]).toMatchObject({ id: qualificationId, stale: true });
    await prisma.generationModelProfile.update({ where: { id: generationProfileId }, data: { status: "active" } });

    await prisma.generationRouteQualification.update({ where: { id: qualificationId }, data: { evidence: { evaluatorVersion: "retired-evaluator" } } });
    detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.visual.readiness.blockers.map((blocker) => blocker.code)).toContain("generation_route_unqualified");
    await prisma.generationRouteQualification.update({ where: { id: qualificationId }, data: { evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION }, workflowVersion: 999 } });
    detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.visual.readiness.blockers.map((blocker) => blocker.code)).toContain("generation_route_unqualified");
    await prisma.generationRouteQualification.update({ where: { id: qualificationId }, data: { workflowVersion: 1 } });
  });

  it("autosaves with optimistic concurrency and writes audit/outbox atomically", async () => {
    const saved = await updateCharacterProjectDraft({
      characterId,
      expectedVersion: 1,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      ownerId: null,
      audience: "People decompressing after demanding work",
      companionNeed: "A reliable transition out of work mode",
      hypothesis: "A more specific opening improves qualified conversation",
      differentiation: "Calm direction without generic affirmation",
      targetPlacementKeys: ["feed_card"],
      successCriteria: ["QCE improves without D7 regression"],
      productionPackage: "Identity set and feed card",
      qaPlan: "Five-turn mobile and desktop preview",
      plannedLaunchAt: null,
      content: {
        persona: {
          name: "Mara V2",
          age: 29,
          gender: "female",
          relationshipArchetype: "steady confidante",
          characterPromise: "A precise place to put the day down",
          personality: "Observant and gently challenging",
          tone: "Warm and concise",
          backstory: "A night-shift radio host.",
          firstMessage: "Tell me what followed you home.",
          exampleDialogue: ["Start with the part that still has heat."],
        },
        visualDirection: {
          identityAnchor: "Composed late-night radio host",
          stableTraits: ["dark wavy hair", "warm brown eyes"],
          style: "realistic",
          referenceDirection: "Intimate tungsten editorial portrait",
        },
      },
      reason: "Autosave Character Project changes",
      requestId,
    });
    expect(saved).toMatchObject({ phase: "qa", version: 2 });
    expect(await prisma.adminAuditLog.count({ where: { requestId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: projectId } })).toBe(1);
    expect(await prisma.characterContentVersion.findMany({ where: { characterId } })).toHaveLength(2);
    expect(await prisma.characterRevision.findMany({ where: { projectId } })).toHaveLength(2);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({
      name: "Mara",
      age: 28,
    });
    const activityResponse = await listActivityRoute(
      new Request(`http://localhost/api/v2/admin/collaboration/character_project/${projectId}/activity`, {
        headers: {
          "x-idream-user-id": readOnlyActorId,
          "x-idream-role": "user",
        },
      }),
      { params: Promise.resolve({ targetType: "character_project", targetId: projectId }) },
    );
    expect(activityResponse.status).toBe(200);
    const activityPayload = await activityResponse.json();
    const activity = collaborationActivityListResponseSchema.parse(activityPayload.data).items[0];
    expect(activity).toMatchObject({ targetId: projectId, kind: "draft_saved" });

    await prisma.character.update({ where: { id: characterId }, data: { status: "approved", visibility: "public" } });
    await prisma.characterRelease.update({ where: { id: releaseId }, data: { status: "published" } });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", currentReleaseId: releaseId },
    });
    const liveCandidate = await updateCharacterProjectDraft({
      characterId,
      expectedVersion: 2,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      ownerId: null,
      audience: "People decompressing after demanding work",
      companionNeed: "A reliable transition out of work mode",
      hypothesis: "A more specific opening improves qualified conversation",
      differentiation: "Calm direction without generic affirmation",
      targetPlacementKeys: ["feed_card"],
      successCriteria: ["QCE improves without D7 regression"],
      productionPackage: "Identity set and feed card",
      qaPlan: "Five-turn mobile and desktop preview",
      plannedLaunchAt: null,
      content: {
        persona: {
          name: "Unpublished Mara Candidate",
          age: 30,
          gender: "female",
          relationshipArchetype: "steady confidante",
          characterPromise: "A sharper unpublished promise",
          personality: "Observant and direct",
          tone: "Warm and precise",
          backstory: "A revised draft backstory.",
          firstMessage: "This opening is not live yet.",
          exampleDialogue: ["This candidate stays behind the release boundary."],
        },
        visualDirection: {
          identityAnchor: "Revised late-night radio host",
          stableTraits: ["dark wavy hair", "warm brown eyes"],
          style: "realistic",
          referenceDirection: "A revised unpublished portrait direction",
        },
      },
      reason: "Verify live projection containment",
      requestId: `${requestId}-live-candidate`,
    });
    expect(liveCandidate.version).toBe(3);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({
      name: "Mara",
      age: 28,
      status: "approved",
      visibility: "public",
    });
    expect(await prisma.characterContentVersion.findMany({ where: { characterId } })).toHaveLength(3);
    expect(await prisma.characterRevision.findMany({ where: { projectId } })).toHaveLength(3);

    await expect(updateCharacterProjectDraft({
      characterId,
      expectedVersion: 1,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      ownerId: null,
      audience: "stale",
      companionNeed: "stale",
      hypothesis: "stale",
      differentiation: "stale",
      targetPlacementKeys: [],
      successCriteria: ["stale"],
      productionPackage: "stale",
      qaPlan: "stale",
      plannedLaunchAt: null,
      reason: "Stale tab save",
      requestId: `${requestId}-conflict`,
    })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      phase: "qa",
      version: 3,
    });
  });

  it("rejects project PATCH without write authority and mismatched If-Match", async () => {
    const body = {
      entityVersion: 3,
      ownerId: null,
      audience: "People decompressing after demanding work",
      companionNeed: "A reliable transition out of work mode",
      hypothesis: "A more specific opening improves qualified conversation",
      differentiation: "Calm direction without generic affirmation",
      targetPlacementKeys: ["feed_card"],
      successCriteria: ["QCE improves without D7 regression"],
      productionPackage: "Identity set and feed card",
      qaPlan: "Five-turn mobile and desktop preview",
      plannedLaunchAt: null,
      reason: "Verify the Project PATCH boundary",
    };
    const forbidden = await patchCharacterProjectRoute(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/project`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": "3",
          "x-idream-user-id": readOnlyActorId,
          "x-idream-role": "user",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(forbidden.status).toBe(403);

    const missingPrecondition = await patchCharacterProjectRoute(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/project`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": "seed-admin-user",
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(missingPrecondition.status).toBe(400);

    const mismatched = await patchCharacterProjectRoute(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/project`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": "2",
          "x-idream-user-id": "seed-admin-user",
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(mismatched.status).toBe(400);
  });

  it("does not let a read-only release grant refresh monitor authority", async () => {
    const response = await refreshReleaseMonitor(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/releases/${releaseId}/monitors/24h/refresh`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": readOnlyActorId,
          "x-idream-role": "user",
        },
        body: JSON.stringify({ entityVersion: 1 }),
      }),
      { params: Promise.resolve({ id: characterId, releaseId, window: "24h" }) },
    );
    expect(response.status).toBe(403);
  });

  it("does not expose Release, Monitor, or Performance DTOs through project-only access", async () => {
    const response = await getCharacterWorkspaceRoute(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}`, {
        headers: { "x-idream-user-id": readOnlyActorId, "x-idream-role": "user" },
      }),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(response.status).toBe(403);
  });
});
