import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";
import { evaluateEffectiveGenerationRouteAuthority } from "@/server/modules/admin-v2/characters/generation-route-authority";
import { createCharacterVisualProfile } from "@/server/modules/admin/characters/visual-profiles";
import { publishCharacterReferenceSet } from "@/server/modules/admin-v2/characters/reference-set";
import {
  lockCharacterGenerationAuthority,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { patchContentAsset } from "@/server/modules/admin/content-ops";
import { purgeQueuedGenerationJobs } from "@/server/test/helpers";
import {
  getCreativeRunDetail,
  recordCreativeReviewDecision,
} from "./workflow";

const { multiReferenceWorkflowKey } = vi.hoisted(() => ({
  multiReferenceWorkflowKey: "test-qwen-image-edit-multi-reference",
}));

vi.mock("@/server/modules/generation/generation-catalog", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/server/modules/generation/generation-catalog")
  >();
  return {
    ...actual,
    generationWorkflowDescriptor: async (workflowKey: string) => {
      const descriptor = await actual.generationWorkflowDescriptor(
        workflowKey === multiReferenceWorkflowKey
          ? "qwen-image-edit-img2img"
          : workflowKey,
      );
      if (
        !descriptor ||
        workflowKey !== multiReferenceWorkflowKey ||
        descriptor.backendKind !== "comfyui"
      ) {
        return descriptor;
      }
      return {
        ...descriptor,
        workflowKey: multiReferenceWorkflowKey,
        apiPrompt: {
          ...descriptor.apiPrompt,
          "900000": {
            class_type: "LoadImage",
            inputs: { image: "" },
          },
        },
        inputs: [
          ...descriptor.inputs.map((slot) =>
            slot.type === "image"
              ? {
                  ...slot,
                  referenceRoles: ["source_image"] as const,
                }
              : slot
          ),
          {
            key: "identity_image",
            type: "image" as const,
            referenceRoles: [
              "identity_anchor",
              "identity_reference",
            ] as const,
            target: { nodeId: "900000", field: "image" },
          },
        ],
        identity: {
          ...descriptor.identity,
          mode: "multi_reference" as const,
          maxReferences: 2,
          acceptedRoles: [
            "identity_anchor",
            "identity_reference",
            "source_image",
          ] as const,
          supportsSourceImageWithIdentity: true,
        },
      };
    },
  };
});

