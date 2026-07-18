import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createMedia, createUser } from "@/server/test/helpers";
import { POST as scheduleRoute } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/schedule/route";
import { POST as rollbackRoute } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/rollback/route";
import { drainAdminCommands } from "@/processes/admin-command-worker";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  CHARACTER_RELEASE_POLICY_VERSION,
  executeCharacterReleaseCommand,
  validateCharacterReleaseSnapshot,
} from "./release-executor";
import { dispatchDueCharacterReleasePublishes } from "./scheduled-release-dispatcher";

describe("Character Release command executor", () => {
  const suffix = randomUUID();
  const prefix = `zt-release-executor-${suffix}`;
  const actorId = `${prefix}-actor`;
  const characterId = `${prefix}-character`;
  const projectId = `${prefix}-project`;
  const contentId = `${prefix}-content`;
  const revisionId = `${prefix}-revision`;
  const profileId = `${prefix}-profile`;
  const referenceSetId = `${prefix}-refs`;
  const mediaId = `${prefix}-media`;
  const referenceMediaId = `${prefix}-reference-media`;
  const heroMediaId = `${prefix}-hero-media`;
  const chatMediaId = `${prefix}-chat-media`;
  const oldReleaseId = `${prefix}-old`;
  const candidateReleaseId = `${prefix}-candidate`;
  const invalidReleaseId = `${prefix}-invalid`;
  const policyDriftReleaseId = `${prefix}-policy-drift`;
  const rescheduledReleaseId = `${prefix}-rescheduled`;
  const legacyShapeReleaseId = `${prefix}-legacy-shape`;
  const routeFingerprint = `${prefix}:route`;
  const routeModelProfileId = `${prefix}-route-model-profile`;
  const routeProfileKey = `${prefix}-route-profile`;
  const routeWorkflowKey = "qwen-image-edit-img2img";
  const qaRunId = `${prefix}-qa-run`;
  const qaEvidenceHash = `${prefix}-qa-evidence-hash`;
  const releaseAssetFixtures = [
    {
      slotKey: "character_avatar",
      purpose: "character_cover",
      assetId: mediaId,
      runId: `${prefix}-avatar-run`,
      itemId: `${prefix}-avatar-item`,
      jobId: `${prefix}-avatar-job`,
      decisionId: `${prefix}-avatar-decision`,
    },
    {
      slotKey: "character_hero",
      purpose: "character_hero",
      assetId: heroMediaId,
      runId: `${prefix}-hero-run`,
      itemId: `${prefix}-hero-item`,
      jobId: `${prefix}-hero-job`,
      decisionId: `${prefix}-hero-decision`,
    },
    {
      slotKey: "character_chat",
      purpose: "character_chat",
      assetId: chatMediaId,
      runId: `${prefix}-chat-run`,
      itemId: `${prefix}-chat-item`,
      jobId: `${prefix}-chat-job`,
      decisionId: `${prefix}-chat-decision`,
    },
  ] as const;
  const draftAssetPack = {
    character_cover: {
      assetId: mediaId,
      runId: releaseAssetFixtures[0].runId,
      itemId: releaseAssetFixtures[0].itemId,
      reviewDecisionId: releaseAssetFixtures[0].decisionId,
      generationJobId: releaseAssetFixtures[0].jobId,
    },
    character_hero: {
      assetId: heroMediaId,
      runId: releaseAssetFixtures[1].runId,
      itemId: releaseAssetFixtures[1].itemId,
      reviewDecisionId: releaseAssetFixtures[1].decisionId,
      generationJobId: releaseAssetFixtures[1].jobId,
    },
    character_chat: {
      assetId: chatMediaId,
      runId: releaseAssetFixtures[2].runId,
      itemId: releaseAssetFixtures[2].itemId,
      reviewDecisionId: releaseAssetFixtures[2].decisionId,
      generationJobId: releaseAssetFixtures[2].jobId,
    },
  };
  const draftAssetPackHash = canonicalSha256(draftAssetPack);
  let visualProfileHash = "";
  let referenceSetHash = "";
  let referenceManifestHash = "";

  function releaseData(id: string, overrides: Record<string, unknown> = {}) {
    const generationProvenance = {
      schemaVersion: "character-release-generation-provenance-v2",
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      requiredReleaseRoute: {
        routeFingerprint,
        matrixKey: "default-character",
        generationProfileKey: routeProfileKey,
        generationProfileVersion: 1,
        workflowKey: routeWorkflowKey,
        workflowVersion: 1,
      },
      characterQa: {
        status: "passed",
        qaRunId,
        evidenceHash: qaEvidenceHash,
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
        draftAssetPackHash,
      },
      placements: releaseAssetFixtures.map((fixture) => ({
        slotKey: fixture.slotKey,
        assetId: fixture.assetId,
        generationJobId: fixture.jobId,
        attemptId: `${fixture.jobId}-attempt`,
        attemptNo: 1,
        provider: "comfyui",
        generationProfileKey: routeProfileKey,
        generationProfileVersion: 1,
        workflowKey: routeWorkflowKey,
        workflowVersion: 1,
        visualProfileId: profileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: referenceSetId,
        referenceManifestHash,
        bootstrapIdentity: false,
      })),
    };
    const releasePlacementManifest = {
      schemaVersion: 2,
      placements: releaseAssetFixtures.map((fixture) => ({
        slotKey: fixture.slotKey,
        assetId: fixture.assetId,
        slotVersion: 1,
        runId: fixture.runId,
        itemId: fixture.itemId,
        reviewDecisionId: fixture.decisionId,
        generationJobId: fixture.jobId,
        bootstrapIdentity: false,
      })),
    };
    const snapshot = {
      projectId,
      revisionId,
      characterContentVersionId: contentId,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      generationProvenance,
      releasePlacementManifest,
    };
    const base = {
      id,
      ...snapshot,
      status: "approved",
      readiness: "ready",
      legacy: false,
      version: 1,
    };
    return {
      ...base,
      snapshotHash: characterReleaseSnapshotHash(snapshot),
      ...overrides,
    };
  }

  async function accept(input: {
    commandType: string;
    target: { type: string; id: string };
    expectedVersion: number;
    payload: Record<string, unknown>;
  }) {
    return acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: actorId, role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: input.commandType,
      target: input.target,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
      retryMode: "idempotent",
      reason: "Phase 2 release executor test",
      requestId: randomUUID(),
    });
  }

  async function executeServingTransition(input: {
    commandType:
      | "character.serving.pause"
      | "character.serving.resume"
      | "character.serving.retire";
    now: Date;
  }) {
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const accepted = await accept({
      commandType: input.commandType,
      target: { type: "character_serving", id: characterId },
      expectedVersion: serving.version,
      payload: { reason: `Exercise ${input.commandType}` },
    });
    return executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-${input.commandType}-worker`,
      now: input.now,
    });
  }

  function routeRequest(body: Record<string, unknown>, confirmation: string) {
    return new Request(
      "http://localhost/api/v2/admin/characters/x/releases/x/commands/test",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          "idempotency-key": randomUUID(),
          "if-match": `"${String(body.entityVersion)}"`,
        },
        body: JSON.stringify({
          ...body,
          reason: {
            code: "operator_verified",
            summary: "Verified Phase 2 release command",
          },
          confirmation,
        }),
      },
    );
  }

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin" });
    await createMedia({
      id: mediaId,
      ownerId: actorId,
      visibility: "public",
      url: `https://assets.example.test/${mediaId}.webp`,
    });
    for (const assetId of [
      referenceMediaId,
      heroMediaId,
      chatMediaId,
    ]) {
      await createMedia({
        id: assetId,
        ownerId: actorId,
        visibility: "public",
        url: `https://assets.example.test/${assetId}.webp`,
      });
    }
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Release executor character",
        age: 28,
        description: "Complete immutable content.",
        systemPrompt: "Stay in persona.",
        source: "official",
        status: "approved",
        visibility: "public",
        imageAssetId: mediaId,
        appearance: { face: { eyes: "amber" } },
        advancedDetails: { firstMessage: "Welcome back." },
      },
    });
    await prisma.mediaAsset.updateMany({
      where: {
        id: {
          in: [
            mediaId,
            referenceMediaId,
            heroMediaId,
            chatMediaId,
          ],
        },
      },
      data: { characterId, safetyStatus: "passed" },
    });
    const visualProfileData = {
      id: profileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "stable identity",
      faceTraits: { eyes: "amber" },
      hairTraits: { color: "black" },
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: { style: "realistic" },
      anchorAssetIds: [referenceMediaId],
      referenceAssetIds: [referenceMediaId],
      adapterRefs: {},
      evidenceState: "qualified",
      createdFrom: "test",
    };
    visualProfileHash = characterVisualProfileSnapshotHash({
      ...visualProfileData,
      negativeIdentityPrompt: null,
    });
    await prisma.characterVisualProfile.create({
      data: {
        ...visualProfileData,
        immutableHash: visualProfileHash,
      },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId: profileId,
        revision: 1,
        status: "active",
        selectorVersion: "v2",
        snapshotHash: (referenceSetHash = referenceSetSnapshotHash({
          visualProfileId: profileId,
          revision: 1,
          selectorVersion: "v2",
          references: [
            {
              mediaAssetId: referenceMediaId,
              position: 0,
              role: "primary_face",
              weight: 1,
            },
          ],
        })),
        createdFrom: "test",
        references: {
          create: {
            mediaAssetId: referenceMediaId,
            position: 0,
            role: "primary_face",
            selectionReason: "test evidence",
          },
        },
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: routeModelProfileId,
        profileKey: routeProfileKey,
        label: "Release executor identity route",
        runner: "comfyui",
        pipelineModel: routeWorkflowKey,
        workflowKey: routeWorkflowKey,
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
        routeFingerprint,
        generationProfileKey: routeProfileKey,
        generationProfileVersion: 1,
        workflowKey: routeWorkflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: "default-character",
        sampleCount: 40,
        passCount: 37,
        identityMatch: 0.925,
        result: "qualified",
        evidence: {
          reviewerId: actorId,
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const jobReferenceManifest = [{
      mediaAssetId: referenceMediaId,
      position: 0,
      role: "primary_face",
      weight: 1,
      selectorVersion: "v2",
      selectionReason: "Release executor identity authority",
      referenceSetRevisionId: referenceSetId,
      referenceSetRevision: 1,
      snapshotHash: referenceSetHash,
    }];
    referenceManifestHash = canonicalSha256(jobReferenceManifest);
    for (const fixture of releaseAssetFixtures) {
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
        data: {
          id: fixture.itemId,
          batchId: fixture.runId,
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
          score: 92,
          evidence: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          reason: "Approved strict Release asset",
          reviewerId: actorId,
        },
      });
      await prisma.generationJob.create({
        data: {
          id: fixture.jobId,
          userId: actorId,
          characterId,
          visualProfileId: profileId,
          visualProfileVersion: 1,
          consistencyMode: "strict",
          referenceAssetIds: [referenceMediaId],
          referenceSetRevisionId: referenceSetId,
          referenceManifest: jobReferenceManifest,
          mode: "image",
          controls: {},
          presetIds: [],
          model: routeWorkflowKey,
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
            generationRouteFingerprint: routeFingerprint,
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
          workflowKey: routeWorkflowKey,
          workflowVersion: 1,
          status: "succeeded",
          creativeRunItemId: fixture.itemId,
          finishedAt: new Date(),
        },
      });
      await prisma.contentProductionItem.update({
        where: { id: fixture.itemId },
        data: { jobId: fixture.jobId },
      });
      await prisma.mediaAsset.update({
        where: { id: fixture.assetId },
        data: { sourceJobId: fixture.jobId },
      });
    }
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `${prefix}-content-hash`,
        personaSnapshot: {
          name: "Released Snapshot Persona",
          age: 29,
          gender: "female",
          relationshipArchetype: "trusted confidante",
          characterPromise: "Complete immutable content.",
          personality: "Grounded and attentive.",
          tone: "Warm and concise.",
          backstory: "A host who remembers the important details.",
          systemPrompt: "Stay in persona.",
          description: "Complete immutable content.",
        },
        openingSnapshot: { firstMessage: "Welcome back." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "test",
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "launch_ready",
        audience: { segment: "test" },
        successCriteria: ["healthy launch"],
        draftImageAssetId: mediaId,
        draftAssetPack,
        activeKey: `official:${characterId}`,
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: { hypothesis: "test" },
      },
    });
    await prisma.characterQaRun.create({
      data: {
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
        draftAssetPackHash,
        ownerId: actorId,
        status: "passed",
        checks: [],
        evidenceHash: qaEvidenceHash,
      },
    });
    await prisma.characterRelease.create({
      data: releaseData(oldReleaseId, {
        status: "published",
        publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    });
    await prisma.characterRelease.create({
      data: releaseData(candidateReleaseId),
    });
    await prisma.characterRelease.create({
      data: releaseData(invalidReleaseId, {
        snapshotHash: "tampered-snapshot",
      }),
    });
    await prisma.characterRelease.create({
      data: releaseData(policyDriftReleaseId),
    });
    await prisma.characterRelease.create({
      data: releaseData(rescheduledReleaseId),
    });
    const legacyShapeProvenance = {
      routeFingerprint,
      matrixKey: "default-character",
      generationProfileKey: routeProfileKey,
      generationProfileVersion: 1,
      workflowKey: routeWorkflowKey,
      workflowVersion: 1,
      characterQa: {
        status: "passed",
        qaRunId,
        evidenceHash: qaEvidenceHash,
      },
    };
    const legacyShapeManifest = {
      placements: [{
        slotKey: "character_avatar",
        assetId: mediaId,
        slotVersion: 1,
      }],
    };
    const legacyShapeSnapshot = {
      projectId,
      revisionId,
      characterContentVersionId: contentId,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      generationProvenance: legacyShapeProvenance,
      releasePlacementManifest: legacyShapeManifest,
    };
    await prisma.characterRelease.create({
      data: {
        id: legacyShapeReleaseId,
        ...legacyShapeSnapshot,
        snapshotHash: characterReleaseSnapshotHash(legacyShapeSnapshot),
        status: "approved",
        readiness: "ready",
        legacy: false,
        version: 1,
      },
    });
    await prisma.characterServing.create({
      data: {
        characterId,
        state: "live",
        currentReleaseId: oldReleaseId,
        version: 1,
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { startsWith: prefix } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { characterId } });
    const commands = await prisma.controlPlaneCommand.findMany({
      where: { actorId },
      select: { id: true },
    });
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commands.map((item) => item.id) } },
    });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { startsWith: prefix } },
    });
    await prisma.releaseCheckResult.deleteMany({
      where: {
        validationRunId: {
          in: (
            await prisma.releaseValidationRun.findMany({
              where: { releaseId: { startsWith: prefix } },
              select: { id: true },
            })
          ).map((item) => item.id),
        },
      },
    });
    await prisma.releaseValidationRun.deleteMany({
      where: { releaseId: { startsWith: prefix } },
    });
    await prisma.releaseMonitor.deleteMany({
      where: { releaseId: { startsWith: prefix } },
    });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.creativeReviewDecision.deleteMany({
      where: {
        id: {
          in: releaseAssetFixtures.map((fixture) => fixture.decisionId),
        },
      },
    });
    await prisma.generationAttempt.deleteMany({
      where: {
        requestId: {
          in: releaseAssetFixtures.map((fixture) => fixture.jobId),
        },
      },
    });
    await prisma.generationJob.deleteMany({
      where: {
        id: {
          in: releaseAssetFixtures.map((fixture) => fixture.jobId),
        },
      },
    });
    await prisma.contentProductionItem.deleteMany({
      where: {
        id: {
          in: releaseAssetFixtures.map((fixture) => fixture.itemId),
        },
      },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: {
        id: {
          in: releaseAssetFixtures.map((fixture) => fixture.runId),
        },
      },
    });
    await prisma.characterQaRun.deleteMany({ where: { id: qaRunId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.generationRouteQualification.deleteMany({
      where: { routeFingerprint },
    });
    await prisma.generationModelProfile.deleteMany({
      where: { id: routeModelProfileId },
    });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: referenceSetId },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { id: referenceSetId },
    });
    await prisma.characterVisualProfile.deleteMany({
      where: { id: profileId },
    });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            mediaId,
            referenceMediaId,
            heroMediaId,
            chatMediaId,
          ],
        },
      },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("accepts schedule but rejects rollback to a never-published draft", async () => {
    const schedule = await scheduleRoute(
      routeRequest(
        { entityVersion: 1, scheduledAt: "2030-01-02T00:00:00.000Z" },
        `${characterId}:${invalidReleaseId}:schedule`,
      ),
      {
        params: Promise.resolve({
          id: characterId,
          releaseId: invalidReleaseId,
        }),
      },
    );
    const rollback = await rollbackRoute(
      routeRequest(
        { entityVersion: 1 },
        `${characterId}:${invalidReleaseId}:rollback`,
      ),
      {
        params: Promise.resolve({
          id: characterId,
          releaseId: invalidReleaseId,
        }),
      },
    );
    expect([schedule.status, rollback.status]).toEqual([202, 422]);
    await expect(rollback.json()).resolves.toMatchObject({
      error: { code: "invariant_failed", blockers: [{ code: "rollback_source_not_superseded" }] },
    });
    expect(
      await prisma.controlPlaneCommand.findUnique({ where: { id: (await schedule.json()).data.commandId } }),
    ).toMatchObject({
      commandType: "character.release.schedule",
      targetType: "character_release",
      targetId: invalidReleaseId,
    });
  });

  it("fails closed for a non-legacy single-avatar Release with no strict-v2 lineage", async () => {
    const release = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: legacyShapeReleaseId },
    });
    const validation = await prisma.$transaction((tx) =>
      validateCharacterReleaseSnapshot(
        tx,
        release,
        CHARACTER_RELEASE_POLICY_VERSION,
        new Date("2026-07-11T00:00:00.000Z"),
      )
    );
    expect(validation.run.result).toBe("failed");
    expect(validation.failed.map((check) => check.key)).toEqual(
      expect.arrayContaining([
        "release_generation_authority_kind",
        "release_asset_manifest_available",
        "release_asset_review_authority",
        "release_asset_generation_authority",
      ]),
    );
  });

  it.each([
    ["missing exact policy", "missing_policy"],
    ["top-level route fallback", "top_level_route"],
  ] as const)(
    "fails closed for strict-v2 provenance with %s",
    async (_label, malformedKind) => {
      const canonical = releaseData(
        `${prefix}-malformed-authority-${malformedKind}`,
      );
      const canonicalRoute =
        canonical.generationProvenance.requiredReleaseRoute;
      const restProvenance = Object.fromEntries(
        Object.entries(canonical.generationProvenance).filter(
          ([key]) =>
            key !== "requiredReleaseRoute" && key !== "policyVersion",
        ),
      );
      const malformedProvenance = malformedKind === "missing_policy"
        ? {
            ...restProvenance,
            requiredReleaseRoute: canonicalRoute,
          }
        : {
            ...restProvenance,
            policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
            ...canonicalRoute,
          };
      const malformedSnapshot = {
        projectId: canonical.projectId,
        revisionId: canonical.revisionId,
        characterContentVersionId: canonical.characterContentVersionId,
        visualProfileId: canonical.visualProfileId,
        visualProfileVersion: canonical.visualProfileVersion,
        referenceSetRevisionId: canonical.referenceSetRevisionId,
        generationProvenance: malformedProvenance,
        releasePlacementManifest: canonical.releasePlacementManifest,
      };
      const malformed = await prisma.characterRelease.create({
        data: {
          ...canonical,
          generationProvenance: malformedProvenance,
          snapshotHash: characterReleaseSnapshotHash(malformedSnapshot),
        },
      });
      const validation = await prisma.$transaction((tx) =>
        validateCharacterReleaseSnapshot(
          tx,
          malformed,
          CHARACTER_RELEASE_POLICY_VERSION,
          new Date("2026-07-11T00:00:00.000Z"),
        )
      );

      expect(validation.run.result).toBe("failed");
      expect(validation.checks).toContainEqual(expect.objectContaining({
        key: "release_generation_authority_kind",
        passed: false,
      }));
    },
  );

  it("fails closed when the current validation policy has no matching route qualification", async () => {
    const accepted = await accept({
      commandType: "character.release.publish",
      target: { type: "character_release", id: candidateReleaseId },
      expectedVersion: 1,
      payload: { reason: "Exercise policy drift" },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      policyVersion: "character-release-policy-v3",
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "release_validation_failed",
    });
    const validation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: candidateReleaseId },
      orderBy: { startedAt: "desc" },
    });
    expect(validation).toMatchObject({
      policyVersion: "character-release-policy-v3",
      result: "failed",
    });
    expect(
      (
        await prisma.characterServing.findUniqueOrThrow({
          where: { characterId },
        })
      ).currentReleaseId,
    ).toBe(oldReleaseId);
  });

  it("fails publish-time route authority when evaluator or active profile availability drifts", async () => {
    const release = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: candidateReleaseId },
    });
    const validate = () => prisma.$transaction((tx) =>
      validateCharacterReleaseSnapshot(
        tx,
        release,
        CHARACTER_RELEASE_POLICY_VERSION,
        new Date("2026-07-11T00:00:00.000Z"),
      )
    );
    await prisma.generationRouteQualification.updateMany({
      where: { routeFingerprint, policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
      data: {
        evidence: {
          reviewerId: actorId,
          evaluatorVersion: "retired-evaluator",
        },
      },
    });
    try {
      const staleEvaluator = await validate();
      expect(staleEvaluator.checks).toContainEqual(expect.objectContaining({
        key: "generation_route_qualified",
        passed: false,
        evidence: expect.objectContaining({
          effectiveReason: "evaluator_version_changed",
        }),
      }));
    } finally {
      await prisma.generationRouteQualification.updateMany({
        where: { routeFingerprint, policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
        data: {
          evidence: {
            reviewerId: actorId,
            evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          },
        },
      });
    }

    await prisma.generationModelProfile.update({
      where: { id: routeModelProfileId },
      data: { enabled: false },
    });
    try {
      const disabledProfile = await validate();
      expect(disabledProfile.checks).toContainEqual(expect.objectContaining({
        key: "generation_route_qualified",
        passed: false,
        evidence: expect.objectContaining({
          effectiveReason: "generation_profile_unavailable",
        }),
      }));
    } finally {
      await prisma.generationModelProfile.update({
        where: { id: routeModelProfileId },
        data: { enabled: true },
      });
    }
  });

  it("rejects an illegal Project phase before writing validation evidence", async () => {
    await prisma.characterProject.update({
      where: { id: projectId },
      data: { phase: "retired", version: { increment: 1 } },
    });
    const validationsBefore = await prisma.releaseValidationRun.count({
      where: { releaseId: candidateReleaseId },
    });
    const accepted = await accept({
      commandType: "character.release.publish",
      target: { type: "character_release", id: candidateReleaseId },
      expectedVersion: 1,
      payload: { reason: "Reject an illegal Project transition" },
    });

    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: accepted.commandId,
        workerId: `${prefix}-invalid-project-phase-worker`,
        now: new Date("2026-07-11T01:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "project_phase_conflict",
    });
    await expect(
      prisma.releaseValidationRun.count({
        where: { releaseId: candidateReleaseId },
      }),
    ).resolves.toBe(validationsBefore);
    await expect(
      prisma.characterRelease.findUnique({ where: { id: candidateReleaseId } }),
    ).resolves.toMatchObject({ status: "approved", version: 1 });

    await prisma.characterProject.update({
      where: { id: projectId },
      data: { phase: "launch_ready", version: { increment: 1 } },
    });
  });

  it("validates and schedules without changing the current live pointer", async () => {
    const scheduledAt = new Date("2026-07-20T12:00:00.000Z");
    const accepted = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: candidateReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: scheduledAt.toISOString(),
        reason: "Schedule tested release",
      },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      now: new Date("2026-07-12T00:00:00.000Z"),
    });
    expect(result.status).toBe("succeeded");
    expect(
      await prisma.characterServing.findUnique({ where: { characterId } }),
    ).toMatchObject({
      currentReleaseId: oldReleaseId,
      scheduledReleaseId: candidateReleaseId,
      scheduledAt,
      state: "live",
      version: 2,
    });
    const validation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: candidateReleaseId },
      orderBy: { startedAt: "desc" },
    });
    expect(validation).toMatchObject({
      snapshotHash: releaseData(candidateReleaseId).snapshotHash,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "passed",
    });
  });

  it("survives dispatcher restart and lets concurrent schedulers and workers publish one canonical effect", async () => {
    const dueAt = new Date("2026-07-20T12:00:00.000Z");
    const validationsBefore = await prisma.releaseValidationRun.count({
      where: { releaseId: candidateReleaseId },
    });
    const dispatches = await Promise.all([
      dispatchDueCharacterReleasePublishes(prisma, {
        dispatcherId: `${prefix}-scheduler-a`,
        environment: "test",
        now: dueAt,
      }),
      dispatchDueCharacterReleasePublishes(prisma, {
        dispatcherId: `${prefix}-scheduler-b`,
        environment: "test",
        now: dueAt,
      }),
    ]);
    const commandIds = dispatches.flatMap((dispatch) =>
      dispatch.commands.map((command) => command.commandId),
    );
    expect(new Set(commandIds).size).toBe(1);
    expect(dispatches.reduce((sum, dispatch) => sum + dispatch.accepted, 0)).toBe(1);
    expect(dispatches.reduce((sum, dispatch) => sum + dispatch.replayed, 0)).toBe(1);

    const restarted = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-scheduler-after-restart`,
      environment: "test",
      now: new Date(dueAt.getTime() + 1_000),
    });
    expect(restarted).toMatchObject({ accepted: 0, replayed: 1 });
    expect(restarted.commands[0]?.commandId).toBe(commandIds[0]);

    await Promise.all([
      drainAdminCommands(prisma, {
        workerId: `${prefix}-publisher-a`,
        environment: "test",
        now: dueAt,
      }),
      drainAdminCommands(prisma, {
        workerId: `${prefix}-publisher-b`,
        environment: "test",
        now: dueAt,
      }),
    ]);
    const acceptedCommandId = commandIds[0]!;
    expect(
      await prisma.controlPlaneCommand.count({
        where: {
          actorId: "system:character-release-scheduler",
          commandType: "character.release.publish",
          targetId: candidateReleaseId,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.characterServing.findUnique({ where: { characterId } }),
    ).toMatchObject({
      currentReleaseId: candidateReleaseId,
      scheduledReleaseId: null,
      scheduledAt: null,
      state: "live",
      version: 3,
    });
    expect(
      await prisma.characterRelease.findUnique({ where: { id: oldReleaseId } }),
    ).toMatchObject({ status: "superseded" });
    expect(
      await prisma.characterRelease.findUnique({
        where: { id: candidateReleaseId },
      }),
    ).toMatchObject({ status: "published", readiness: "ready", version: 2 });
    expect(
      await prisma.character.findUnique({ where: { id: characterId } }),
    ).toMatchObject({
      name: "Released Snapshot Persona",
      age: 29,
      status: "approved",
      visibility: "public",
      imageAssetId: mediaId,
    });
    expect(
      await prisma.characterReleaseEvent.count({
        where: { releaseId: candidateReleaseId, type: "character.release.published" },
      }),
    ).toBe(1);
    expect(
      await prisma.adminAuditLog.count({
        where: {
          requestId: acceptedCommandId,
          action: "character.release.publish.executed",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          eventType: "character.release.published.v2",
          aggregateId: candidateReleaseId,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.releaseValidationRun.count({
        where: { releaseId: candidateReleaseId },
      }),
    ).toBe(validationsBefore + 1);
    expect(
      await prisma.releaseValidationRun.findFirst({
        where: { releaseId: candidateReleaseId },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ).toMatchObject({
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "passed",
    });
    expect(
      await prisma.releaseMonitor.findMany({
        where: { releaseId: candidateReleaseId },
        orderBy: { window: "asc" },
        select: { window: true, status: true, startedAt: true, dueAt: true },
      }),
    ).toEqual([
      {
        window: "24h",
        status: "pending",
        startedAt: dueAt,
        dueAt: new Date(dueAt.getTime() + 24 * 60 * 60 * 1_000),
      },
      {
        window: "72h",
        status: "pending",
        startedAt: dueAt,
        dueAt: new Date(dueAt.getTime() + 72 * 60 * 60 * 1_000),
      },
    ]);
  });

  it("fails closed on a tampered snapshot and leaves the serving pointer unchanged", async () => {
    const accepted = await accept({
      commandType: "character.release.publish",
      target: { type: "character_release", id: invalidReleaseId },
      expectedVersion: 1,
      payload: { reason: "Must fail" },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      now: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("release_validation_failed");
    expect(
      (
        await prisma.characterServing.findUniqueOrThrow({
          where: { characterId },
        })
      ).currentReleaseId,
    ).toBe(candidateReleaseId);
    const validation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: invalidReleaseId },
      orderBy: { startedAt: "desc" },
    });
    expect(validation.result).toBe("failed");
    expect(
      await prisma.releaseCheckResult.findFirst({
        where: {
          validationRunId: validation.id,
          checkKey: "snapshot_hash_matches",
        },
      }),
    ).toMatchObject({ result: "failed" });
  });

  it("rolls back by cloning the complete historical snapshot into a new Release", async () => {
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const accepted = await accept({
      commandType: "character.release.rollback",
      target: { type: "character_serving", id: characterId },
      expectedVersion: serving.version,
      payload: {
        sourceReleaseId: oldReleaseId,
        reason: "Rollback after verification",
      },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      now: new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(result.status).toBe("succeeded");
    expect(result.releaseId).not.toBe(oldReleaseId);
    const rollback = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: result.releaseId },
    });
    expect(rollback).toMatchObject({
      rollbackOfReleaseId: oldReleaseId,
      characterContentVersionId: contentId,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      snapshotHash: releaseData(oldReleaseId).snapshotHash,
      status: "published",
    });
    expect(
      (
        await prisma.characterRelease.findUniqueOrThrow({
          where: { id: oldReleaseId },
        })
      ).status,
    ).toBe("superseded");
    expect(
      (
        await prisma.characterServing.findUniqueOrThrow({
          where: { characterId },
        })
      ).currentReleaseId,
    ).toBe(rollback.id);
  });

  it("rejects a queued due command when the schedule occurrence changes before its worker runs", async () => {
    const firstScheduledAt = new Date("2026-07-23T12:00:00.000Z");
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: rescheduledReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: firstScheduledAt.toISOString(),
        reason: "Schedule the first occurrence",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-first-schedule-worker`,
        now: new Date("2026-07-23T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const due = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-first-occurrence-scheduler`,
      environment: "test",
      now: firstScheduledAt,
    });
    expect(due).toMatchObject({ accepted: 1, replayed: 0 });

    const secondScheduledAt = new Date("2026-07-24T12:00:00.000Z");
    const reschedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: rescheduledReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: secondScheduledAt.toISOString(),
        reason: "Move the schedule before the queued worker runs",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: reschedule.commandId,
        workerId: `${prefix}-reschedule-worker`,
        now: new Date("2026-07-23T12:00:01.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    await drainAdminCommands(prisma, {
      workerId: `${prefix}-stale-occurrence-worker`,
      environment: "test",
      now: new Date("2026-07-23T12:00:02.000Z"),
    });
    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: due.commands[0]!.commandId },
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        code: "scheduled_release_occurrence_changed",
      }),
    });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      scheduledReleaseId: rescheduledReleaseId,
      scheduledAt: secondScheduledAt,
    });
    expect(
      await prisma.characterRelease.findUniqueOrThrow({
        where: { id: rescheduledReleaseId },
      }),
    ).toMatchObject({ status: "approved", version: 1 });
    expect(
      await prisma.characterReleaseEvent.count({
        where: {
          releaseId: rescheduledReleaseId,
          type: "character.release.published",
        },
      }),
    ).toBe(0);
  });

  it("publishes a due first Release from inactive Serving and moves it live", async () => {
    await prisma.characterServing.update({
      where: { characterId },
      data: {
        state: "inactive",
        currentReleaseId: null,
        scheduledReleaseId: null,
        scheduledAt: null,
        version: { increment: 1 },
      },
    });
    const scheduledAt = new Date("2026-07-24T12:00:00.000Z");
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: rescheduledReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: scheduledAt.toISOString(),
        reason: "Schedule the first Release for an inactive Character",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-inactive-schedule-worker`,
        now: new Date("2026-07-24T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const dispatched = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-inactive-due-scheduler`,
      environment: "test",
      now: scheduledAt,
    });
    expect(dispatched).toMatchObject({ accepted: 1, replayed: 0 });
    await drainAdminCommands(prisma, {
      workerId: `${prefix}-inactive-due-worker`,
      environment: "test",
      now: scheduledAt,
    });
    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: dispatched.commands[0]!.commandId },
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      state: "live",
      currentReleaseId: rescheduledReleaseId,
      scheduledReleaseId: null,
      scheduledAt: null,
    });
  });

  it("revalidates paused Serving and rejects blocked, archived, or snapshot-drifted Release assets", async () => {
    const originalReferenceSet = await prisma.referenceSetRevision.findUniqueOrThrow({
      where: { id: referenceSetId },
      select: { snapshotHash: true },
    });
    if (!originalReferenceSet.snapshotHash) {
      throw new Error("Release executor fixture must have a sealed Reference Set");
    }
    const originalReferenceSetHash = originalReferenceSet.snapshotHash;
    const cases = [
      {
        label: "blocked asset",
        mutate: () =>
          prisma.mediaAsset.update({
            where: { id: mediaId },
            data: { safetyStatus: "blocked" },
          }),
        restore: () =>
          prisma.mediaAsset.update({
            where: { id: mediaId },
            data: { safetyStatus: "passed" },
          }),
        expectedBlocker: "release_avatar_manifest_available",
      },
      {
        label: "archived asset",
        mutate: () =>
          prisma.mediaAsset.update({
            where: { id: mediaId },
            data: { deletedAt: new Date("2026-07-24T14:00:00.000Z") },
          }),
        restore: () =>
          prisma.mediaAsset.update({
            where: { id: mediaId },
            data: { deletedAt: null },
          }),
        expectedBlocker: "release_asset_manifest_available",
      },
      {
        label: "reference snapshot drift",
        mutate: () =>
          prisma.referenceSetRevision.update({
            where: { id: referenceSetId },
            data: { snapshotHash: `${originalReferenceSetHash}:drifted` },
          }),
        restore: () =>
          prisma.referenceSetRevision.update({
            where: { id: referenceSetId },
            data: { snapshotHash: originalReferenceSetHash },
          }),
        expectedBlocker: "reference_set_published_snapshot",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const pauseAt = new Date(
        `2026-07-24T${String(13 + index).padStart(2, "0")}:00:00.000Z`,
      );
      const failedResumeAt = new Date(pauseAt.getTime() + 10 * 60 * 1_000);
      const recoveredResumeAt = new Date(pauseAt.getTime() + 20 * 60 * 1_000);
      await expect(
        executeServingTransition({
          commandType: "character.serving.pause",
          now: pauseAt,
        }),
        testCase.label,
      ).resolves.toMatchObject({ status: "succeeded" });
      const paused = await prisma.characterServing.findUniqueOrThrow({
        where: { characterId },
      });
      await testCase.mutate();

      const failed = await executeServingTransition({
        commandType: "character.serving.resume",
        now: failedResumeAt,
      });
      const validation = await prisma.releaseValidationRun.findFirstOrThrow({
        where: {
          releaseId: paused.currentReleaseId!,
          startedAt: failedResumeAt,
        },
      });
      const failedChecks = await prisma.releaseCheckResult.findMany({
        where: { validationRunId: validation.id, result: "failed" },
        select: { checkKey: true },
      });
      const pausedAfterFailure = await prisma.characterServing.findUniqueOrThrow({
        where: { characterId },
      });
      const characterAfterFailure = await prisma.character.findUniqueOrThrow({
        where: { id: characterId },
      });
      await testCase.restore();
      const recovered = await executeServingTransition({
        commandType: "character.serving.resume",
        now: recoveredResumeAt,
      });

      expect(failed, testCase.label).toMatchObject({
        status: "failed",
        errorCode: "serving_resume_validation_failed",
      });
      expect(validation, testCase.label).toMatchObject({ result: "failed" });
      expect(
        failedChecks.map((check) => check.checkKey),
        testCase.label,
      ).toContain(testCase.expectedBlocker);
      expect(pausedAfterFailure, testCase.label).toMatchObject({
        state: "paused",
        version: paused.version,
        currentReleaseId: paused.currentReleaseId,
      });
      expect(characterAfterFailure, testCase.label).toMatchObject({
        status: "archived",
        visibility: "private",
        imageAssetId: mediaId,
      });
      expect(recovered, testCase.label).toMatchObject({ status: "succeeded" });
      await expect(
        prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
      ).resolves.toMatchObject({ state: "live" });
    }
  });

  it("rejects resume when a paused Serving is orphaned by a soft-deleted Character", async () => {
    await expect(
      executeServingTransition({
        commandType: "character.serving.pause",
        now: new Date("2026-07-24T16:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const servingBeforeResume = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const validationsBefore = await prisma.releaseValidationRun.count({
      where: { releaseId: servingBeforeResume.currentReleaseId! },
    });
    await prisma.character.update({
      where: { id: characterId },
      data: {
        status: "archived",
        deletedAt: new Date("2026-07-24T16:05:00.000Z"),
      },
    });

    const failed = await executeServingTransition({
      commandType: "character.serving.resume",
      now: new Date("2026-07-24T16:10:00.000Z"),
    });
    const pausedAfterFailure = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const validationsAfter = await prisma.releaseValidationRun.count({
      where: { releaseId: servingBeforeResume.currentReleaseId! },
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { deletedAt: null },
    });
    const recovered = await executeServingTransition({
      commandType: "character.serving.resume",
      now: new Date("2026-07-24T16:20:00.000Z"),
    });

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "serving_character_unavailable",
    });
    expect(pausedAfterFailure).toMatchObject({
      state: "paused",
      version: servingBeforeResume.version,
    });
    expect(validationsAfter).toBe(validationsBefore);
    expect(recovered).toMatchObject({ status: "succeeded" });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      deletedAt: null,
      status: "approved",
      visibility: "public",
    });
  });

  it("fails scheduling closed after Serving is retired", async () => {
    await prisma.characterServing.update({
      where: { characterId },
      data: {
        state: "retired",
        scheduledReleaseId: null,
        scheduledAt: null,
        version: { increment: 1 },
      },
    });
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: policyDriftReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: "2026-07-26T00:00:00.000Z",
        reason: "A retired Character must stay retired",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-retired-schedule-worker`,
        now: new Date("2026-07-25T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "serving_not_schedulable",
    });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      state: "retired",
      scheduledReleaseId: null,
      scheduledAt: null,
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", version: { increment: 1 } },
    });
  });

  it("fails a due publish closed when current policy evidence drifted after scheduling", async () => {
    const scheduledAt = new Date("2026-07-26T00:00:00.000Z");
    const servingBefore = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: policyDriftReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: scheduledAt.toISOString(),
        reason: "Schedule before policy evidence drifts",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-policy-schedule-worker`,
        now: new Date("2026-07-25T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await prisma.generationRouteQualification.updateMany({
      where: { routeFingerprint, policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
      data: { expiresAt: new Date("2026-07-25T12:00:00.000Z") },
    });

    const dueAt = new Date("2026-07-26T00:00:00.000Z");
    const dispatched = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-policy-drift-scheduler`,
      environment: "test",
      now: dueAt,
    });
    await drainAdminCommands(prisma, {
      workerId: `${prefix}-policy-drift-worker`,
      environment: "test",
      now: dueAt,
    });
    expect(dispatched).toMatchObject({ accepted: 1, replayed: 0 });
    expect(
      await prisma.controlPlaneCommand.findUnique({
        where: { id: dispatched.commands[0]!.commandId },
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "release_validation_failed" }),
    });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      currentReleaseId: servingBefore.currentReleaseId,
      scheduledReleaseId: policyDriftReleaseId,
      scheduledAt,
    });
    expect(
      await prisma.releaseValidationRun.findFirst({
        where: { releaseId: policyDriftReleaseId },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ).toMatchObject({
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "failed",
    });
  });
});
