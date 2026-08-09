import { randomUUID } from "node:crypto";
import {
  characterRouteEvaluationMatrixDirections,
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationMatrixSchemaVersion,
  characterRouteEvaluationOutputsPerDirection,
  characterRouteEvaluationSampleCount,
} from "@idream/shared/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as evaluateRoute } from "@/app/api/v2/admin/characters/route-qualifications/commands/evaluate/route";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { evaluateGenerationRouteQualification } from "./route-qualification";
import { findQualifiedGenerationRoute } from "./visual-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";

describe("production Generation Route Qualification writer", () => {
  const prefix = `zt-route-qualification-${randomUUID()}-`;
  const actorId = `${prefix}admin`;
  const supportId = `${prefix}support`;
  const characterId = `${prefix}character`;
  const visualProfileId = `${prefix}visual`;
  const modelProfileId = `${prefix}model-profile`;
  const generationProfileKey = `${prefix}profile`;
  const workflowKey = "qwen-image-edit-img2img";
  const batchId = `${prefix}batch`;
  const matrixKey = characterRouteEvaluationMatrixKey("realistic");
  const anchorAssetId = `${prefix}anchor`;
  const referenceSetId = `${prefix}reference-set`;
  const recipeKey = `${prefix}character-recipe`;
  let evaluationBatchId: string | null = null;

  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: actorId, role: "admin" });
    await createUser({ id: supportId, role: "support" });
    await createCharacter({ id: characterId, creatorId: actorId, status: "draft", visibility: "private" });
    await prisma.mediaAsset.create({
      data: {
        id: anchorAssetId,
        ownerId: actorId,
        characterId,
        type: "image",
        url: `/test/${anchorAssetId}.webp`,
        storageKey: `tests/${anchorAssetId}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { operational: true },
      },
    });
    const visualProfile = await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Exact identity used for route evaluation.",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [anchorAssetId],
        adapterRefs: {},
        createdFrom: "test",
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
        selectorVersion: "route-evaluation-test-v1",
        snapshotHash: referenceSetSnapshotHash({
          visualProfileId,
          revision: 1,
          selectorVersion: "route-evaluation-test-v1",
          references: [{
            mediaAssetId: anchorAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
          }],
        }),
        createdFrom: "route_evaluation_test",
        references: {
          create: {
            mediaAssetId: anchorAssetId,
            position: 0,
            role: "primary_face",
            weight: 1,
            selectorVersion: "route-evaluation-test-v1",
            selectionReason: "Canonical route evaluation anchor",
          },
        },
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: modelProfileId,
        profileKey: generationProfileKey,
        label: "Qualification fixture profile",
        runner: "comfyui",
        pipelineModel: workflowKey,
        workflowKey,
        runnerConfig: { capabilities: { referenceImages: true } },
        allowedOrientations: ["portrait"],
        version: 1,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${recipeKey}-v1`,
        recipeKey,
        label: "Character route evaluation recipe",
        mode: "image",
        useCase: "character",
        body: "Preserve the exact Character identity in the requested shot.",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: batchId,
        title: "Route qualification matrix",
        purpose: "model_eval",
        targetType: "character",
        targetId: characterId,
        profileId: generationProfileKey,
        profileVersion: 1,
        presetIds: [],
        count: characterRouteEvaluationSampleCount,
        totalItems: characterRouteEvaluationSampleCount,
        status: "completed",
        createdById: actorId,
      },
    });
    for (
      let index = 0;
      index < characterRouteEvaluationSampleCount;
      index += 1
    ) {
      const itemId = `${prefix}item-${index}`;
      const jobId = `${prefix}job-${index}`;
      const assetId = `${prefix}asset-${index}`;
      const direction =
        characterRouteEvaluationMatrixDirections[
          Math.floor(index / characterRouteEvaluationOutputsPerDirection)
        ];
      const variantIndex =
        index % characterRouteEvaluationOutputsPerDirection;
      if (!direction) throw new Error("Expected canonical evaluation direction");
      const directionHash = canonicalSha256(direction);
      await prisma.contentProductionItem.create({
        data: {
          id: itemId,
          batchId,
          itemIndex: index,
          directionId: direction.id,
          directionSnapshot: direction,
          directionHash,
          status: "generated",
          tags: [],
        },
      });
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId: actorId,
          characterId,
          visualProfileId,
          visualProfileVersion: 1,
          mode: "image",
          controls: {},
          presetIds: [],
          model: workflowKey,
          profileId: generationProfileKey,
          profileVersion: 1,
          seed: `${prefix}seed-${index}`,
          outputCount: 1,
          deliveredOutputCount: 1,
          status: "completed",
          sourceType: "content_production_item",
          sourceId: itemId,
          sourceMeta: {
            batchId,
            routeQualificationEvaluationCandidate: true,
            routeQualificationMatrixKey: matrixKey,
            routeQualificationMatrixSchemaVersion:
              characterRouteEvaluationMatrixSchemaVersion,
            routeQualificationPolicyVersion:
              CHARACTER_RELEASE_POLICY_VERSION,
            routeQualificationEvaluatorVersion:
              env.GENERATION_ROUTE_EVALUATOR_VERSION,
            directionId: direction.id,
            directionHash,
            variantIndex,
          },
        },
      });
      await prisma.mediaAsset.create({
        data: {
          id: assetId,
          ownerId: actorId,
          sourceJobId: jobId,
          characterId,
          type: "image",
          url: `/test/${assetId}.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {
            quality: {
              schemaVersion: "1",
              evaluatorVersion: "identity-eval-v3",
              identity: {
                status: index < 38 ? "passed" : "failed",
                score: index < 38 ? 0.95 : 0.4,
              },
            },
          },
        },
      });
      await prisma.contentProductionItem.update({
        where: { id: itemId },
        data: { jobId, mediaAssetId: assetId },
      });
    }
  });

  afterAll(async () => {
    if (evaluationBatchId) {
      const evaluationItems = await prisma.contentProductionItem.findMany({
        where: { batchId: evaluationBatchId },
        select: { jobId: true },
      });
      const evaluationJobIds = evaluationItems.flatMap((item) =>
        item.jobId ? [item.jobId] : []
      );
      for (const jobId of evaluationJobIds) {
        await jobQueue.removeByDedupePrefix(`generation:${jobId}`, [
          "ai.image.generate",
        ]);
      }
      await prisma.mainOutboxEvent.deleteMany({
        where: { aggregateId: evaluationBatchId },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attempt: { requestId: { in: evaluationJobIds } } },
      });
      await prisma.generationAttempt.deleteMany({
        where: { requestId: { in: evaluationJobIds } },
      });
      await prisma.contentProductionBatch.deleteMany({
        where: { id: evaluationBatchId },
      });
      await prisma.generationJob.deleteMany({
        where: { id: { in: evaluationJobIds } },
      });
    }
    const qualifications = await prisma.generationRouteQualification.findMany({
      where: { generationProfileKey },
      select: { id: true },
    });
    const qualificationIds = qualifications.map((qualification) => qualification.id);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: qualificationIds } } });
    await prisma.generationRouteQualification.deleteMany({ where: { id: { in: qualificationIds } } });
    await prisma.generationRecipe.deleteMany({ where: { recipeKey } });
    await prisma.generationModelProfile.deleteMany({ where: { id: modelProfileId } });
    await purgeTestData(prefix);
    await prisma.$disconnect();
  });

  const request = {
    batchIds: [batchId],
    matrixKey,
    style: "realistic" as const,
    policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    costLatencyGuardrail: { status: "passed" as const, evidenceRef: `${prefix}cost-latency-report` },
    expiresAt: null,
    reason: { code: "eval_complete", summary: "Publish computed route evidence." },
    confirmation: `QUALIFY ${matrixKey}`,
  };

  async function clearRecordedQualifications() {
    const qualifications = await prisma.generationRouteQualification.findMany({
      where: { generationProfileKey },
      select: { id: true },
    });
    const qualificationIds = qualifications.map(
      (qualification) => qualification.id,
    );
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: qualificationIds } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: {
        targetType: "generation_route_qualification",
        targetId: { in: qualificationIds },
      },
    });
    await prisma.generationRouteQualification.deleteMany({
      where: { id: { in: qualificationIds } },
    });
  }

  it("computes a qualified result from 40 exact production assets and replays immutable evidence", async () => {
    const result = await evaluateGenerationRouteQualification({
      actor: { id: actorId, role: "admin" },
      requestId: `${prefix}request-1`,
      request,
    });
    expect(result).toMatchObject({
      result: "qualified",
      sampleCount: 40,
      passCount: 38,
      evaluatorVersion: "identity-eval-v3",
      replayed: false,
    });
    expect(result.identityMatch).toBeCloseTo(0.9225);
    const stored = await prisma.generationRouteQualification.findUniqueOrThrow({
      where: { id: result.qualificationId },
    });
    expect(stored.evidence).toMatchObject({
      evidenceHash: result.evidenceHash,
      qualitySchemaVersion: "1",
      reviewerId: actorId,
      batchIds: [batchId],
    });
    expect(await prisma.adminAuditLog.count({
      where: { action: "generation.route_qualification.evaluated", targetId: result.qualificationId },
    })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({
      where: { eventType: "generation.route_qualification.evaluated.v2", aggregateId: result.qualificationId },
    })).toBe(1);

    await expect(evaluateGenerationRouteQualification({
      actor: { id: actorId, role: "admin" },
      requestId: `${prefix}request-2`,
      request,
    })).resolves.toMatchObject({ qualificationId: result.qualificationId, replayed: true });
  });

  it("rejects a completed batch when its persisted direction matrix is mutated", async () => {
    const itemId = `${prefix}item-0`;
    const canonicalDirection =
      characterRouteEvaluationMatrixDirections[0];
    await prisma.contentProductionItem.update({
      where: { id: itemId },
      data: { directionHash: `${prefix}mutated-direction-hash` },
    });
    await expect(evaluateGenerationRouteQualification({
      actor: { id: actorId, role: "admin" },
      requestId: `${prefix}request-mutated-matrix`,
      request,
    })).rejects.toMatchObject({ code: "conflict" });
    await prisma.contentProductionItem.update({
      where: { id: itemId },
      data: { directionHash: canonicalSha256(canonicalDirection) },
    });
  });

  it("fails closed when a sample has unscored identity evidence", async () => {
    await prisma.mediaAsset.update({
      where: { id: `${prefix}asset-0` },
      data: {
        metadata: {
          quality: {
            schemaVersion: "1",
            evaluatorVersion: "identity-eval-v3",
            identity: { status: "unscored", reason: "evaluator_unavailable" },
          },
        },
      },
    });
    await expect(evaluateGenerationRouteQualification({
      actor: { id: actorId, role: "admin" },
      requestId: `${prefix}request-incomplete`,
      request,
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("accepts exact human identity reviews when the automatic evaluator is unavailable", async () => {
    await clearRecordedQualifications();
    const assets = Array.from({ length: 40 }, (_, index) =>
      `${prefix}asset-${index}`
    );
    await prisma.mediaAsset.updateMany({
      where: { id: { in: assets } },
      data: {
        metadata: {
          quality: {
            schemaVersion: "1",
            evaluatorVersion: "not_provided",
            identity: {
              status: "unscored",
              reason: "evaluator_unavailable",
            },
          },
        },
      },
    });
    await prisma.creativeReviewDecision.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        id: `${prefix}manual-decision-${index}`,
        runItemId: `${prefix}item-${index}`,
        artifactId: `${prefix}asset-${index}`,
        decision: index < 38 ? "approved" : "rejected",
        identityConsistency: index < 38 ? "passed" : "failed",
        score: index < 38 ? 95 : 50,
        reason: "Human review against the sealed identity anchor.",
        reviewerId: actorId,
      })),
    });
    const result = await evaluateGenerationRouteQualification({
      actor: { id: actorId, role: "admin" },
      requestId: `${prefix}request-human-reviewed`,
      request: {
        ...request,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });
    expect(result).toMatchObject({
      result: "qualified",
      sampleCount: 40,
      passCount: 38,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
    });
    expect(result.identityMatch).toBeCloseTo(0.9275);
    await expect(prisma.generationRouteQualification.findUniqueOrThrow({
      where: { id: result.qualificationId },
      select: { evidence: true },
    })).resolves.toMatchObject({
      evidence: {
        evidenceSchemaVersion: "2",
        qualitySchemaVersion: null,
        creativeReviewSchemaVersion: "1",
        evidenceSources: ["creative_review"],
        reviewerIds: [actorId],
        reviewDecisionIds: expect.arrayContaining([
          `${prefix}manual-decision-0`,
          `${prefix}manual-decision-39`,
        ]),
      },
    });
  });

  it("creates the 40-sample candidate matrix without requiring the route to qualify itself first", async () => {
    await prisma.generationRouteQualification.updateMany({
      where: {
        generationProfileKey,
        matrixKey,
      },
      data: {
        result: "paused",
      },
    });
    const response = await createCreativeRun(new Request(
      "http://localhost/api/v2/admin/creative/runs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${prefix}create-evaluation-run`,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({
          title: "Candidate route evaluation",
          purpose: "model_eval",
          targetType: "character",
          targetId: characterId,
          profileId: generationProfileKey,
          presetIds: [],
          referenceAssetIds: [],
          orientation: "portrait",
          count: characterRouteEvaluationSampleCount,
          brief: "Evaluate exact identity preservation across the fixed matrix.",
          directions: characterRouteEvaluationMatrixDirections,
          outputsPerDirection:
            characterRouteEvaluationOutputsPerDirection,
          routeEvaluationMatrixKey: matrixKey,
          consistencyMode: "balanced",
          priority: "high",
          reason: "Create the route qualification matrix before this route is qualified",
        }),
      },
    ));
    expect(response.status).toBe(202);
    const payload = await response.json();
    evaluationBatchId = payload.data.batch.id as string;
    const jobs = await prisma.generationJob.findMany({
      where: {
        sourceType: "content_production_item",
        sourceMeta: {
          path: ["batchId"],
          equals: evaluationBatchId,
        },
      },
    });
    expect(jobs).toHaveLength(characterRouteEvaluationSampleCount);
    expect(new Set(jobs.map((job) => job.seed)).size).toBe(
      characterRouteEvaluationSampleCount,
    );
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        visualProfileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: referenceSetId,
        referenceAssetIds: [anchorAssetId],
        sourceMeta: expect.objectContaining({
          generationRouteQualificationId: null,
          generationRouteFingerprint: null,
          routeQualificationEvaluationCandidate: true,
          routeQualificationMatrixKey: matrixKey,
          routeQualificationMatrixSchemaVersion:
            characterRouteEvaluationMatrixSchemaVersion,
          routeQualificationPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
          routeQualificationEvaluatorVersion:
            env.GENERATION_ROUTE_EVALUATOR_VERSION,
        }),
      }),
    ]));
  });

  it("keyset-scans beyond 20 newer disabled routes to recover the older viable authority", async () => {
    const viableId = `${prefix}older-viable-route`;
    const newerIds = Array.from({ length: 21 }, (_, index) =>
      `${prefix}newer-disabled-route-${index}`
    );
    const base = Date.now() + 120_000;
    await prisma.generationRouteQualification.createMany({
      data: [{
        id: viableId,
        routeFingerprint: `${prefix}older-viable-fingerprint`,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `${prefix}older-viable-matrix`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.98,
        result: "qualified",
        evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(base),
      }, ...newerIds.map((id, index) => ({
        id,
        routeFingerprint: `${prefix}newer-disabled-fingerprint-${index}`,
        generationProfileKey: `${prefix}disabled-profile-${index}`,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `${prefix}newer-disabled-matrix-${index}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.99,
        result: "qualified",
        evidence: { evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatedAt: new Date(base + index + 1),
      }))],
    });
    try {
      await expect(findQualifiedGenerationRoute(prisma, {
        style: "realistic",
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: 1,
        requiredReferenceRoles: ["primary_face"],
      })).resolves.toMatchObject({
        id: viableId,
        routeFingerprint: `${prefix}older-viable-fingerprint`,
      });
      await expect(findQualifiedGenerationRoute(prisma, {
        style: "realistic",
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: 2,
        requiredReferenceRoles: ["primary_face", "identity_reference"],
      })).resolves.toBeNull();
      await prisma.generationModelProfile.update({
        where: { id: modelProfileId },
        data: {
          runnerConfig: {
            capabilities: {
              initImage: true,
              referenceImages: false,
            },
          },
        },
      });
      await expect(findQualifiedGenerationRoute(prisma, {
        style: "realistic",
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: 1,
        requiredReferenceRoles: ["primary_face"],
      })).resolves.toBeNull();
    } finally {
      await prisma.generationModelProfile.update({
        where: { id: modelProfileId },
        data: {
          runnerConfig: {
            capabilities: { referenceImages: true },
          },
        },
      });
      await prisma.generationRouteQualification.deleteMany({
        where: { id: { in: [viableId, ...newerIds] } },
      });
    }
  });

  it("enforces the route permission before parsing evidence", async () => {
    const response = await evaluateRoute(new Request(
      "http://localhost/api/v2/admin/characters/route-qualifications/commands/evaluate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": supportId,
          "x-idream-role": "support",
        },
        body: "{}",
      },
    ));
    expect(response.status).toBe(403);
  });
});
