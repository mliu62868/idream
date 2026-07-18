import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as evaluateRoute } from "@/app/api/v2/admin/characters/route-qualifications/commands/evaluate/route";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { evaluateGenerationRouteQualification } from "./route-qualification";
import { findQualifiedGenerationRoute } from "./visual-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";

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
  const matrixKey = `${prefix}matrix`;

  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: actorId, role: "admin" });
    await createUser({ id: supportId, role: "support" });
    await createCharacter({ id: characterId, creatorId: actorId, status: "draft", visibility: "private" });
    await prisma.characterVisualProfile.create({
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
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
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
        count: 40,
        totalItems: 40,
        status: "completed",
        createdById: actorId,
      },
    });
    for (let index = 0; index < 40; index += 1) {
      const itemId = `${prefix}item-${index}`;
      const jobId = `${prefix}job-${index}`;
      const assetId = `${prefix}asset-${index}`;
      await prisma.contentProductionItem.create({
        data: { id: itemId, batchId, itemIndex: index, status: "generated", tags: [] },
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
          outputCount: 1,
          deliveredOutputCount: 1,
          status: "completed",
          sourceType: "content_production_item",
          sourceId: itemId,
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
    const qualifications = await prisma.generationRouteQualification.findMany({
      where: { matrixKey: { startsWith: prefix } },
      select: { id: true },
    });
    const qualificationIds = qualifications.map((qualification) => qualification.id);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: qualificationIds } } });
    await prisma.generationRouteQualification.deleteMany({ where: { id: { in: qualificationIds } } });
    await prisma.generationModelProfile.deleteMany({ where: { id: modelProfileId } });
    await purgeTestData(prefix);
    await prisma.$disconnect();
  });

  const request = {
    batchIds: [batchId],
    matrixKey,
    style: "realistic" as const,
    policyVersion: "character-release-v2",
    costLatencyGuardrail: { status: "passed" as const, evidenceRef: `${prefix}cost-latency-report` },
    expiresAt: null,
    reason: { code: "eval_complete", summary: "Publish computed route evidence." },
    confirmation: `QUALIFY ${matrixKey}`,
  };

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
    const incompleteMatrixKey = `${prefix}incomplete-matrix`;
    await expect(evaluateGenerationRouteQualification({
      actor: { id: actorId, role: "admin" },
      requestId: `${prefix}request-incomplete`,
      request: {
        ...request,
        matrixKey: incompleteMatrixKey,
        confirmation: `QUALIFY ${incompleteMatrixKey}`,
      },
    })).rejects.toMatchObject({ code: "conflict" });
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
