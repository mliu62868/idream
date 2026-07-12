import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import {
  generationRouteQualificationEvaluateRequestSchema,
  generationRouteQualificationEvaluateResponseSchema,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";

type QualificationRequest = z.infer<typeof generationRouteQualificationEvaluateRequestSchema>;

type QualityEvidence = {
  readonly assetId: string;
  readonly evaluatorVersion: string;
  readonly identityStatus: "passed" | "failed";
  readonly identityScore: number;
};

function record(value: Prisma.JsonValue | unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function qualityEvidence(asset: { id: string; metadata: Prisma.JsonValue }): QualityEvidence {
  const quality = record(record(asset.metadata).quality);
  const identity = record(quality.identity);
  const evaluatorVersion = quality.evaluatorVersion;
  const identityStatus = identity.status;
  const identityScore = identity.score;
  if (
    quality.schemaVersion !== "1" ||
    typeof evaluatorVersion !== "string" ||
    evaluatorVersion.trim().length === 0 ||
    (identityStatus !== "passed" && identityStatus !== "failed") ||
    typeof identityScore !== "number" ||
    !Number.isFinite(identityScore) ||
    identityScore < 0 ||
    identityScore > 1
  ) {
    throw Errors.conflict("Evaluation asset lacks exact, scored identity evidence", {
      assetId: asset.id,
      requiredQualitySchemaVersion: "1",
    });
  }
  return {
    assetId: asset.id,
    evaluatorVersion: evaluatorVersion.trim(),
    identityStatus,
    identityScore,
  };
}

export async function evaluateGenerationRouteQualification(input: {
  actor: AdminActor;
  requestId: string;
  request: QualificationRequest;
}) {
  const request = generationRouteQualificationEvaluateRequestSchema.parse(input.request);
  if (request.confirmation !== `QUALIFY ${request.matrixKey}`) {
    throw Errors.badRequest("Confirmation did not match the route qualification matrix");
  }
  const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw Errors.badRequest("Qualification expiry must be in the future");
  }
  const batchIds = [...new Set(request.batchIds)].sort();
  if (batchIds.length !== request.batchIds.length) {
    throw Errors.badRequest("Evaluation batches must be unique");
  }
  const batches = await prisma.contentProductionBatch.findMany({
    where: { id: { in: batchIds } },
    include: {
      items: {
        include: { job: { include: { assets: true } } },
        orderBy: { itemIndex: "asc" },
      },
    },
  });
  if (batches.length !== batchIds.length) {
    throw Errors.notFound("One or more evaluation batches were not found");
  }
  if (batches.some((batch) => batch.purpose !== "model_eval")) {
    throw Errors.conflict("Only model_eval batches can publish route qualification evidence");
  }

  const jobs = batches.flatMap((batch) => batch.items.map((item) => item.job));
  if (jobs.length === 0 || jobs.some((job) => !job || job.status !== "completed")) {
    throw Errors.conflict("Every evaluation matrix item must have a completed generation job");
  }
  const completedJobs = jobs.filter((job): job is NonNullable<typeof job> => job !== null);
  const profileKeys = new Set(completedJobs.map((job) => job.profileId));
  const profileVersions = new Set(completedJobs.map((job) => job.profileVersion));
  const workflowKeys = new Set(completedJobs.map((job) => job.model));
  if (
    profileKeys.size !== 1 ||
    profileVersions.size !== 1 ||
    workflowKeys.size !== 1 ||
    [...profileKeys][0] === null ||
    [...profileVersions][0] === null ||
    [...workflowKeys][0] === null
  ) {
    throw Errors.conflict("Evaluation evidence spans more than one profile or workflow version");
  }
  const generationProfileKey = [...profileKeys][0] as string;
  const generationProfileVersion = [...profileVersions][0] as number;
  const workflowKey = [...workflowKeys][0] as string;
  const profile = await prisma.generationModelProfile.findFirst({
    where: { profileKey: generationProfileKey, version: generationProfileVersion },
  });
  if (!profile || (profile.workflowKey ?? profile.pipelineModel) !== workflowKey) {
    throw Errors.conflict("The exact generation profile version is no longer available for verification");
  }
  const workflow = await generationWorkflowDescriptor(workflowKey);
  if (!workflow) throw Errors.conflict("The exact generation workflow is unavailable");

  const visualProfileIds = [...new Set(completedJobs.map((job) => job.visualProfileId))];
  if (visualProfileIds.includes(null)) {
    throw Errors.conflict("Identity qualification requires a pinned Visual Identity on every sample");
  }
  const visualProfiles = await prisma.characterVisualProfile.findMany({
    where: { id: { in: visualProfileIds as string[] } },
    select: { id: true, style: true, version: true },
  });
  if (
    visualProfiles.length !== visualProfileIds.length ||
    visualProfiles.some((profileRecord) => profileRecord.style !== request.style) ||
    completedJobs.some((job) => {
      const visual = visualProfiles.find((profileRecord) => profileRecord.id === job.visualProfileId);
      return !visual || visual.version !== job.visualProfileVersion;
    })
  ) {
    throw Errors.conflict("Evaluation samples do not pin exact Visual Identity versions for the requested style");
  }

  const assets = completedJobs.flatMap((job) => job.assets);
  const uniqueAssetIds = [...new Set(assets.map((asset) => asset.id))];
  if (assets.length !== completedJobs.length || uniqueAssetIds.length !== assets.length) {
    throw Errors.conflict("Every matrix sample must resolve to exactly one distinct generated asset");
  }
  const evidence = assets.map(qualityEvidence).sort((left, right) => left.assetId.localeCompare(right.assetId));
  const evaluatorVersions = new Set(evidence.map((item) => item.evaluatorVersion));
  if (evaluatorVersions.size !== 1) {
    throw Errors.conflict("Evaluation evidence mixes evaluator versions");
  }
  const evaluatorVersion = [...evaluatorVersions][0] as string;
  const sampleCount = evidence.length;
  const passCount = evidence.filter((item) => item.identityStatus === "passed").length;
  const identityMatch = evidence.reduce((sum, item) => sum + item.identityScore, 0) / sampleCount;
  const passRate = passCount / sampleCount;
  const result =
    sampleCount >= 40 &&
    passRate >= 0.9 &&
    identityMatch >= 0.9 &&
    request.costLatencyGuardrail.status === "passed"
      ? "qualified" as const
      : "candidate" as const;
  const route = {
    generationProfileKey,
    generationProfileVersion,
    workflowKey,
    workflowVersion: workflow.version,
    style: request.style,
  };
  const routeFingerprint = canonicalSha256(route);
  const evidenceHash = canonicalSha256({
    route,
    matrixKey: request.matrixKey,
    policyVersion: request.policyVersion,
    batchIds,
    assets: evidence,
    costLatencyGuardrail: request.costLatencyGuardrail,
  });

  const qualification = await prisma.$transaction(async (tx) => {
    const existing = await tx.generationRouteQualification.findUnique({
      where: {
        routeFingerprint_matrixKey_policyVersion: {
          routeFingerprint,
          matrixKey: request.matrixKey,
          policyVersion: request.policyVersion,
        },
      },
    });
    if (existing) {
      if (record(existing.evidence).evidenceHash !== evidenceHash) {
        throw Errors.conflict("This immutable route qualification matrix already has different evidence", {
          qualificationId: existing.id,
        });
      }
      return { record: existing, replayed: true };
    }
    const created = await tx.generationRouteQualification.create({
      data: {
        ...route,
        routeFingerprint,
        matrixKey: request.matrixKey,
        sampleCount,
        passCount,
        identityMatch,
        result,
        policyVersion: request.policyVersion,
        expiresAt,
        evidence: toInputJson({
          evidenceHash,
          evaluatorVersion,
          qualitySchemaVersion: "1",
          reviewerId: input.actor.id,
          batchIds,
          assetIds: evidence.map((item) => item.assetId),
          passRate,
          costLatencyGuardrail: request.costLatencyGuardrail,
        }),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "generation.route_qualification.evaluated",
        targetType: "generation_route_qualification",
        targetId: created.id,
        reason: `${request.reason.code}: ${request.reason.summary}`,
        after: toInputJson({
          routeFingerprint,
          matrixKey: request.matrixKey,
          result,
          sampleCount,
          passCount,
          identityMatch,
          evidenceHash,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "generation.route_qualification.evaluated.v2",
        aggregateType: "generation_route_qualification",
        aggregateId: created.id,
        payload: toInputJson({
          qualificationId: created.id,
          routeFingerprint,
          matrixKey: request.matrixKey,
          result,
          sampleCount,
          passCount,
          identityMatch,
          policyVersion: request.policyVersion,
          evidenceHash,
        }),
      },
    });
    return { record: created, replayed: false };
  });
  return generationRouteQualificationEvaluateResponseSchema.parse({
    qualificationId: qualification.record.id,
    routeFingerprint,
    result: qualification.record.result,
    sampleCount: qualification.record.sampleCount,
    passCount: qualification.record.passCount,
    identityMatch: qualification.record.identityMatch,
    evaluatorVersion,
    evidenceHash,
    replayed: qualification.replayed,
  });
}