describe("Character image Creative Run authority", () => {
  const suffix = randomUUID();
  const actorId = `character-image-create-${suffix}`;
  const characterId = `character-image-create-character-${suffix}`;
  const projectId = `character-image-create-project-${suffix}`;
  const contentId = `character-image-create-content-${suffix}`;
  const anchorAssetId = `character-image-create-anchor-${suffix}`;
  const profileId = `character-image-create-profile-${suffix}`;
  const profileKey = `character-image-create-qwen-${suffix}`;
  const multiReferenceProfileId =
    `character-image-create-multi-profile-${suffix}`;
  const multiReferenceProfileKey =
    `character-image-create-multi-qwen-${suffix}`;
  const visualProfileId = `character-image-create-visual-${suffix}`;
  const referenceSetId = `character-image-create-reference-set-${suffix}`;
  const multiReferenceQualificationId =
    `character-image-create-multi-qualification-${suffix}`;
  const variationSourceBatchId = `character-image-create-source-run-${suffix}`;
  const variationSourceItemId = `character-image-create-source-item-${suffix}`;
  const variationSourceJobId = `character-image-create-source-job-${suffix}`;
  const variationSourceAssetId = `character-image-create-source-asset-${suffix}`;
  const variationDependentJobId = `character-image-create-dependent-job-${suffix}`;
  const calibrationSourceJobId = `character-image-calibration-source-job-${suffix}`;
  const calibrationSourceAssetId = `character-image-calibration-source-asset-${suffix}`;
  const legacyAssetId = `character-image-create-legacy-asset-${suffix}`;
  const legacyQualificationId = `character-image-create-legacy-qualification-${suffix}`;
  const archiveRaceCharacterId =
    `character-image-create-archive-race-character-${suffix}`;
  const archiveRaceContentId =
    `character-image-create-archive-race-content-${suffix}`;
  const archiveRaceAssetId =
    `character-image-create-archive-race-asset-${suffix}`;
  const archiveRaceVisualProfileId =
    `character-image-create-archive-race-visual-${suffix}`;
  const archiveRaceReferenceSetId =
    `character-image-create-archive-race-reference-set-${suffix}`;
  const archiveRaceQualificationId =
    `character-image-create-archive-race-qualification-${suffix}`;
  const archiveRaceStyle = `archive-race-${suffix}`;
  const batchIds: string[] = [];

  async function cleanupBatches(ids: readonly string[]) {
    const items = await prisma.contentProductionItem.findMany({
      where: { batchId: { in: [...ids] } },
      select: { jobId: true },
    });
    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    await purgeQueuedGenerationJobs(jobIds);
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [...ids] } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attempt: { requestId: { in: jobIds } } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: [...ids] } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: jobIds } },
    });
  }

  function request(payload: Record<string, unknown>, key: string) {
    return new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@idream.internal`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: actorId,
        name: "Legacy character shell",
        age: 28,
        gender: "female",
        style: "realistic",
        description: "A grounded late-night confidante.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "producing",
        audience: {},
        successCriteria: ["Identity remains stable"],
        activeKey: `character-image-create:${characterId}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `character-image-create-content-${suffix}`,
        personaSnapshot: { name: "Mara", description: "A grounded late-night confidante." },
        openingSnapshot: { firstMessage: "What followed you home tonight?" },
        appearanceSnapshot: {
          identityAnchor: "Composed late-night radio host",
          stableTraits: ["dark wavy hair", "warm brown eyes"],
          style: "realistic",
          referenceDirection: "Intimate tungsten editorial portrait",
        },
        sourceType: "character_image_create_test",
        createdById: actorId,
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: profileId,
        profileKey,
        label: "Character identity-preserving edit",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        runnerConfig: {
          workflowVersion: 1,
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        defaultWidth: 832,
        defaultHeight: 1216,
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: multiReferenceProfileId,
        profileKey: multiReferenceProfileKey,
        label: "Character identity plus source-image edit",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: multiReferenceWorkflowKey,
        runnerConfig: {
          workflowVersion: 1,
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        defaultWidth: 832,
        defaultHeight: 1216,
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await cleanupBatches(batchIds);
    await prisma.creativeReviewDecision.deleteMany({
      where: { runItemId: variationSourceItemId },
    });
    await prisma.generationJob.deleteMany({ where: { id: variationDependentJobId } });
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.generationRouteQualification.deleteMany({
      where: {
        OR: [
          {
            id: {
              in: [
                multiReferenceQualificationId,
                archiveRaceQualificationId,
              ],
            },
          },
          {
            matrixKey: "operator-single-image-v1",
            generationProfileKey: profileKey,
          },
        ],
      },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { id: { in: [referenceSetId, archiveRaceReferenceSetId] } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: [variationSourceAssetId, calibrationSourceAssetId] } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: calibrationSourceJobId },
    });
    await prisma.characterVisualProfile.deleteMany({
      where: { id: { in: [visualProfileId, archiveRaceVisualProfileId] } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: [anchorAssetId, archiveRaceAssetId] } },
    });
    await prisma.generationModelProfile.deleteMany({
      where: { id: { in: [profileId, multiReferenceProfileId] } },
    });
    await prisma.characterContentVersion.deleteMany({
      where: { id: { in: [contentId, archiveRaceContentId] } },
    });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({
      where: { id: { in: [characterId, archiveRaceCharacterId] } },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("rejects multi-image Character runs before creating production state", async () => {
    const title = "Mara accidental multi-image run";
    const response = await createCreativeRun(request({
      title,
      purpose: "identity_calibration",
      targetType: "character",
      targetId: characterId,
      profileId: "profile_image_default_v1",
      orientation: "4:5",
      count: 2,
      brief: "This request must be split into individual operator decisions.",
      identityExperiment: {
        mode: "text_to_image",
        negativePrompt: "different person",
        seedStrategy: "random",
        baseSeed: "42",
        strength: 0.65,
      },
      consistencyMode: "balanced",
      priority: "normal",
      reason: "Prove Character production is one image at a time",
    }, `character-single-image-policy-${suffix}`));

    expect(response.status).toBe(400);
    await expect(prisma.contentProductionBatch.count({
      where: { title },
    })).resolves.toBe(0);
  });

  it("creates one reversible text-to-image identity candidate with frozen prompts", async () => {
    const response = await createCreativeRun(request({
      title: "Mara visual identity calibration",
      purpose: "identity_calibration",
      targetType: "character",
      targetId: characterId,
      profileId: "profile_image_default_v1",
      orientation: "4:5",
      count: 1,
      brief: "A definitive adult portrait with warm brown eyes and dark wavy hair.",
      identityExperiment: {
        mode: "text_to_image",
        negativePrompt: "different person, duplicate subject, watermark",
        seedStrategy: "random",
        baseSeed: "184732",
        strength: 0.65,
      },
      consistencyMode: "balanced",
      priority: "normal",
      reason: "Explore identity candidates without changing active authority",
    }, `character-identity-calibration-${suffix}`));
    expect(response.status).toBe(202);
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);
    const jobs = await prisma.generationJob.findMany({
      where: {
        sourceType: "content_production_item",
        sourceMeta: { path: ["batchId"], equals: batchId },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(1);
    expect(new Set(jobs.map((job) => job.seed)).size).toBe(1);
    expect(jobs.every((job) =>
      job.characterId === characterId &&
      job.visualProfileId === null &&
      job.referenceSetRevisionId === null &&
      job.negativePrompt?.includes("different person") === true
    )).toBe(true);
    expect(jobs[0]?.prompt).toBe([
      "Single uninterrupted portrait photograph.",
      "Subject: Mara, an adult 28-year-old female.",
      "Visual style: realistic.",
      "Identity traits: Composed late-night radio host; dark wavy hair; warm brown eyes.",
      "Art direction: Intimate tungsten editorial portrait.",
      "Operator visual brief: A definitive adult portrait with warm brown eyes and dark wavy hair.",
      "Composition: one person centered in one continuous camera frame, with a coherent background and clear subject framing.",
      "Polished reusable portrait photography.",
    ].join("\n"));
    expect(jobs[0]?.prompt).not.toMatch(
      /Production purpose|Recipe:|template|collage|contact sheet|split panel|comparison grid|late-night confidante/i,
    );
    expect(jobs[0]?.controls).toMatchObject({
      compositionRequirement: "single_subject_single_frame",
    });
    expect(jobs[0]?.sourceMeta).toMatchObject({
      identityExperiment: {
        mode: "text_to_image",
        positivePrompt:
          "A definitive adult portrait with warm brown eyes and dark wavy hair.",
        negativePrompt: "different person, duplicate subject, watermark",
        seedStrategy: "random",
        baseSeed: "184732",
        sourceAssetId: null,
        strength: 0.65,
      },
    });
  });

  it("rejects identity candidate approval without the visible quality checklist", async () => {
    const response = await createCreativeRun(request({
      title: "Mara identity review quality gate",
      purpose: "identity_calibration",
      targetType: "character",
      targetId: characterId,
      profileId: "profile_image_default_v1",
      orientation: "4:5",
      count: 1,
      brief: "A clean single-person portrait for identity review.",
      identityExperiment: {
        mode: "text_to_image",
        negativePrompt: "different person, duplicate subject, watermark",
        seedStrategy: "random",
        baseSeed: "184733",
        strength: 0.65,
      },
      consistencyMode: "balanced",
      priority: "normal",
      reason: "Prove identity approval cannot bypass visible image quality checks",
    }, `character-identity-review-quality-${suffix}`));
    expect(response.status).toBe(202);
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);
    const item = await prisma.contentProductionItem.findFirstOrThrow({
      where: { batchId },
      orderBy: { itemIndex: "asc" },
    });
    const batch = await prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { version: true },
    });

    await expect(recordCreativeReviewDecision({
      runId: batchId,
      itemId: item.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: batch.version,
      decision: "approved",
      identityConsistency: "unscored",
      reason: "Attempt to approve identity without reviewing the visible image",
      requestId: `character-identity-review-quality-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      message:
        "Character identity review requires the complete visible quality checklist",
    });

    await expect(recordCreativeReviewDecision({
      runId: batchId,
      itemId: item.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: batch.version,
      decision: "approved",
      identityConsistency: "unscored",
      quality: {
        artifactFree: true,
        singleSubject: false,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "The candidate contains a composite layout",
      requestId: `character-identity-review-single-subject-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      message:
        "A Character identity candidate cannot be approved while a required quality check is failing",
    });

    const job = await prisma.generationJob.findFirstOrThrow({
      where: { sourceType: "content_production_item", sourceId: item.id },
    });
    const assetId = `character-identity-unverified-asset-${suffix}`;
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: actorId,
        characterId,
        sourceJobId: job.id,
        type: "image",
        url: `/assets/${assetId}.png`,
        storageKey: `test-fixtures/${assetId}.png`,
        safetyStatus: "passed",
        metadata: {
          quality: {
            schemaVersion: "1",
            evaluatorVersion: "sanity-v1",
            sanity: { status: "passed" },
          },
        },
      },
    });
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "completed", deliveredOutputCount: 1 },
    });
    await prisma.contentProductionItem.update({
      where: { id: item.id },
      data: { status: "generated", mediaAssetId: assetId },
    });

    await expect(recordCreativeReviewDecision({
      runId: batchId,
      itemId: item.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: batch.version,
      decision: "approved",
      identityConsistency: "unscored",
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "All client-supplied checkboxes claim the image is valid",
      requestId: `character-identity-system-quality-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      message:
        "Character identity approval requires system-verified single-frame evidence",
    });

    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        metadata: {
          quality: {
            schemaVersion: "1",
            evaluatorVersion: "generated-image-sanity-v2",
            sanity: { status: "passed" },
            composition: {
              status: "passed",
              reason: "single_continuous_frame_detected",
            },
          },
        },
      },
    });
    const approved = await recordCreativeReviewDecision({
      runId: batchId,
      itemId: item.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: batch.version,
      decision: "approved",
      identityConsistency: "unscored",
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "The system and reviewer both confirm a valid identity portrait",
      requestId: `character-identity-system-quality-pass-${suffix}`,
    });
    expect(approved).toMatchObject({ decision: "approved" });
    const decision = await prisma.creativeReviewDecision.findUniqueOrThrow({
      where: { id: approved.decisionId },
    });
    expect(decision.evidence).toMatchObject({
      quality: {
        artifactFree: true,
        singleSubject: true,
      },
      automaticComposition: {
        evaluatorVersion: "generated-image-sanity-v2",
        composition: {
          status: "passed",
          reason: "single_continuous_frame_detected",
        },
      },
    });
    const detail = await getCreativeRunDetail({
      runId: batchId,
      actor: { id: actorId, role: "admin" },
    });
    expect(detail.items[0]?.asset?.automaticComposition).toEqual({
      evaluatorVersion: "generated-image-sanity-v2",
      status: "passed",
      reason: "single_continuous_frame_detected",
    });
  });

  it("continues identity calibration from a pinned source image and source seed", async () => {
    await prisma.generationJob.create({
      data: {
        id: calibrationSourceJobId,
        userId: actorId,
        characterId,
        seed: "source-seed-88",
        mode: "image",
        prompt: "Reviewed visual exploration source",
        controls: {},
        presetIds: [],
        outputCount: 1,
        deliveredOutputCount: 1,
        status: "completed",
        provider: "comfyui",
        sourceType: "identity_calibration_fixture",
        sourceId: calibrationSourceJobId,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: calibrationSourceAssetId,
        ownerId: actorId,
        sourceJobId: calibrationSourceJobId,
        characterId,
        type: "image",
        url: `/assets/${calibrationSourceAssetId}.webp`,
        storageKey: `test-fixtures/${calibrationSourceAssetId}.webp`,
        safetyStatus: "passed",
        metadata: { platformAsset: { status: "generated" } },
      },
    });
    const response = await createCreativeRun(request({
      title: "Mara image-to-image identity calibration",
      purpose: "identity_calibration",
      targetType: "character",
      targetId: characterId,
      profileId: profileKey,
      orientation: "4:5",
      count: 1,
      brief: "Keep the same adult face while refining the expression and hair silhouette.",
      identityExperiment: {
        mode: "image_to_image",
        negativePrompt: "different person, duplicate subject, watermark",
        seedStrategy: "reuse_source",
        sourceAssetId: calibrationSourceAssetId,
        strength: 0.55,
      },
      consistencyMode: "balanced",
      priority: "normal",
      reason: "Continue a reversible identity calibration from the selected source",
    }, `character-identity-calibration-img2img-${suffix}`));
    expect(response.status).toBe(202);
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);
    const jobs = await prisma.generationJob.findMany({
      where: {
        sourceType: "content_production_item",
        sourceMeta: { path: ["batchId"], equals: batchId },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(1);
    expect(new Set(jobs.map((job) => job.seed)).size).toBe(1);
    expect(jobs.every((job) =>
      job.seed?.startsWith("source-seed-88:continued:variant:") === true
    )).toBe(true);
    expect(jobs[0]).toMatchObject({
      referenceAssetIds: [calibrationSourceAssetId],
      controls: expect.objectContaining({
        sourceImageAssetId: calibrationSourceAssetId,
        strength: 0.55,
      }),
      referenceManifest: [
        expect.objectContaining({
          mediaAssetId: calibrationSourceAssetId,
          role: "source_image",
          weight: 0.55,
        }),
      ],
    });
  });

  it("allows exactly one explicit no-reference primary-portrait bootstrap mode", async () => {
    const recoverableProfileId = `character-image-empty-profile-${suffix}`;
    await prisma.characterVisualProfile.create({
      data: {
        id: recoverableProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Ungrounded legacy candidate",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        adapterRefs: {},
        evidenceState: "candidate",
        createdFrom: "admin_passport_edit",
      },
    });
    const bootstrapRequest = {
      title: "Mara first identity portrait",
      purpose: "character_cover",
      targetType: "character",
      targetId: characterId,
      profileId: "profile_image_default_v1",
      bootstrapIdentity: true,
      orientation: "4:5",
      count: 1,
      brief: "A definitive first portrait that will establish Mara's identity authority.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Create the reviewed first identity anchor",
    };
    const responses = await Promise.all([
      createCreativeRun(request(bootstrapRequest, `character-image-bootstrap-a-${suffix}`)),
      createCreativeRun(request(bootstrapRequest, `character-image-bootstrap-b-${suffix}`)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const response = responses.find((candidate) => candidate.status === 202);
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected one accepted bootstrap Run");
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);
    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "content_production_item", sourceMeta: { path: ["batchId"], equals: batchId } },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(1);
    await expect(prisma.contentProductionBatch.count({
      where: { title: "Mara first identity portrait" },
    })).resolves.toBe(1);
    expect(jobs.every((job) => job.prompt?.includes("Target character: Mara."))).toBe(true);
    expect(jobs.every((job) => !job.prompt?.includes("Legacy character shell"))).toBe(true);
    expect(jobs.every((job) => job.prompt?.includes("render exactly one person total"))).toBe(true);
    expect(jobs.every((job) => job.negativePrompt?.includes("contact sheet"))).toBe(true);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        characterId,
        visualProfileId: null,
        referenceSetRevisionId: null,
        referenceAssetIds: null,
        orientation: "4:5",
        sourceMeta: expect.objectContaining({
          bootstrapIdentity: true,
          bootstrapProjectVersion: 1,
          characterContentVersionId: contentId,
          visualBriefHash: expect.any(String),
          bootstrapAuthorityState: "recoverable_empty_history",
          expectedIdentityHistoryFingerprint: expect.any(String),
          expectedIdentityVersion: 2,
        }),
      }),
    ]));
    await prisma.generationJob.updateMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      data: { status: "completed", deliveredOutputCount: 1, completedAt: new Date() },
    });
    const replacement = await createCreativeRun(request(
      bootstrapRequest,
      `character-image-bootstrap-replacement-${suffix}`,
    ));
    expect(replacement.status).toBe(202);
    const replacementPayload = await replacement.json();
    const replacementBatchId = replacementPayload.data.batch.id as string;
    batchIds.push(replacementBatchId);
    await expect(prisma.contentProductionBatch.count({
      where: { title: "Mara first identity portrait" },
    })).resolves.toBe(2);
    await cleanupBatches([batchId, replacementBatchId]);
    await prisma.characterVisualProfile.delete({ where: { id: recoverableProfileId } });
  });

  it("repairs a seed-style unowned Character image through Identity, Reference Set, and normal production", async () => {
    await prisma.mediaAsset.create({
      data: {
        id: legacyAssetId,
        ownerId: actorId,
        characterId: null,
        type: "image",
        url: `/assets/${legacyAssetId}.webp`,
        storageKey: `test-fixtures/${legacyAssetId}.webp`,
        safetyStatus: "passed",
        metadata: { seedStyleLegacyAsset: true },
      },
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: legacyAssetId },
    });
    const visualResponse = await createCharacterVisualProfile(new Request(
      `http://localhost/api/v1/admin/content/characters/${characterId}/visual-profiles`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `character-image-legacy-visual-${suffix}`,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({
          identityPrompt: "Mara, the same composed late-night radio host",
          reason: "Repair the uniquely referenced seed-style Character image",
          confirmation: `${characterId}:visual-profile`,
        }),
      },
    ), characterId);
    expect(visualResponse.status).toBe(200);
    const visualPayload = await visualResponse.json() as {
      data: { item: { id: string; version: number; anchorAssetIds: string[] } };
    };
    const legacyVisualProfileId = visualPayload.data.item.id;
    expect(visualPayload.data.item).toMatchObject({
      version: 1,
      anchorAssetIds: [legacyAssetId],
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({ where: { id: legacyAssetId } })).resolves.toMatchObject({
      characterId,
    });

    // 铸造身份版本时已经用锚点建出首个 active Reference Set（每个 identity 版本都带一个），
    // 所以这里的乐观锁期望值要取当前实际的 revision，不再是「还没有参考集」的 null/0。
    const bootstrappedReferenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: legacyVisualProfileId, status: "active" },
      orderBy: { revision: "desc" },
    });
    const legacyReferenceSet = await prisma.$transaction((tx) => publishCharacterReferenceSet({
      characterId,
      actor: { id: actorId, role: "admin" },
      requestId: `character-image-legacy-reference-${suffix}`,
      request: {
        visualProfileId: legacyVisualProfileId,
        expectedActiveReferenceSetRevisionId: bootstrappedReferenceSet.id,
        expectedActiveReferenceSetRevision: bootstrappedReferenceSet.revision,
        selectorVersion: "legacy-seed-repair-v1",
        references: [{ mediaAssetId: legacyAssetId, role: "identity_anchor", weight: 1 }],
        reason: { code: "legacy_seed_repair", summary: "Seal the uniquely owned legacy Character image" },
        confirmation: `PUBLISH REFERENCES ${characterId}`,
      },
      tx,
    }));
    await prisma.generationRouteQualification.create({
      data: {
        id: legacyQualificationId,
        routeFingerprint: `character-image-legacy-route-${suffix}`,
        generationProfileKey: profileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `character-image-legacy-matrix-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.96,
        result: "qualified",
        evidence: {
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          reviewerId: actorId,
          batchIds: ["legacy-seed-repair-fixture"],
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });
    const legacyQualification =
      await prisma.generationRouteQualification.findUniqueOrThrow({
        where: { id: legacyQualificationId },
      });
    const legacyQualificationAuthority =
      await evaluateEffectiveGenerationRouteAuthority(prisma, {
        qualification: legacyQualification,
        currentPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        currentEvaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        now: new Date(),
        requiredReferenceCount: 1,
        requiredReferenceRoles: ["identity_anchor"],
      });
    expect(
      legacyQualificationAuthority,
      JSON.stringify(legacyQualificationAuthority),
    ).toMatchObject({ state: "qualified" });
    const runResponse = await createCreativeRun(request({
      title: "Mara hero after legacy identity repair",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: profileKey,
      orientation: "4:5",
      count: 1,
      brief: "Prove the repaired legacy image remains usable as canonical identity authority.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Close the legacy Identity to normal production chain",
    }, `character-image-legacy-production-${suffix}`));
    const runFailure = runResponse.status === 202
      ? null
      : await runResponse.clone().json();
    expect(runResponse.status, JSON.stringify(runFailure)).toBe(202);
    const runPayload = await runResponse.json();
    const legacyBatchId = runPayload.data.batch.id as string;
    const legacyJob = await prisma.generationJob.findFirstOrThrow({
      where: { sourceMeta: { path: ["batchId"], equals: legacyBatchId } },
    });
    expect(legacyJob).toMatchObject({
      visualProfileId: legacyVisualProfileId,
      referenceSetRevisionId: legacyReferenceSet.id,
      referenceAssetIds: [legacyAssetId],
    });

    await prisma.mainOutboxEvent.deleteMany({
      where: { OR: [{ aggregateId: legacyBatchId }, { aggregateId: characterId }] },
    });
    await cleanupBatches([legacyBatchId]);
    await prisma.referenceSetRevision.delete({ where: { id: legacyReferenceSet.id } });
    await prisma.characterVisualProfile.delete({ where: { id: legacyVisualProfileId } });
    await prisma.generationRouteQualification.delete({ where: { id: legacyQualificationId } });
    await prisma.character.update({ where: { id: characterId }, data: { imageAssetId: null } });
    await prisma.mediaAsset.delete({ where: { id: legacyAssetId } });
  });

  it("serializes Character image create against Library archive in both winner orders", async () => {
    await prisma.character.create({
      data: {
        id: archiveRaceCharacterId,
        creatorId: actorId,
        name: "Archive race character",
        age: 31,
        gender: "female",
        style: archiveRaceStyle,
        description: "Dedicated fixture for Character generation and Library authority.",
        source: "official",
        status: "approved",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: archiveRaceContentId,
        characterId: archiveRaceCharacterId,
        version: 1,
        contentHash: `archive-race-content-${suffix}`,
        personaSnapshot: {
          name: "Archive race character",
          description: "Dedicated concurrent authority fixture.",
        },
        openingSnapshot: { firstMessage: "Ready when you are." },
        appearanceSnapshot: {
          identityAnchor: "Same adult character",
          stableTraits: ["dark hair", "brown eyes"],
          style: archiveRaceStyle,
        },
        sourceType: "character_image_archive_race_test",
        createdById: actorId,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: archiveRaceAssetId,
        ownerId: actorId,
        characterId: archiveRaceCharacterId,
        type: "image",
        url: `/assets/${archiveRaceAssetId}.webp`,
        storageKey: `test-fixtures/${archiveRaceAssetId}.webp`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const visualProfile = await prisma.characterVisualProfile.create({
      data: {
        id: archiveRaceVisualProfileId,
        characterId: archiveRaceCharacterId,
        version: 1,
        status: "active",
        style: archiveRaceStyle,
        identityPrompt: "The same adult character with dark hair and brown eyes",
        negativeIdentityPrompt: "different person, identity drift",
        faceTraits: { eyes: "brown" },
        hairTraits: { color: "dark" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: archiveRaceStyle },
        anchorAssetIds: [archiveRaceAssetId],
        defaultSeed: `archive-race-${suffix}`,
        adapterRefs: {},
        evidenceState: "reviewed_bootstrap",
        createdFrom: "character_image_archive_race_test",
      },
    });
    await prisma.characterVisualProfile.update({
      where: { id: archiveRaceVisualProfileId },
      data: { immutableHash: characterVisualProfileSnapshotHash(visualProfile) },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: archiveRaceReferenceSetId,
        visualProfileId: archiveRaceVisualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "character-image-archive-race-v1",
        createdFrom: "character_image_archive_race_test",
        snapshotHash: referenceSetSnapshotHash({
          visualProfileId: archiveRaceVisualProfileId,
          revision: 1,
          selectorVersion: "character-image-archive-race-v1",
          references: [{
            mediaAssetId: archiveRaceAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
          }],
        }),
        references: {
          create: {
            mediaAssetId: archiveRaceAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
            selectorVersion: "character-image-archive-race-v1",
            selectionReason: "Concurrency barrier identity anchor",
          },
        },
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: archiveRaceQualificationId,
        routeFingerprint: `character-image-archive-race-route-${suffix}`,
        generationProfileKey: profileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: archiveRaceStyle,
        matrixKey: `character-image-archive-race-matrix-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.97,
        result: "qualified",
        evidence: {
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          reviewerId: actorId,
          batchIds: ["archive-race-qualified-fixture"],
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });

    const createPayload = (title: string) => ({
      title,
      purpose: "character_hero",
      targetType: "character",
      targetId: archiveRaceCharacterId,
      profileId: profileKey,
      orientation: "4:5",
      count: 1,
      brief: "Preserve the sealed identity while creating a customer-facing hero.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove Character create and Library archive serialize on media authority",
    });

    const archiveFirstTitle = "Archive wins before Character image create";
    const jobsBeforeArchiveFirst = await prisma.generationJob.count({
      where: { characterId: archiveRaceCharacterId },
    });
    const [{ count: mediaAuthorityWaitBaseline }] = await prisma.$queryRaw<
      Array<{ count: number }>
    >`
      SELECT COUNT(*)::int AS "count"
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    let pendingCreate: Promise<Response> | null = null;
    await prisma.$transaction(async (tx) => {
      await lockMediaAssetAuthority(tx, archiveRaceAssetId);
      await tx.mediaAsset.update({
        where: { id: archiveRaceAssetId },
        data: {
          metadata: {
            platformAsset: { status: "archived" },
          },
        },
      });
      pendingCreate = createCreativeRun(request(
        createPayload(archiveFirstTitle),
        `character-image-archive-first-${suffix}`,
      ));
      let mediaAuthorityWaitObserved = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
        `;
        if (count > mediaAuthorityWaitBaseline) {
          mediaAuthorityWaitObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(mediaAuthorityWaitObserved).toBe(true);
    });
    expect(pendingCreate).not.toBeNull();
    const archiveFirstCreate = await pendingCreate!;
    expect(archiveFirstCreate.status).toBe(409);
    await expect(archiveFirstCreate.json()).resolves.toMatchObject({
      error: {
        details: {
          identityAuthorityChanged: true,
        },
      },
    });
    await expect(prisma.contentProductionBatch.count({
      where: { title: archiveFirstTitle },
    })).resolves.toBe(0);
    await expect(prisma.generationJob.count({
      where: { characterId: archiveRaceCharacterId },
    })).resolves.toBe(jobsBeforeArchiveFirst);
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: archiveRaceAssetId },
    })).resolves.toMatchObject({
      metadata: {
        platformAsset: { status: "archived" },
      },
    });
    await prisma.$transaction(async (tx) => {
      await lockMediaAssetAuthority(tx, archiveRaceAssetId);
      await tx.mediaAsset.update({
        where: { id: archiveRaceAssetId },
        data: { metadata: {} },
      });
    });

    const createFirstTitle = "Character image create wins before archive";
    const createFirst = await createCreativeRun(request(
      createPayload(createFirstTitle),
      `character-image-create-first-${suffix}`,
    ));
    const createFirstFailure = createFirst.status === 202
      ? null
      : await createFirst.clone().json();
    expect(createFirst.status, JSON.stringify(createFirstFailure)).toBe(202);
    const createFirstPayload = await createFirst.json() as {
      data: { batch: { id: string } };
    };
    const createFirstBatchId = createFirstPayload.data.batch.id;
    batchIds.push(createFirstBatchId);
    const createFirstJob = await prisma.generationJob.findFirstOrThrow({
      where: {
        characterId: archiveRaceCharacterId,
        sourceMeta: {
          path: ["batchId"],
          equals: createFirstBatchId,
        },
      },
    });
    expect(createFirstJob).toMatchObject({
      status: "queued",
      referenceAssetIds: [archiveRaceAssetId],
      referenceSetRevisionId: archiveRaceReferenceSetId,
    });

    // Remove the static identity/reference dependencies so the Library
    // rejection below proves the newly committed active job is sufficient.
    await prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, archiveRaceCharacterId);
      await tx.referenceSetRevision.update({
        where: { id: archiveRaceReferenceSetId },
        data: { status: "superseded" },
      });
      await tx.characterVisualProfile.update({
        where: { id: archiveRaceVisualProfileId },
        data: { status: "archived" },
      });
    });
    const archiveRequestId = `character-image-create-first-archive-${suffix}`;
    const archiveRequest = new Request(
      `http://localhost/admin/content/assets/${archiveRaceAssetId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": archiveRequestId,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": archiveRequestId,
        },
        body: JSON.stringify({
          status: "archived",
          reason: "Archive only if Character image create did not pin this asset",
          confirmation: archiveRaceAssetId,
        }),
      },
    );
    await expect(
      patchContentAsset(archiveRequest, archiveRaceAssetId),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: archiveRaceAssetId,
        dependencies: expect.arrayContaining([
          expect.objectContaining({
            kind: "character_generation_job",
            characterId: archiveRaceCharacterId,
            generationJobId: createFirstJob.id,
            runId: createFirstBatchId,
          }),
        ]),
      },
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: archiveRaceAssetId },
    })).resolves.toMatchObject({ metadata: {} });
    await prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, archiveRaceCharacterId);
      await tx.characterVisualProfile.update({
        where: { id: archiveRaceVisualProfileId },
        data: { status: "active" },
      });
      await tx.referenceSetRevision.update({
        where: { id: archiveRaceReferenceSetId },
        data: { status: "active" },
      });
    });
  });

  it("pins the active sealed reference snapshot into every normal Character asset job", async () => {
    await prisma.mediaAsset.create({
      data: {
        id: anchorAssetId,
        ownerId: actorId,
        characterId,
        type: "image",
        url: `/assets/${anchorAssetId}.webp`,
        storageKey: `test-fixtures/${anchorAssetId}.webp`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const profile = await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Mara, the same composed late-night radio host",
        negativeIdentityPrompt: "identity drift, different person, multiple people, text, watermark",
        faceTraits: { eyes: "warm brown", face: "same Mara" },
        hairTraits: { hair: "dark wavy hair" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [anchorAssetId],
        defaultSeed: `mara-${suffix}`,
        adapterRefs: {},
        evidenceState: "reviewed_bootstrap",
        createdFrom: "character_image_create_test",
      },
    });
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { immutableHash: characterVisualProfileSnapshotHash(profile) },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "character-image-create-v1",
        createdFrom: "character_image_create_test",
        snapshotHash: referenceSetSnapshotHash({
          visualProfileId,
          revision: 1,
          selectorVersion: "character-image-create-v1",
          references: [{
            mediaAssetId: anchorAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
          }],
        }),
        references: {
          create: {
            mediaAssetId: anchorAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
            selectorVersion: "character-image-create-v1",
            selectionReason: "Reviewed identity bootstrap anchor",
          },
        },
      },
    });
    const incompatible = await createCreativeRun(request({
      title: "Mara hero with incapable model",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: "profile_image_default_v1",
      orientation: "4:5",
      count: 1,
      brief: "A customer-facing hero must preserve the established identity.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove reference-incapable profiles fail closed",
    }, `character-image-incompatible-${suffix}`));
    expect(incompatible.status).toBe(409);

    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { identityPrompt: "drifted identity prompt that was never sealed" },
    });
    const targetedCampaign = await createCreativeRun(request({
      title: "Mara campaign with an invalid Character target",
      purpose: "campaign",
      targetType: "character",
      targetId: characterId,
      profileId: profileKey,
      orientation: "4:5",
      count: 1,
      brief: "A generic campaign must remain targetless and cannot bypass the Character asset lane.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove generic purposes cannot smuggle in a Character target",
    }, `character-image-drifted-campaign-${suffix}`));
    expect(targetedCampaign.status).toBe(400);
    await prisma.characterVisualProfile.update({
      where: { id: visualProfileId },
      data: { identityPrompt: "Mara, the same composed late-night radio host" },
    });

    const raceReferenceSetId = `character-image-create-race-reference-set-${suffix}`;
    const raceTitle = "Mara stale authority race";
    const [{ count: advisoryWaitBaseline }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    let releaseAuthorityMutation!: () => void;
    let markAuthorityLocked!: () => void;
    const authorityLocked = new Promise<void>((resolve) => { markAuthorityLocked = resolve; });
    const mutationGate = new Promise<void>((resolve) => { releaseAuthorityMutation = resolve; });
    const authorityMutation = prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, characterId);
      markAuthorityLocked();
      await mutationGate;
      await tx.referenceSetRevision.update({
        where: { id: referenceSetId },
        data: { status: "superseded" },
      });
      await tx.referenceSetRevision.create({
        data: {
          id: raceReferenceSetId,
          visualProfileId,
          revision: 2,
          status: "active",
          selectorVersion: "character-image-create-race-v2",
          createdFrom: "character_image_create_authority_race",
          snapshotHash: referenceSetSnapshotHash({
            visualProfileId,
            revision: 2,
            selectorVersion: "character-image-create-race-v2",
            references: [{
              mediaAssetId: anchorAssetId,
              position: 0,
              role: "primary_face",
              weight: 1,
            }],
          }),
          references: {
            create: {
              mediaAssetId: anchorAssetId,
              position: 0,
              role: "primary_face",
              weight: 1,
              selectorVersion: "character-image-create-race-v2",
              selectionReason: "Concurrent authority switch regression",
            },
          },
        },
      });
    });
    await authorityLocked;
    const staleCreate = createCreativeRun(request({
      title: raceTitle,
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: profileKey,
      orientation: "4:5",
      count: 1,
      brief: "A request validated against R1 must not commit after R2 becomes active.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove authority switching cannot dispatch stale generation",
    }, `character-image-authority-race-${suffix}`));
    let authorityWaitObserved = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `;
      if (count > advisoryWaitBaseline) {
        authorityWaitObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(authorityWaitObserved).toBe(true);
    releaseAuthorityMutation();
    await authorityMutation;
    expect((await staleCreate).status).toBe(409);
    await expect(prisma.contentProductionBatch.count({ where: { title: raceTitle } })).resolves.toBe(0);
    await prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, characterId);
      await tx.referenceSetRevision.delete({ where: { id: raceReferenceSetId } });
      await tx.referenceSetRevision.update({
        where: { id: referenceSetId },
        data: { status: "active" },
      });
    });

    const response = await createCreativeRun(request({
      title: "Mara identity-preserving hero",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: profileKey,
      orientation: "4:5",
      count: 1,
      brief: "A natural environmental hero scene that preserves Mara's identity.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Create a customer-facing hero from the sealed identity authority",
    }, `character-image-production-${suffix}`));
    expect(response.status).toBe(202);
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);
    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "content_production_item", sourceMeta: { path: ["batchId"], equals: batchId } },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(1);
    expect(new Set(jobs.map((job) => job.seed)).size).toBe(1);
    expect(jobs.every((job) =>
      job.seed?.startsWith(`mara-${suffix}:batch:${batchId}:`) === true
    )).toBe(true);
    expect(jobs.every((job) =>
      job.prompt?.includes("Operator brief: A natural environmental hero scene") === true
    )).toBe(true);
    expect(jobs.every((job) =>
      !job.prompt?.includes("A grounded late-night confidante.")
    )).toBe(true);
    expect(jobs.every((job) =>
      job.prompt?.includes("render exactly one person total") === true
    )).toBe(true);
    const operationalRoute =
      await prisma.generationRouteQualification.findFirstOrThrow({
        where: {
          matrixKey: "operator-single-image-v1",
          generationProfileKey: profileKey,
          generationProfileVersion: 1,
        },
      });
    expect(operationalRoute).toMatchObject({
      sampleCount: 0,
      passCount: 0,
      result: "qualified",
      evidence: expect.objectContaining({
        authorityMode: "operator_single_image",
        generationPolicy: "one_image_per_run",
      }),
    });
    for (const job of jobs) {
      expect(job).toMatchObject({
        characterId,
        visualProfileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: referenceSetId,
        referenceAssetIds: [anchorAssetId],
        orientation: "4:5",
        sourceMeta: expect.objectContaining({
          bootstrapIdentity: false,
          characterContentVersionId: contentId,
          generationRouteQualificationId: operationalRoute.id,
          generationRouteFingerprint: operationalRoute.routeFingerprint,
        }),
      });
      expect(job.referenceManifest).toEqual([
        expect.objectContaining({
          mediaAssetId: anchorAssetId,
          role: "primary_face",
          position: 0,
          referenceSetRevisionId: referenceSetId,
          referenceSetRevision: 1,
          snapshotHash: expect.any(String),
        }),
      ]);
    }
    await prisma.generationRouteQualification.create({
      data: {
        id: multiReferenceQualificationId,
        routeFingerprint:
          `character-image-create-multi-route-${suffix}`,
        generationProfileKey: multiReferenceProfileKey,
        generationProfileVersion: 1,
        workflowKey: multiReferenceWorkflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `character-image-create-multi-matrix-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.96,
        result: "qualified",
        evidence: {
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          reviewerId: actorId,
          batchIds: ["qualified-multi-reference-fixture"],
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });

    await prisma.contentProductionBatch.create({
      data: {
        id: variationSourceBatchId,
        title: "Mara reviewed source candidate",
        purpose: "character_hero",
        targetType: "character",
        targetId: characterId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        createdById: actorId,
        items: {
          create: {
            id: variationSourceItemId,
            itemIndex: 0,
            status: "rejected",
            tags: [],
          },
        },
      },
    });
    batchIds.push(variationSourceBatchId);
    await prisma.generationJob.create({
      data: {
        id: variationSourceJobId,
        userId: actorId,
        characterId,
        visualProfileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: referenceSetId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "comfyui",
        sourceType: "content_production_item",
        sourceId: variationSourceItemId,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: variationSourceAssetId,
        ownerId: actorId,
        characterId,
        sourceJobId: variationSourceJobId,
        type: "image",
        url: `/assets/${variationSourceAssetId}.webp`,
        storageKey: `test-fixtures/${variationSourceAssetId}.webp`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.contentProductionItem.update({
      where: { id: variationSourceItemId },
      data: {
        jobId: variationSourceJobId,
        mediaAssetId: variationSourceAssetId,
      },
    });
    const rejectedDecision = await prisma.creativeReviewDecision.create({
      data: {
        runItemId: variationSourceItemId,
        artifactId: variationSourceAssetId,
        decision: "rejected",
        identityConsistency: "failed",
        reason: "Rejected source must not be usable for variation generation",
        reviewerId: actorId,
        createdAt: new Date(Date.now() - 1_000),
      },
    });
    const rejectedVariation = await createCreativeRun(request({
      title: "Mara rejected-source variation",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: multiReferenceProfileKey,
      referenceAssetIds: [variationSourceAssetId],
      orientation: "4:5",
      count: 1,
      brief: "A direct API call must not reuse a rejected candidate.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove rejected variation sources fail closed",
    }, `character-image-rejected-variation-${suffix}`));
    expect(rejectedVariation.status).toBe(409);

    const approvedSourceDecision = await prisma.creativeReviewDecision.create({
      data: {
        runItemId: variationSourceItemId,
        artifactId: variationSourceAssetId,
        supersedesDecisionId: rejectedDecision.id,
        decision: "approved",
        identityConsistency: "passed",
        score: 94,
        reason: "Latest immutable decision approves this identity-consistent source",
        evidence: {
          quality: {
            noVisibleArtifacts: true,
            anatomyAndHands: true,
            framingAndCrop: true,
            lightingAndExposure: true,
          },
        },
        reviewerId: actorId,
      },
    });
    await prisma.contentProductionItem.update({
      where: { id: variationSourceItemId },
      data: { status: "approved" },
    });
    await prisma.generationModelProfile.update({
      where: { id: multiReferenceProfileId },
      data: {
        runnerConfig: {
          workflowVersion: 1,
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: false,
            lora: false,
          },
        },
      },
    });
    const beforeUnsupportedCounts = {
      batches: await prisma.contentProductionBatch.count(),
      jobs: await prisma.generationJob.count(),
      outbox: await prisma.mainOutboxEvent.count(),
    };
    const unsupportedVariation = await createCreativeRun(request({
      title: "Mara approved-source variation",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: multiReferenceProfileKey,
      referenceAssetIds: [variationSourceAssetId],
      orientation: "4:5",
      count: 1,
      brief: "An approved source may create a new identity-preserving variation.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Create a variation only after immutable approval",
    }, `character-image-approved-variation-${suffix}`));
    expect(unsupportedVariation.status).toBe(409);
    await expect(unsupportedVariation.json()).resolves.toMatchObject({
      error: {
        details: {
          sourceVariationAuthority: {
            ready: false,
            blocker: "profile_init_image_unsupported",
          },
        },
      },
    });
    await expect(prisma.contentProductionBatch.count({
      where: { title: "Mara approved-source variation" },
    })).resolves.toBe(0);
    await expect(prisma.contentProductionBatch.count())
      .resolves.toBe(beforeUnsupportedCounts.batches);
    await expect(prisma.generationJob.count())
      .resolves.toBe(beforeUnsupportedCounts.jobs);
    await expect(prisma.mainOutboxEvent.count())
      .resolves.toBe(beforeUnsupportedCounts.outbox);

    await prisma.generationModelProfile.update({
      where: { id: multiReferenceProfileId },
      data: {
        runnerConfig: {
          workflowVersion: 1,
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
      },
    });
    const supportedVariation = await createCreativeRun(request({
      title: "Mara supported-source variation",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: multiReferenceProfileKey,
      referenceAssetIds: [variationSourceAssetId],
      orientation: "4:5",
      count: 1,
      brief: "An approved source creates a variation when every runtime capability agrees.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove the complete source variation route remains usable",
    }, `character-image-supported-variation-${suffix}`));
    const supportedVariationFailure = supportedVariation.status === 202
      ? null
      : await supportedVariation.clone().json();
    expect(
      supportedVariation.status,
      JSON.stringify(supportedVariationFailure),
    ).toBe(202);
    const supportedVariationPayload = await supportedVariation.json();
    const supportedVariationBatchId =
      supportedVariationPayload.data.batch.id as string;
    batchIds.push(supportedVariationBatchId);
    const supportedVariationJob =
      await prisma.generationJob.findFirstOrThrow({
        where: {
          sourceMeta: {
            path: ["batchId"],
            equals: supportedVariationBatchId,
          },
        },
      });
    expect(supportedVariationJob.referenceManifest).toEqual([
      expect.objectContaining({
        mediaAssetId: anchorAssetId,
        role: "primary_face",
      }),
      expect.objectContaining({
        mediaAssetId: variationSourceAssetId,
        role: "source_image",
      }),
    ]);

    const canonicalReference =
      await prisma.characterVisualReferenceSnapshot.findFirstOrThrow({
        where: { referenceSetRevisionId: referenceSetId },
      });
    const overlapCapacityHash = referenceSetSnapshotHash({
      visualProfileId,
      revision: 1,
      selectorVersion: "character-image-create-v1",
      references: [{
        mediaAssetId: anchorAssetId,
        position: 0,
        role: "primary_face",
        weight: 1,
      }, {
        mediaAssetId: variationSourceAssetId,
        position: 1,
        role: "identity_reference",
        weight: 1,
      }],
    });
    await prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, characterId);
      await tx.characterVisualReferenceSnapshot.create({
        data: {
          referenceSetRevisionId: referenceSetId,
          mediaAssetId: variationSourceAssetId,
          position: 1,
          role: "identity_reference",
          weight: 1,
          selectorVersion: "character-image-create-v1",
          selectionReason: "Canonical-overlap capacity regression",
        },
      });
      await tx.referenceSetRevision.update({
        where: { id: referenceSetId },
        data: { snapshotHash: overlapCapacityHash },
      });
      await tx.characterVisualProfile.update({
        where: { id: visualProfileId },
        data: {
          anchorAssetIds: [anchorAssetId],
        },
      });
    });
    const overlapCapacityBlocked = await createCreativeRun(request({
      title: "Mara canonical-overlap route blocked",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: multiReferenceProfileKey,
      referenceAssetIds: [variationSourceAssetId],
      orientation: "4:5",
      count: 1,
      brief: "The selected source already belongs to the canonical set but still consumes its own role slot.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove canonical overlap cannot bypass concrete workflow slots",
    }, `character-image-overlap-capacity-${suffix}`));
    expect(overlapCapacityBlocked.status).toBe(409);
    await expect(overlapCapacityBlocked.json()).resolves.toMatchObject({
      error: {
        details: {
          profileKey: multiReferenceProfileKey,
          workflowKey: multiReferenceWorkflowKey,
          qualifiedProfileKey: null,
        },
      },
    });
    await expect(prisma.contentProductionBatch.count({
      where: { title: "Mara canonical-overlap route blocked" },
    })).resolves.toBe(0);

    const sourceCanonicalReference =
      await prisma.characterVisualReferenceSnapshot.findFirstOrThrow({
        where: {
          referenceSetRevisionId: referenceSetId,
          mediaAssetId: variationSourceAssetId,
        },
      });
    const overlapReferenceHash = referenceSetSnapshotHash({
      visualProfileId,
      revision: 1,
      selectorVersion: "character-image-create-v1",
      references: [{
        mediaAssetId: variationSourceAssetId,
        position: 0,
        role: "primary_face",
        weight: 1,
      }],
    });
    await prisma.$transaction(async (tx) => {
      await lockCharacterGenerationAuthority(tx, characterId);
      await tx.characterVisualReferenceSnapshot.delete({
        where: { id: canonicalReference.id },
      });
      await tx.characterVisualReferenceSnapshot.update({
        where: { id: sourceCanonicalReference.id },
        data: {
          position: 0,
          role: "primary_face",
          weight: 1,
          selectionReason: "Canonical-overlap positive regression",
        },
      });
      await tx.referenceSetRevision.update({
        where: { id: referenceSetId },
        data: { snapshotHash: overlapReferenceHash },
      });
      await tx.characterVisualProfile.update({
        where: { id: visualProfileId },
        data: {
          anchorAssetIds: [variationSourceAssetId],
        },
      });
    });
    const overlapVariation = await createCreativeRun(request({
      title: "Mara canonical-overlap source variation",
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      profileId: multiReferenceProfileKey,
      referenceAssetIds: [variationSourceAssetId],
      orientation: "4:5",
      count: 1,
      brief: "The canonical anchor is also the explicitly selected More-like source.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Prove equal asset identity never erases distinct source intent",
    }, `character-image-overlap-variation-${suffix}`));
    expect(overlapVariation.status).toBe(202);
    const overlapVariationPayload = await overlapVariation.json();
    const overlapVariationBatchId =
      overlapVariationPayload.data.batch.id as string;
    batchIds.push(overlapVariationBatchId);
    const overlapVariationJob =
      await prisma.generationJob.findFirstOrThrow({
        where: {
          sourceMeta: {
            path: ["batchId"],
            equals: overlapVariationBatchId,
          },
        },
      });
    expect(overlapVariationJob.referenceAssetIds).toEqual([
      variationSourceAssetId,
      variationSourceAssetId,
    ]);
    expect(overlapVariationJob.referenceManifest).toEqual([
      expect.objectContaining({
        mediaAssetId: variationSourceAssetId,
        role: "primary_face",
      }),
      expect.objectContaining({
        mediaAssetId: variationSourceAssetId,
        role: "source_image",
      }),
    ]);
    const overlapQueued = await jobQueue.getByDedupeKey(
      "ai.image.generate",
      `generation:${overlapVariationJob.id}:attempt:1`,
    );
    expect(overlapQueued?.payload).toMatchObject({
      referenceImages: [
        expect.objectContaining({
          assetId: variationSourceAssetId,
          role: "identity_anchor",
        }),
        expect.objectContaining({
          assetId: variationSourceAssetId,
          role: "source_image",
        }),
      ],
    });

    await prisma.generationJob.create({
      data: {
        id: variationDependentJobId,
        userId: actorId,
        characterId,
        mode: "image",
        controls: { sourceImageAssetId: variationSourceAssetId },
        presetIds: [],
        referenceAssetIds: [anchorAssetId],
        status: "completed",
        sourceType: "character_review_dependency_probe",
        sourceId: variationDependentJobId,
      },
    });
    await expect(recordCreativeReviewDecision({
      runId: variationSourceBatchId,
      itemId: variationSourceItemId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: 1,
      supersedesDecisionId: approvedSourceDecision.id,
      decision: "rejected",
      identityConsistency: "failed",
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "Attempt to rewrite approval after downstream generation consumed it",
      requestId: `character-image-downstream-review-${suffix}`,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        dependencies: expect.arrayContaining(["downstream_generation_lineage"]),
      },
    });
  });
});
