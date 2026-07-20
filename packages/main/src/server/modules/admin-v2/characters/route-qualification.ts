import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import {
  characterRouteEvaluationMatrixDirections,
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationMatrixSchemaVersion,
  characterRouteEvaluationOutputsPerDirection,
  characterRouteEvaluationSampleCount,
  generationRouteQualificationEvaluateRequestSchema,
  generationRouteQualificationEvaluateResponseSchema,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
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
  readonly source: "generated_quality" | "creative_review";
  readonly reviewDecisionId?: string;
  readonly reviewerId?: string;
};

function record(value: Prisma.JsonValue | unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function generatedQualityEvidence(
  asset: { id: string; metadata: Prisma.JsonValue },
): QualityEvidence | null {
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
    return null;
  }
  return {
    assetId: asset.id,
    evaluatorVersion: evaluatorVersion.trim(),
    identityStatus,
    identityScore,
    source: "generated_quality",
  };
}

function reviewedQualityEvidence(input: {
  readonly asset: { readonly id: string };
  readonly decision: {
    readonly id: string;
    readonly artifactId: string;
    readonly identityConsistency: string;
    readonly score: number | null;
    readonly reviewerId: string;
  } | undefined;
}): QualityEvidence {
  const decision = input.decision;
  if (
    !decision ||
    decision.artifactId !== input.asset.id ||
    (decision.identityConsistency !== "passed" &&
      decision.identityConsistency !== "failed") ||
    decision.score === null ||
    !Number.isInteger(decision.score) ||
    decision.score < 0 ||
    decision.score > 100
  ) {
    throw Errors.conflict("Evaluation asset lacks exact, scored identity evidence", {
      assetId: input.asset.id,
      requiredQualitySchemaVersion: "1",
      acceptedSources: ["generated_quality", "creative_review"],
    });
  }
  return {
    assetId: input.asset.id,
    evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
    identityStatus: decision.identityConsistency,
    identityScore: decision.score / 100,
    source: "creative_review",
    reviewDecisionId: decision.id,
    reviewerId: decision.reviewerId,
  };
}

