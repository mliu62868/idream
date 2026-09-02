import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  characterWorkspaceDetailSchema,
  collaborationActivityListResponseSchema,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { POST as refreshReleaseMonitor } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/monitors/[window]/refresh/route";
import { GET as listActivityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import { PATCH as patchCharacterProjectRoute } from "@/app/api/v2/admin/characters/[id]/project/route";
import { GET as getCharacterWorkspaceRoute } from "@/app/api/v2/admin/characters/[id]/route";
import { getCharacterWorkspace } from "./workspace";
import { updateCharacterProjectDraft } from "./project-draft";
import {
  CHARACTER_RELEASE_POLICY_VERSION,
  evaluateCharacterReleaseSnapshot,
} from "./release-validation";
import { env } from "@/server/lib/env";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { characterCommandCoordinationKey } from "./command-coordination";
import { CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA } from "./image-qualification";

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
    references: [
      {
        mediaAssetId: previewAssetId,
        position: 0,
        role: "identity_anchor",
        weight: 1,
      },
    ],
  });

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: readOnlyActorId,
        email: `${readOnlyActorId}@example.test`,
        role: "user",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: previewAssetId,
        ownerId: readOnlyActorId,
        type: "image",
        url: previewAssetUrl,
        visibility: "unlisted",
        safetyStatus: "passed",
        metadata: {},
      },
    });
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
        reason:
          "Verify composite workspace requires every exposed authority permission",
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
        advancedDetails: {
          firstMessage: "You made it. What do you need to put down tonight?",
        },
      },
    });
    await prisma.mediaAsset.update({
      where: { id: previewAssetId },
      data: { characterId },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        draftImageAssetId: previewAssetId,
        draftAssetPack: {
          character_cover: {
            assetId: previewAssetId,
            runId: `workspace-run-${suffix}`,
            itemId: `workspace-item-${suffix}`,
            reviewDecisionId: `workspace-review-${suffix}`,
            generationJobId: `workspace-job-${suffix}`,
            bootstrapIdentity: false,
          },
        },
        activeKey: `workspace:${suffix}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `workspace-hash-${suffix}`,
        personaSnapshot: {
          name: "Mara",
          description: "A precise, grounded evening companion.",
        },
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
        generationProvenance: {
          schemaVersion: "character-release-editorial-import-v1",
          dataset: "workspace-fixture",
          recordId: characterId,
          sourceAssetId: previewAssetId,
        },
        releasePlacementManifest: {
          schemaVersion: 1,
          kind: "editorial_import",
          placements: [
            {
              slotKey: "character_avatar",
              assetId: previewAssetId,
              slotVersion: 1,
            },
          ],
        },
        snapshotHash: `workspace-snapshot-${suffix}`,
        readiness: "blocked",
        legacy: true,
        status: "draft",
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `workspace-serving-${suffix}`,
        characterId,
        state: "inactive",
      },
    });
    const visualProfile = await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "same adult character",
        faceTraits: { eyes: "brown" },
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [previewAssetId],
        adapterRefs: {},
        evidenceState: "candidate",
        createdFrom: "workspace_test",
      },
    });
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: {
        immutableHash: characterVisualProfileSnapshotHash(visualProfile),
      },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "workspace-v1",
        snapshotHash: referenceSnapshotHash,
        createdFrom: "workspace_test",
        references: {
          create: {
            mediaAssetId: previewAssetId,
            position: 0,
            role: "identity_anchor",
            selectionReason: "workspace fixture",
          },
        },
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: generationProfileId,
        profileKey: generationProfileKey,
        label: "Workspace identity route",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        status: "active",
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: qualificationId,
        routeFingerprint: `workspace-route-${suffix}`,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `workspace-matrix-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.95,
        result: "qualified",
        evidence: {
          reviewerId: readOnlyActorId,
          batchIds: ["batch-1"],
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({
      where: { coordinationKey: characterCommandCoordinationKey(characterId) },
    });
    await prisma.adminUserPermission.deleteMany({
      where: { userId: readOnlyActorId },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: projectId },
    });
    await prisma.adminCollaborationActivity.deleteMany({
      where: { targetId: projectId },
    });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: projectId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.generationRouteQualification.deleteMany({
      where: { id: qualificationId },
    });
    await prisma.generationModelProfile.deleteMany({
      where: { id: generationProfileId },
    });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: referenceSetId },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { id: referenceSetId },
    });
    await prisma.characterVisualProfile.deleteMany({
      where: { id: visualProfileId },
    });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: previewAssetId } });
    await prisma.user.deleteMany({ where: { id: readOnlyActorId } });
    await prisma.$disconnect();
  });

  it("returns a truthful draft preview and incomplete release evidence", async () => {
    const detail = characterWorkspaceDetailSchema.parse(
      await getCharacterWorkspace(characterId),
    );
    expect(detail.activeCommand).toBeNull();
    expect(detail.visual.videoGenerationEstimate).toMatchObject({
      profileKey: "profile_video_beta_v1",
      estimatedCostDreamcoins: 100,
      completedSampleCount: expect.any(Number),
      windowDays: 7,
    });
    expect(detail.voice).toMatchObject({
      provider: "mock",
      cloningAvailable: false,
      runtimeStatus: "inactive",
      activeProfile: null,
      history: [],
    });
    expect(detail.preview).toMatchObject({
      live: null,
      draft: {
        label: "Draft Preview",
        contentVersionId: contentId,
        releaseId,
        imageUrl: previewAssetUrl,
        assetPack: {
          character_cover: {
            assetId: previewAssetId,
            imageUrl: previewAssetUrl,
            status: "available",
          },
          character_hero: {
            assetId: null,
            imageUrl: null,
            status: "missing",
          },
          character_chat: {
            assetId: null,
            imageUrl: null,
            status: "missing",
          },
        },
        assetPackReady: false,
        renderUrl: null,
      },
      changedFields: ["new_release"],
    });
    expect(detail.project).toMatchObject({
      draftAssetPackHash: canonicalSha256({
        character_cover: {
          assetId: previewAssetId,
          runId: `workspace-run-${suffix}`,
          itemId: `workspace-item-${suffix}`,
          reviewDecisionId: `workspace-review-${suffix}`,
          generationJobId: `workspace-job-${suffix}`,
          bootstrapIdentity: false,
        },
      }),
      draftAssetPack: { character_cover: previewAssetId },
      draftAssetSelections: {
        character_cover: {
          assetId: previewAssetId,
          runId: `workspace-run-${suffix}`,
          itemId: `workspace-item-${suffix}`,
          reviewDecisionId: `workspace-review-${suffix}`,
          generationJobId: `workspace-job-${suffix}`,
          bootstrapIdentity: false,
        },
      },
    });
    expect(detail.releases[0]).toMatchObject({
      release: { readiness: "blocked" },
      checks: [],
      monitors: [],
    });
    expect(detail.visual).toMatchObject({
      activeIdentity: {
        id: visualProfileId,
        version: 1,
        evidenceState: "candidate",
        anchorAssetIds: [previewAssetId],
      },
      anchors: [{ mediaAssetId: previewAssetId, available: true }],
      activeReferenceSet: {
        id: referenceSetId,
        revision: 1,
        references: [{ mediaAssetId: previewAssetId, available: true }],
      },
      routeQualifications: [
        {
          id: qualificationId,
          result: "qualified",
          stale: false,
          sampleCount: 40,
          identityContract: {
            maxReferences: 1,
            acceptedRoles: [
              "identity_anchor",
              "identity_reference",
              "source_image",
            ],
            supportsSourceImageWithIdentity: false,
          },
          profileCapabilities: {
            referenceImages: true,
            initImage: true,
          },
          sourceVariationAuthority: {
            routeFingerprint: `workspace-route-${suffix}`,
            ready: false,
            blocker: "workflow_source_identity_combination_unsupported",
          },
        },
      ],
      readiness: {
        ready: true,
        blockers: [],
        productionDeepLink: `/admin/characters/${characterId}?tab=assets`,
      },
    });
  });

  it("accepts exact reviewed operator-upload pins without generation lineage", async () => {
    const assetIds = [
      `workspace-upload-cover-${suffix}`,
      `workspace-upload-hero-${suffix}`,
      `workspace-upload-chat-${suffix}`,
    ] as const;
    const reviewIds = assetIds.map((assetId) => `review-${assetId}`);
    const digest = "b".repeat(64);
    const profile = await prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: visualProfileId },
      select: { immutableHash: true },
    });
    if (!profile.immutableHash) throw new Error("Visual profile fixture is not sealed");

    await prisma.mediaAsset.createMany({
      data: assetIds.map((assetId) => ({
        id: assetId,
        ownerId: readOnlyActorId,
        characterId,
        type: "image" as const,
        url: `/user-content/${assetId}/content.webp`,
        storageKey: `test-fixtures/${assetId}.webp`,
        visibility: "unlisted",
        safetyStatus: "passed" as const,
        metadata: {
          source: "admin_asset_upload",
          sha256: digest,
          uploadAuthority: {
            schemaVersion: "platform-asset-operator-upload-v1",
            kind: "operator_upload",
            assetId,
            uploadedById: readOnlyActorId,
            sha256: digest,
          },
          platformAsset: {
            purpose: "character_library",
            status: "draft",
          },
        },
      })),
    });
    await prisma.creativeReviewDecision.createMany({
      data: assetIds.map((assetId, index) => ({
        id: reviewIds[index]!,
        runItemId: null,
        artifactId: assetId,
        decision: "approved",
        identityConsistency: "passed",
        score: 96,
        reason: "Reviewed against the exact sealed Character identity.",
        reviewerId: readOnlyActorId,
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          characterImageImport: {
            schemaVersion: CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
            source: "operator_upload",
            characterId,
            assetId,
            visualProfileId,
            visualProfileVersion: 1,
            visualProfileHash: profile.immutableHash,
            referenceSetRevisionId: referenceSetId,
            referenceSetSnapshotHash: referenceSnapshotHash,
          },
        },
      })),
    });

    try {
      const generationProvenance = {
        schemaVersion: "character-release-generation-provenance-v2",
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        requiredReleaseRoute: {
          routeFingerprint: `workspace-route-${suffix}`,
          matrixKey: `workspace-matrix-${suffix}`,
          generationProfileKey,
          generationProfileVersion: 1,
          workflowKey: "qwen-image-edit-img2img",
          workflowVersion: 1,
        },
      };
      const releasePlacementManifest = {
        schemaVersion: 2,
        placements: [
          {
            slotKey: "character_avatar",
            slotVersion: 1,
            assetId: assetIds[0],
            reviewDecisionId: reviewIds[0],
          },
          {
            slotKey: "character_hero",
            slotVersion: 1,
            assetId: assetIds[1],
            reviewDecisionId: reviewIds[1],
          },
          {
            slotKey: "character_chat",
            slotVersion: 1,
            assetId: assetIds[2],
            reviewDecisionId: reviewIds[2],
          },
        ],
      };
      const snapshotFields = {
        projectId,
        revisionId,
        characterContentVersionId: contentId,
        visualProfileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: referenceSetId,
        generationProvenance,
        releasePlacementManifest,
      };
      const evaluation = await prisma.$transaction((tx) =>
        evaluateCharacterReleaseSnapshot(
          tx,
          {
            ...snapshotFields,
            snapshotHash: characterReleaseSnapshotHash(snapshotFields),
            legacy: false,
            rollbackOfReleaseId: null,
          },
          CHARACTER_RELEASE_POLICY_VERSION,
          new Date(),
        )
      );
      const checks = new Map(evaluation.checks.map((check) => [check.key, check]));

      expect(checks.get("release_assets_customer_publishable")?.passed).toBe(true);
      expect(checks.get("release_asset_review_authority")?.passed).toBe(true);
      expect(checks.get("release_asset_generation_authority")?.passed).toBe(true);
    } finally {
      await prisma.creativeReviewDecision.deleteMany({
        where: { id: { in: reviewIds } },
      });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: [...assetIds] } } });
    }
  });

  it("discovers the latest active command for the character authority only", async () => {
    const commandId = `workspace-command-${suffix}`;
    await prisma.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope: `test:${readOnlyActorId}`,
        idempotencyKey: `workspace-command-${suffix}`,
        coordinationKey: characterCommandCoordinationKey(characterId),
        commandType: "character.release.publish",
        targetType: "character_release",
        targetId: releaseId,
        actorId: readOnlyActorId,
        requestId,
        requestHash: canonicalSha256({ commandId }),
        requestPayload: {},
        retryMode: "idempotent",
        status: "verifying",
      },
    });
    try {
      const active = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(characterId),
      );
      expect(active.activeCommand).toMatchObject({
        commandId,
        requestId,
        commandType: "character.release.publish",
        target: { type: "character_release", id: releaseId },
        status: "verifying",
        verificationState: "verifying",
        needsReconciliation: false,
      });

      await prisma.controlPlaneCommand.update({
        where: { id: commandId },
        data: { status: "succeeded", finishedAt: new Date() },
      });
      const terminal = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(characterId),
      );
      expect(terminal.activeCommand).toBeNull();
    } finally {
      await prisma.controlPlaneCommand.deleteMany({ where: { id: commandId } });
    }
  });

  it("always projects the current qualified route even after newer failed evidence exceeds the history page", async () => {
    const noisyQualificationIds = Array.from(
      { length: 21 },
      (_, index) => `workspace-noisy-qualification-${index}-${suffix}`,
    );
    await prisma.generationRouteQualification.createMany({
      data: noisyQualificationIds.map((id, index) => ({
        id,
        routeFingerprint: `workspace-noisy-route-${index}-${suffix}`,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `workspace-noisy-matrix-${index}-${suffix}`,
        sampleCount: 40,
        passCount: 12,
        identityMatch: 0.4,
        result: "candidate",
        evidence: {
          reviewerId: readOnlyActorId,
          batchIds: [`noisy-batch-${index}`],
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(Date.now() + index + 1_000),
      })),
    });
    try {
      const detail = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(characterId),
      );
      expect(detail.visual.readiness).toMatchObject({ ready: true });
      expect(detail.visual.routeQualifications[0]).toMatchObject({
        id: qualificationId,
        result: "qualified",
        stale: false,
        identityContract: {
          acceptedRoles: expect.arrayContaining(["identity_anchor"]),
        },
      });
      expect(detail.visual.routeQualifications).toHaveLength(21);
    } finally {
      await prisma.generationRouteQualification.deleteMany({
        where: { id: { in: noisyQualificationIds } },
      });
    }
  });

  it("projects Release lineage, checks, and every monitor window without lossy remapping", async () => {
    const validationRunId = `workspace-validation-${suffix}`;
    const reviewDecisionId = `workspace-lineage-review-${suffix}`;
    const generationJobId = `workspace-lineage-job-${suffix}`;
    const runId = `workspace-lineage-run-${suffix}`;
    const itemId = `workspace-lineage-item-${suffix}`;
    const originalRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
      select: {
        generationProvenance: true,
        releasePlacementManifest: true,
      },
    });
    const generationProvenance = {
      schemaVersion: "character-release-editorial-import-v1",
      dataset: "workspace-fixture",
      recordId: characterId,
      sourceAssetId: previewAssetId,
      releasePreflight: { mode: "automatic" },
      placements: [
        {
          slotKey: "character_avatar",
          assetId: previewAssetId,
          runId,
          itemId,
          reviewDecisionId,
          generationJobId,
        },
      ],
    };
    const releasePlacementManifest = {
      schemaVersion: 1,
      kind: "editorial_import",
      placements: [
        {
          slotKey: "character_avatar",
          assetId: previewAssetId,
          slotVersion: 1,
          runId,
          itemId,
          reviewDecisionId,
          generationJobId,
        },
      ],
    };
    await prisma.releaseValidationRun.create({
      data: {
        id: validationRunId,
        releaseId,
        snapshotHash: `workspace-snapshot-${suffix}`,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        result: "passed",
        finishedAt: new Date(),
      },
    });
    await prisma.releaseCheckResult.create({
      data: {
        id: `workspace-check-${suffix}`,
        validationRunId,
        checkKey: "release_asset_lineage",
        result: "passed",
        evidence: {
          runId,
          itemId,
          reviewDecisionId,
          generationJobId,
        },
      },
    });
    await prisma.releaseMonitor.createMany({
      data: [
        {
          id: `workspace-monitor-route-${suffix}`,
          releaseId,
          window: "route_qualification",
          status: "action_required",
          baseline: { policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
          observed: {
            routeFingerprint: `workspace-route-${suffix}`,
            qualification: "expired",
          },
          verification: { recommendation: "refresh_route_qualification" },
          finishedAt: new Date(),
        },
        {
          id: `workspace-monitor-24h-${suffix}`,
          releaseId,
          window: "24h",
          status: "monitoring",
          baseline: { conversations: 10 },
          observed: { conversations: 12 },
          verification: { recommendation: "continue_monitoring" },
        },
        {
          id: `workspace-monitor-custom-${suffix}`,
          releaseId,
          window: "7d_custom",
          status: "passed",
          baseline: { retention: 0.2 },
          observed: { retention: 0.24 },
          verification: { recommendation: "keep_live" },
          finishedAt: new Date(),
        },
      ],
    });
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { generationProvenance, releasePlacementManifest },
    });
    try {
      const detail = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(characterId),
      );
      const projectedRelease = detail.releases.find(
        ({ release }) => release.id === releaseId,
      );
      expect(projectedRelease?.release).toMatchObject({
        generationProvenance,
        releasePlacementManifest,
      });
      expect(projectedRelease?.checks).toEqual([
        expect.objectContaining({
          checkKey: "release_asset_lineage",
          result: "passed",
          evidence: {
            runId,
            itemId,
            reviewDecisionId,
            generationJobId,
          },
        }),
      ]);
      expect(projectedRelease?.monitors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            window: "route_qualification",
            status: "action_required",
            observed: {
              routeFingerprint: `workspace-route-${suffix}`,
              qualification: "expired",
            },
            verification: { recommendation: "refresh_route_qualification" },
          }),
          expect.objectContaining({
            window: "24h",
            status: "monitoring",
            observed: { conversations: 12 },
            verification: { recommendation: "continue_monitoring" },
          }),
          expect.objectContaining({
            window: "7d_custom",
            status: "passed",
            observed: { retention: 0.24 },
            verification: { recommendation: "keep_live" },
          }),
        ]),
      );
    } finally {
      await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
      await prisma.releaseCheckResult.deleteMany({
        where: { validationRunId },
      });
      await prisma.releaseValidationRun.deleteMany({
        where: { id: validationRunId },
      });
      await prisma.characterRelease.update({
        where: { id: releaseId },
        data: {
          generationProvenance: toInputJson(
            originalRelease.generationProvenance,
          ),
          releasePlacementManifest: toInputJson(
            originalRelease.releasePlacementManifest,
          ),
        },
      });
    }
  });

  it("keeps selected assets valid and re-resolves a compatible generation route when reference capacity changes", async () => {
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { faceTraits: {} },
    });
    let detail = characterWorkspaceDetailSchema.parse(
      await getCharacterWorkspace(characterId),
    );
    expect(detail.visual.readiness).toMatchObject({ ready: false });
    expect(
      detail.visual.readiness.blockers.map((blocker) => blocker.code),
    ).toContain("visual_traits_incomplete");
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { faceTraits: { eyes: "brown" } },
    });

    // 密封漂移是发布级问题，不再拦打磨：生图闸（visual.readiness）放行，
    // readiness.ts 仍会在发布链上产出 reference_set_unsealed。
    await prisma.referenceSetRevision.update({
      where: { id: referenceSetId },
      data: { snapshotHash: "drifted-reference-hash" },
    });
    detail = characterWorkspaceDetailSchema.parse(
      await getCharacterWorkspace(characterId),
    );
    expect(
      detail.visual.readiness.blockers.map((blocker) => blocker.code),
    ).not.toContain("reference_set_unsealed");
    await prisma.referenceSetRevision.update({
      where: { id: referenceSetId },
      data: { snapshotHash: referenceSnapshotHash },
    });

    const secondaryReferenceAssetId = `workspace-secondary-reference-${suffix}`;
    const secondaryReference = {
      mediaAssetId: secondaryReferenceAssetId,
      position: 1,
      role: "identity_reference",
      weight: 0.8,
    };
    const originalProfile =
      await prisma.characterVisualProfile.findUniqueOrThrow({
        where: { id: visualProfileId },
      });
    await prisma.mediaAsset.create({
      data: {
        id: secondaryReferenceAssetId,
        ownerId: readOnlyActorId,
        characterId,
        type: "image",
        url: `/user-content/${secondaryReferenceAssetId}/content.webp`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const twoReferenceSnapshotHash = referenceSetSnapshotHash({
      visualProfileId,
      revision: 1,
      selectorVersion: "workspace-v1",
      references: [
        {
          mediaAssetId: previewAssetId,
          position: 0,
          role: "identity_anchor",
          weight: 1,
        },
        secondaryReference,
      ],
    });
    try {
      // 参考集的唯一权威是 ReferenceSetRevision：加一张参考图只需建 snapshot + 更新 revision 的
      // snapshotHash，profile 本身既无副本列可写、密封 hash 也不含参考图，因此完全不用动。
      await prisma.characterVisualReferenceSnapshot.create({
        data: {
          referenceSetRevisionId: referenceSetId,
          ...secondaryReference,
          selectorVersion: "workspace-v1",
          selectionReason: "Partial drift regression fixture",
        },
      });
      await prisma.referenceSetRevision.update({
        where: { id: referenceSetId },
        data: { snapshotHash: twoReferenceSnapshotHash },
      });
      detail = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(characterId),
      );
      expect(detail.visual.activeReferenceSet?.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mediaAssetId: previewAssetId,
            available: true,
          }),
          expect.objectContaining({
            mediaAssetId: secondaryReferenceAssetId,
            available: true,
          }),
        ]),
      );
      expect(detail.visual.readiness).toMatchObject({ ready: true });
      expect(detail.visual.imageReadiness?.state).toBe("ready");
      expect(detail.visual.routeQualifications[0]).toMatchObject({
        result: "qualified",
        matrixKey: "operator-single-image-v1",
        stale: false,
      });
      expect(
        detail.visual.routeQualifications.find(
          (route) => route.id === qualificationId,
        ),
      ).toMatchObject({
        stale: true,
        identityContract: { maxReferences: 1 },
        profileCapabilities: {
          referenceImages: true,
          initImage: true,
        },
      });
      expect(detail.project.draftAssetRouteAuthority).toMatchObject({
        status: "current",
        currentRouteFingerprint: expect.any(String),
        releaseReady: false,
      });

      await prisma.mediaAsset.update({
        where: { id: secondaryReferenceAssetId },
        data: { safetyStatus: "blocked" },
      });
      detail = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(characterId),
      );
      expect(detail.visual.activeReferenceSet?.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mediaAssetId: previewAssetId,
            available: true,
          }),
          expect.objectContaining({
            mediaAssetId: secondaryReferenceAssetId,
            available: false,
          }),
        ]),
      );
      expect(detail.visual.readiness).toMatchObject({ ready: false });
      expect(
        detail.visual.readiness.blockers.map((blocker) => blocker.code),
      ).toContain("reference_assets_unavailable");
    } finally {
      await prisma.characterVisualReferenceSnapshot.deleteMany({
        where: {
          referenceSetRevisionId: referenceSetId,
          mediaAssetId: secondaryReferenceAssetId,
        },
      });
      await prisma.referenceSetRevision.update({
        where: { id: referenceSetId },
        data: { snapshotHash: referenceSnapshotHash },
      });
      await prisma.characterVisualProfile.update({
        where: { id: visualProfileId },
        data: {
          immutableHash: originalProfile.immutableHash,
        },
      });
      await prisma.mediaAsset.delete({
        where: { id: secondaryReferenceAssetId },
      });
    }

    await prisma.generationModelProfile.update({
      where: { id: generationProfileId },
      data: { status: "archived" },
    });
    detail = characterWorkspaceDetailSchema.parse(
      await getCharacterWorkspace(characterId),
    );
    expect(
      detail.visual.readiness.blockers.map((blocker) => blocker.code),
    ).not.toContain("generation_route_unqualified");
    expect(
      detail.visual.routeQualifications.find(
        (route) => route.id === qualificationId,
      ),
    ).toMatchObject({ id: qualificationId, stale: true });
    await prisma.generationModelProfile.update({
      where: { id: generationProfileId },
      data: { status: "active" },
    });

    await prisma.generationRouteQualification.update({
      where: { id: qualificationId },
      data: { evidence: { evaluatorVersion: "retired-evaluator" } },
    });
    detail = characterWorkspaceDetailSchema.parse(
      await getCharacterWorkspace(characterId),
    );
    expect(
      detail.visual.readiness.blockers.map((blocker) => blocker.code),
    ).not.toContain("generation_route_unqualified");
    await prisma.generationRouteQualification.update({
      where: { id: qualificationId },
      data: {
        evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
        workflowVersion: 999,
      },
    });
    detail = characterWorkspaceDetailSchema.parse(
      await getCharacterWorkspace(characterId),
    );
    expect(
      detail.visual.readiness.blockers.map((blocker) => blocker.code),
    ).not.toContain("generation_route_unqualified");
    await prisma.generationRouteQualification.update({
      where: { id: qualificationId },
      data: { workflowVersion: 1 },
    });
  });

  it("only projects bootstrap profiles that explicitly declare text-to-image capability", async () => {
    const missingCapabilityId = `workspace-bootstrap-missing-${suffix}`;
    const explicitCapabilityId = `workspace-bootstrap-explicit-${suffix}`;
    const bootstrapCharacterId = `workspace-bootstrap-character-${suffix}`;
    const bootstrapProjectId = `workspace-bootstrap-project-${suffix}`;
    const bootstrapContentId = `workspace-bootstrap-content-${suffix}`;
    await prisma.character.create({
      data: {
        id: bootstrapCharacterId,
        name: "Blank Bootstrap Character",
        age: 27,
        description: "Needs a reviewed first portrait.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: bootstrapProjectId,
        characterId: bootstrapCharacterId,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: bootstrapContentId,
        characterId: bootstrapCharacterId,
        version: 1,
        contentHash: `workspace-bootstrap-content-hash-${suffix}`,
        personaSnapshot: {},
        openingSnapshot: {},
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    try {
      await prisma.generationModelProfile.createMany({
        data: [
          {
            id: missingCapabilityId,
            profileKey: `000-missing-bootstrap-${suffix}`,
            label: "Missing explicit bootstrap capability",
            runner: "comfyui",
            pipelineModel: "redcraft-krea2-redmix3-txt2img",
            workflowKey: "redcraft-krea2-redmix3-txt2img",
            runnerConfig: { capabilities: {} },
            allowedOrientations: ["4:5"],
            status: "active",
            enabled: true,
            rolloutPercent: 100,
          },
          {
            id: explicitCapabilityId,
            profileKey: `001-explicit-bootstrap-${suffix}`,
            label: "Explicit bootstrap capability",
            runner: "comfyui",
            pipelineModel: "redcraft-krea2-redmix3-txt2img",
            workflowKey: "redcraft-krea2-redmix3-txt2img",
            runnerConfig: { capabilities: { textToImage: true } },
            allowedOrientations: ["4:5"],
            status: "active",
            enabled: true,
            rolloutPercent: 100,
          },
        ],
      });
      let detail = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(bootstrapCharacterId),
      );
      expect(detail.visual.identityBootstrap.profile?.profileKey).toBe(
        `001-explicit-bootstrap-${suffix}`,
      );
      expect(detail.visual.identityBootstrap).toMatchObject({
        state: "new",
        allowed: true,
        nextIdentityVersion: 1,
      });

      await prisma.generationModelProfile.update({
        where: { id: explicitCapabilityId },
        data: { status: "archived" },
      });
      detail = characterWorkspaceDetailSchema.parse(
        await getCharacterWorkspace(bootstrapCharacterId),
      );
      expect(detail.visual.identityBootstrap).toMatchObject({
        state: "new",
        allowed: true,
      });
      expect(detail.visual.identityBootstrap.profile?.profileKey).not.toBe(
        `000-missing-bootstrap-${suffix}`,
      );
    } finally {
      await prisma.generationModelProfile.deleteMany({
        where: { id: { in: [missingCapabilityId, explicitCapabilityId] } },
      });
      await prisma.characterContentVersion.deleteMany({
        where: { id: bootstrapContentId },
      });
      await prisma.characterProject.deleteMany({
        where: { id: bootstrapProjectId },
      });
      await prisma.character.deleteMany({
        where: { id: bootstrapCharacterId },
      });
    }
  });

  it("autosaves with optimistic concurrency and writes audit/outbox atomically", async () => {
    const saved = await updateCharacterProjectDraft({
      characterId,
      expectedVersion: 1,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      content: {
        persona: {
          name: "Mara V2",
          age: 29,
          gender: "female",
          characterPromise: "A precise place to put the day down",
          detailsMarkdown:
            "Observant and gently challenging. Warm and concise. A night-shift radio host.",
          firstMessage: "Tell me what followed you home.",
        },
        visualDirection: {
          identityAnchor: "Composed late-night radio host",
          stableTraits: ["dark wavy hair", "warm brown eyes"],
          style: "realistic",
          referenceDirection: "Intimate tungsten editorial portrait",
        },
      },
      reason: "Autosave Character draft changes",
      requestId,
    });
    expect(saved).toMatchObject({ version: 2 });
    expect(await prisma.adminAuditLog.count({ where: { requestId } })).toBe(1);
    expect(
      await prisma.mainOutboxEvent.count({ where: { aggregateId: projectId } }),
    ).toBe(1);
    expect(
      await prisma.characterContentVersion.findMany({ where: { characterId } }),
    ).toHaveLength(2);
    expect(
      await prisma.characterRevision.findMany({ where: { projectId } }),
    ).toHaveLength(2);
    expect(
      await prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).toMatchObject({
      name: "Mara",
      age: 28,
    });
    const activityResponse = await listActivityRoute(
      new Request(
        `http://localhost/api/v2/admin/collaboration/character_project/${projectId}/activity`,
        {
          headers: {
            "x-idream-user-id": readOnlyActorId,
            "x-idream-role": "user",
          },
        },
      ),
      {
        params: Promise.resolve({
          targetType: "character_project",
          targetId: projectId,
        }),
      },
    );
    expect(activityResponse.status).toBe(200);
    const activityPayload = await activityResponse.json();
    const activity = collaborationActivityListResponseSchema.parse(
      activityPayload.data,
    ).items[0];
    expect(activity).toMatchObject({
      targetId: projectId,
      kind: "draft_saved",
    });

    await prisma.character.update({
      where: { id: characterId },
      data: { status: "approved", visibility: "public" },
    });
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { status: "published" },
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", currentReleaseId: releaseId },
    });
    const liveCandidate = await updateCharacterProjectDraft({
      characterId,
      expectedVersion: 2,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      content: {
        persona: {
          name: "Unpublished Mara Candidate",
          age: 30,
          gender: "female",
          characterPromise: "A sharper unpublished promise",
          detailsMarkdown:
            "Observant and direct. Warm and precise. A revised draft backstory.",
          firstMessage: "This opening is not live yet.",
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
    expect(
      await prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).toMatchObject({
      name: "Mara",
      age: 28,
      status: "approved",
      visibility: "public",
    });
    expect(
      await prisma.characterContentVersion.findMany({ where: { characterId } }),
    ).toHaveLength(3);
    expect(
      await prisma.characterRevision.findMany({ where: { projectId } }),
    ).toHaveLength(3);

    await expect(
      updateCharacterProjectDraft({
        characterId,
        expectedVersion: 1,
        actor: { id: `workspace-actor-${suffix}`, role: "admin" },
        reason: "Stale tab save",
        requestId: `${requestId}-conflict`,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.characterProject.findUniqueOrThrow({
        where: { id: projectId },
      }),
    ).toMatchObject({
      version: 3,
    });
  });

  it("rejects project PATCH without write authority and mismatched If-Match", async () => {
    const body = {
      entityVersion: 3,
      content: {
        persona: {
          name: "Mara",
          age: 28,
          gender: "female",
          characterPromise: "A precise, grounded evening companion.",
          detailsMarkdown: "",
          firstMessage: "You made it.",
        },
        visualDirection: {
          identityAnchor: "Composed late-night radio host",
          stableTraits: ["dark wavy hair"],
          style: "realistic",
          referenceDirection: "Warm studio portrait",
        },
      },
      reason: "Verify the Project PATCH boundary",
    };
    const forbidden = await patchCharacterProjectRoute(
      new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/project`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": "3",
            "x-idream-user-id": readOnlyActorId,
            "x-idream-role": "user",
          },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(forbidden.status).toBe(403);

    const missingPrecondition = await patchCharacterProjectRoute(
      new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/project`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": "seed-admin-user",
            "x-idream-role": "admin",
          },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(missingPrecondition.status).toBe(400);

    const mismatched = await patchCharacterProjectRoute(
      new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/project`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": "2",
            "x-idream-user-id": "seed-admin-user",
            "x-idream-role": "admin",
          },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(mismatched.status).toBe(400);
  });

  it("does not let a read-only release grant refresh monitor authority", async () => {
    const response = await refreshReleaseMonitor(
      new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/releases/${releaseId}/monitors/24h/refresh`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": readOnlyActorId,
            "x-idream-role": "user",
          },
          body: JSON.stringify({ entityVersion: 1 }),
        },
      ),
      {
        params: Promise.resolve({ id: characterId, releaseId, window: "24h" }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("does not expose Release, Monitor, or Performance DTOs through project-only access", async () => {
    const response = await getCharacterWorkspaceRoute(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}`, {
        headers: {
          "x-idream-user-id": readOnlyActorId,
          "x-idream-role": "user",
        },
      }),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(response.status).toBe(403);
  });
});