export async function evaluateGenerationRouteQualification(input: {
  actor: AdminActor;
  requestId: string;
  request: QualificationRequest;
  tx?: Prisma.TransactionClient;
}) {
  const db = input.tx ?? prisma;
  const request = generationRouteQualificationEvaluateRequestSchema.parse(input.request);
  if (request.confirmation !== `QUALIFY ${request.matrixKey}`) {
    throw Errors.badRequest("Confirmation did not match the route qualification matrix");
  }
  if (
    request.matrixKey !== characterRouteEvaluationMatrixKey(request.style)
  ) {
    throw Errors.badRequest(
      "Route qualification must use the canonical matrix key for the requested style",
      {
        expectedMatrixKey: characterRouteEvaluationMatrixKey(request.style),
        receivedMatrixKey: request.matrixKey,
      },
    );
  }
  const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw Errors.badRequest("Qualification expiry must be in the future");
  }
  const batchIds = [...new Set(request.batchIds)].sort();
  if (batchIds.length !== request.batchIds.length) {
    throw Errors.badRequest("Evaluation batches must be unique");
  }
  const batches = await db.contentProductionBatch.findMany({
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
  const expectedMatrixItems =
    characterRouteEvaluationMatrixDirections.flatMap((direction) =>
      Array.from(
        { length: characterRouteEvaluationOutputsPerDirection },
        (_, variantIndex) => ({
          direction,
          directionHash: canonicalSha256(direction),
          variantIndex,
        }),
      )
    );
  const invalidMatrixBatch = batches.map((batch) => {
    const violations: string[] = [];
    if (batch.targetType !== "character") violations.push("target_type");
    if (!batch.targetId) violations.push("target_id");
    if (batch.count !== characterRouteEvaluationSampleCount) {
      violations.push("batch_count");
    }
    if (batch.totalItems !== characterRouteEvaluationSampleCount) {
      violations.push("batch_total_items");
    }
    if (batch.items.length !== characterRouteEvaluationSampleCount) {
      violations.push("persisted_item_count");
    }
    const seeds = new Set(
      batch.items.flatMap((item) =>
        item.job?.seed && item.job.seed.trim().length > 0 ? [item.job.seed] : []
      ),
    );
    if (seeds.size !== characterRouteEvaluationSampleCount) {
      violations.push("distinct_candidate_seeds");
    }
    batch.items.forEach((item, index) => {
      const expected = expectedMatrixItems[index];
      const sourceMeta = record(item.job?.sourceMeta);
      if (!expected) {
        violations.push(`item_${index}:unexpected`);
        return;
      }
      const itemViolations = [
        item.itemIndex !== index ? "index" : null,
        item.directionId !== expected.direction.id ? "direction_id" : null,
        item.directionHash !== expected.directionHash ? "direction_hash" : null,
        canonicalSha256(item.directionSnapshot) !== expected.directionHash
          ? "direction_snapshot"
          : null,
        item.job?.characterId !== batch.targetId ? "character_id" : null,
        sourceMeta.routeQualificationEvaluationCandidate !== true
          ? "candidate_marker"
          : null,
        sourceMeta.routeQualificationMatrixKey !== request.matrixKey
          ? "matrix_key"
          : null,
        sourceMeta.routeQualificationMatrixSchemaVersion !==
          characterRouteEvaluationMatrixSchemaVersion
          ? "matrix_schema"
          : null,
        sourceMeta.routeQualificationPolicyVersion !== request.policyVersion
          ? "policy_version"
          : null,
        sourceMeta.routeQualificationEvaluatorVersion !==
          env.GENERATION_ROUTE_EVALUATOR_VERSION
          ? "evaluator_version"
          : null,
        sourceMeta.directionId !== expected.direction.id
          ? "source_direction_id"
          : null,
        sourceMeta.directionHash !== expected.directionHash
          ? "source_direction_hash"
          : null,
        sourceMeta.variantIndex !== expected.variantIndex
          ? "variant_index"
          : null,
      ].filter((violation): violation is string => violation !== null);
      violations.push(...itemViolations.map(
        (violation) => `item_${index}:${violation}`,
      ));
    });
    return { batch, violations };
  }).find((candidate) => candidate.violations.length > 0);
  if (invalidMatrixBatch) {
    throw Errors.conflict(
      `Evaluation batch does not match the canonical 10-direction, 40-sample matrix authority: ${invalidMatrixBatch.violations.slice(0, 5).join(", ")}`,
      {
        batchId: invalidMatrixBatch.batch.id,
        matrixKey: request.matrixKey,
        matrixSchemaVersion: characterRouteEvaluationMatrixSchemaVersion,
        violations: invalidMatrixBatch.violations,
      },
    );
  }

  const samples = batches.flatMap((batch) =>
    batch.items.map((item) => ({ itemId: item.id, job: item.job }))
  );
  if (
    samples.length === 0 ||
    samples.some((sample) => !sample.job || sample.job.status !== "completed")
  ) {
    throw Errors.conflict("Every evaluation matrix item must have a completed generation job");
  }
  const completedSamples = samples.filter(
    (sample): sample is {
      itemId: string;
      job: NonNullable<typeof sample.job>;
    } => sample.job !== null,
  );
  const completedJobs = completedSamples.map((sample) => sample.job);
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
  const profile = await db.generationModelProfile.findFirst({
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
  const visualProfiles = await db.characterVisualProfile.findMany({
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
  const decisions = await db.creativeReviewDecision.findMany({
    where: {
      runItemId: {
        in: completedSamples.map((sample) => sample.itemId),
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestDecisionByItemId = new Map<
    string,
    (typeof decisions)[number]
  >();
  for (const decision of decisions) {
    if (!latestDecisionByItemId.has(decision.runItemId)) {
      latestDecisionByItemId.set(decision.runItemId, decision);
    }
  }
  const evidence = completedSamples.map((sample) => {
    const asset = sample.job.assets[0] as (typeof assets)[number];
    const generated = generatedQualityEvidence(asset);
    const decision = latestDecisionByItemId.get(sample.itemId);
    if (
      generated &&
      (
        generated.evaluatorVersion === env.GENERATION_ROUTE_EVALUATOR_VERSION ||
        !decision
      )
    ) {
      return generated;
    }
    return reviewedQualityEvidence({
      asset,
      decision,
    });
  }).sort((left, right) => left.assetId.localeCompare(right.assetId));
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

  const persist = async (tx: Prisma.TransactionClient) => {
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
          evidenceSchemaVersion: "2",
          evidenceHash,
          evaluatorVersion,
          qualitySchemaVersion: evidence.every((item) =>
            item.source === "generated_quality"
          ) ? "1" : null,
          creativeReviewSchemaVersion: evidence.some((item) =>
            item.source === "creative_review"
          ) ? "1" : null,
          reviewerId: input.actor.id,
          batchIds,
          assetIds: evidence.map((item) => item.assetId),
          evidenceSources: [...new Set(evidence.map((item) => item.source))],
          reviewDecisionIds: evidence.flatMap((item) =>
            item.reviewDecisionId ? [item.reviewDecisionId] : []
          ),
          reviewerIds: [...new Set(evidence.flatMap((item) =>
            item.reviewerId ? [item.reviewerId] : []
          ))],
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
  };
  const qualification = input.tx ? await persist(input.tx) : await prisma.$transaction(persist);
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
