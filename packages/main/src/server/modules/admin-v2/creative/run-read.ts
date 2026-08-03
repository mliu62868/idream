import { prisma } from "@/server/lib/db";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { queryParams, type AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { deriveCreativeRunState, type CreativeRunLedgerFact } from "@/server/modules/content-production-state";
import { creativeRunListResponseSchema } from "@idream/shared/admin";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { creativeReviewQuality } from "@/server/modules/admin-v2/shared/creative-review-quality";
import { operationalContentProductionBatchWhere } from "@/server/modules/metric-data-scope";
import {
  creativeIdentityReviewMode,
  deriveCreativeItemExecutionState,
} from "./run-state";
import { jsonRecord, nonEmptyStrings } from "./json";

// SPEC: Creative Run 的两个只读投影 —— 运营列表与单轮详情。
// INTENT: 只读、无事务，能看到写路径看不到的东西（结算事实、Attempt / transport 谱系、
// 关联 Incident）。它与写权威混住时，「这里是在读还是在写」要逐个函数确认。

function latestByCreatedAt<T extends { id: string; createdAt: Date }>(rows: readonly T[]): T | null {
  return [...rows].sort((left, right) =>
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.id.localeCompare(left.id)
  )[0] ?? null;
}

function automaticCompositionSummary(metadata: unknown) {
  const quality = jsonRecord(jsonRecord(metadata).quality);
  const composition = jsonRecord(quality.composition);
  const evaluatorVersion = quality.evaluatorVersion;
  const status = composition.status;
  if (
    typeof evaluatorVersion !== "string" ||
    !["passed", "failed", "unscored"].includes(
      typeof status === "string" ? status : "",
    )
  ) {
    return null;
  }
  return {
    evaluatorVersion,
    status: status as "passed" | "failed" | "unscored",
    reason:
      typeof composition.reason === "string" ? composition.reason : null,
  };
}

function creativeItemFailure(
  itemStatus: string,
  jobErrorCode: string | null,
  attempt: {
    readonly errorCode: string | null;
    readonly operatorGuidance: string | null;
  } | null,
) {
  if (itemStatus !== "failed") return null;
  const errorCode =
    attempt?.errorCode?.trim() ||
    jobErrorCode?.trim() ||
    "generation_failed";
  return {
    errorCode,
    operatorGuidance:
      attempt?.operatorGuidance?.trim() ||
      (errorCode === "asset_quality_failed"
        ? "系统质量检查未通过；合图、空白图或损坏图片不会进入候选。请载入本轮参数，修改提示词后重新生成。"
        : "本轮没有产生可审核图片。请载入本轮参数，调整后重新生成。"),
  };
}

function creativeDirectionSnapshot(value: unknown) {
  const direction = jsonRecord(value);
  const required = ["title", "scenePrompt", "mood", "setting", "outfit", "camera", "lighting"] as const;
  if (required.some((key) => typeof direction[key] !== "string" || direction[key].trim().length === 0)) {
    return null;
  }
  return Object.fromEntries(required.map((key) => [key, String(direction[key]).trim()])) as {
    title: string;
    scenePrompt: string;
    mood: string;
    setting: string;
    outfit: string;
    camera: string;
    lighting: string;
  };
}

async function ledgerFacts(jobIds: readonly string[]): Promise<CreativeRunLedgerFact[]> {
  if (jobIds.length === 0) return [];
  return prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: [...jobIds] }, reason: { in: ["generation_spend", "refund"] } },
    select: { sourceId: true, reason: true, delta: true },
  });
}

export async function listCreativeRuns(input: {
  readonly requestUrl: string;
  readonly actor: AdminActor;
}) {
  void input.actor;
  const query = queryParams({ url: input.requestUrl }, "GET /api/v2/admin/creative/runs");
  const queryIdentity = {
    purpose: query.purpose,
    lifecycleState: query.lifecycleState,
    workflowStage: query.workflowStage,
    executionOutcome: query.executionOutcome,
    ownerId: query.ownerId,
    priority: query.priority,
    targetType: query.targetType,
    targetId: query.targetId,
    search: query.search,
    sort: query.sort,
  };
  const summaries: Array<ReturnType<typeof deriveCreativeRunSummary>> = [];
  const batchSize = Math.min(200, Math.max(50, query.limit * 4));
  let scanCursor = query.cursor;
  let updatedCursor: { updatedAt: Date; id: string } | null = null;
  if (query.sort === "updated_desc" && query.cursor) {
    const keys = decodeAdminListCursor(query.cursor, "creative_runs", queryIdentity);
    if (typeof keys[1] !== "string") throw Errors.badRequest("creative_runs cursor id is invalid");
    updatedCursor = {
      updatedAt: parseIsoCursorKey(keys[0], "creative_runs"),
      id: keys[1],
    };
  }
  let exhausted = false;

  while (summaries.length <= query.limit && !exhausted) {
    const cursorWhere: Prisma.ContentProductionBatchWhereInput | undefined = query.sort === "updated_desc"
      ? updatedCursor
        ? {
            OR: [
              { updatedAt: { lt: updatedCursor.updatedAt } },
              { updatedAt: updatedCursor.updatedAt, id: { lt: updatedCursor.id } },
            ],
          }
        : undefined
      : scanCursor
        ? { id: { gt: scanCursor } }
        : undefined;
    const roots = await prisma.contentProductionBatch.findMany({
      where: operationalContentProductionBatchWhere({
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
        purpose: query.purpose,
        lifecycleState: query.lifecycleState,
        workflowStage: query.workflowStage,
        ownerId: query.ownerId,
        priority: query.priority,
        targetType: query.targetType,
        targetId: query.targetId,
        ...(query.search ? {
          OR: [
            { id: { contains: query.search, mode: "insensitive" } },
            { title: { contains: query.search, mode: "insensitive" } },
            { purpose: { contains: query.search, mode: "insensitive" } },
          ],
        } : {}),
      }),
      orderBy: query.sort === "updated_desc"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : { id: "asc" },
      take: batchSize,
      include: {
        items: {
          include: {
            job: { include: { assets: { include: { placements: true } } } },
            mediaAsset: { include: { placements: true } },
          },
          orderBy: { itemIndex: "asc" },
        },
      },
    });
    if (roots.length === 0) {
      exhausted = true;
      break;
    }
    const allJobIds = roots.flatMap((run) => run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
    const allLedgerFacts = await ledgerFacts(allJobIds);
    for (const run of roots) {
      const summary = deriveCreativeRunSummary(run, allLedgerFacts);
      if (!query.executionOutcome || summary.executionOutcome === query.executionOutcome) {
        summaries.push(summary);
      }
    }
    scanCursor = roots.at(-1)?.id;
    const lastRoot = roots.at(-1);
    updatedCursor = lastRoot ? { updatedAt: lastRoot.updatedAt, id: lastRoot.id } : updatedCursor;
    exhausted = roots.length < batchSize;
  }

  const page = summaries.slice(0, query.limit);
  const hasNextPage = summaries.length > query.limit || !exhausted;
  return creativeRunListResponseSchema.parse({
    items: page,
    pageInfo: {
      endCursor: hasNextPage
        ? query.sort === "updated_desc"
          ? page.at(-1)
            ? encodeAdminListCursor(
                "creative_runs",
                queryIdentity,
                [page.at(-1)!.updatedAt, page.at(-1)!.id],
              )
            : null
          : page.at(-1)?.id ?? scanCursor ?? null
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

type CreativeRunRoot = Prisma.ContentProductionBatchGetPayload<{
  include: {
    items: {
      include: {
        job: { include: { assets: { include: { placements: true } } } };
        mediaAsset: { include: { placements: true } };
      };
    };
  };
}>;

function deriveCreativeRunSummary(
  run: CreativeRunRoot,
  allLedgerFacts: readonly CreativeRunLedgerFact[],
) {
  const jobIds = new Set(run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
  const state = deriveCreativeRunState({
    legacyStatus: run.status,
    expectedItemCount: run.totalItems,
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job ? {
          id: item.job.id,
          status: item.job.status,
          errorCode: item.job.errorCode,
          costDreamcoins: item.job.costDreamcoins,
        } : null,
        asset: asset ? { id: asset.id, safetyStatus: asset.safetyStatus, deletedAt: asset.deletedAt } : null,
        placements: asset?.placements.map((placement) => ({
          status: placement.status,
          verificationState: placement.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
        })) ?? [],
      };
    }),
    ledgerEntries: allLedgerFacts.filter((fact) => fact.sourceId !== null && jobIds.has(fact.sourceId)),
  });
  return {
    id: run.id,
    purpose: run.purpose,
    target: { type: run.targetType, id: run.targetId ?? run.id },
    ownerId: run.ownerId,
    dueAt: run.dueAt?.toISOString() ?? null,
    priority: run.priority,
    lifecycleState: run.lifecycleState,
    workflowStage: run.workflowStage,
    executionOutcome: state.executionOutcome,
    reviewState: state.reviewState,
    deploymentState: state.deploymentState,
    counts: state.counts,
    verificationState: run.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function getCreativeRunDetail(input: {
  readonly runId: string;
  readonly actor: AdminActor;
}) {
  void input.actor;
  const run = await prisma.contentProductionBatch.findFirst({
    where: operationalContentProductionBatchWhere({ id: input.runId }),
    include: {
      items: {
        include: {
          job: { include: { assets: { include: { placements: true } } } },
          mediaAsset: { include: { placements: true } },
        },
        orderBy: { itemIndex: "asc" },
      },
    },
  });
  if (!run) throw Errors.notFound("Creative Run not found");
  const itemIds = run.items.map((item) => item.id);
  const jobIds = run.items.flatMap((item) => item.jobId ? [item.jobId] : []);
  const [decisions, attempts, ledgerEntries, profile, recipe] = await Promise.all([
    prisma.creativeReviewDecision.findMany({ where: { runItemId: { in: itemIds } }, orderBy: { createdAt: "desc" } }),
    prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } }, orderBy: { attemptNo: "desc" } }),
    ledgerFacts(jobIds),
    run.profileId && run.profileVersion
      ? prisma.generationModelProfile.findFirst({
          where: { profileKey: run.profileId, version: run.profileVersion },
          select: { label: true },
        })
      : null,
    run.recipeId && run.recipeVersion
      ? prisma.generationRecipe.findFirst({
          where: { recipeKey: run.recipeId, version: run.recipeVersion },
          select: { label: true },
        })
      : null,
  ]);
  const transportExecutions = attempts.length > 0
    ? await prisma.generationTransportExecution.findMany({
        where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
        orderBy: { transportAttemptNo: "desc" },
      })
    : [];
  const state = deriveCreativeRunState({
    legacyStatus: run.status,
    expectedItemCount: run.totalItems,
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job ? { id: item.job.id, status: item.job.status, errorCode: item.job.errorCode, costDreamcoins: item.job.costDreamcoins } : null,
        asset: asset ? { id: asset.id, safetyStatus: asset.safetyStatus, deletedAt: asset.deletedAt } : null,
        placements: asset?.placements.map((placement) => ({
          status: placement.status,
          verificationState: placement.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
        })) ?? [],
      };
    }),
    ledgerEntries,
  });
  const relatedIncidentIds = [...new Set((await prisma.opsIncidentOccurrence.findMany({
    where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    select: { incidentId: true },
  })).map((occurrence) => occurrence.incidentId))];
  const rawExperiment = jsonRecord(
    jsonRecord(run.items[0]?.job?.sourceMeta).identityExperiment,
  );
  const experimentMode = rawExperiment.mode === "image_to_image"
    ? "image_to_image" as const
    : rawExperiment.mode === "text_to_image"
      ? "text_to_image" as const
      : null;
  const experimentSeedStrategy = rawExperiment.seedStrategy === "locked"
    ? "locked" as const
    : rawExperiment.seedStrategy === "reuse_source"
      ? "reuse_source" as const
      : rawExperiment.seedStrategy === "random"
        ? "random" as const
        : null;
  const identityExperiment =
    run.purpose === "identity_calibration" &&
    experimentMode &&
    experimentSeedStrategy
      ? {
          mode: experimentMode,
          positivePrompt:
            typeof rawExperiment.positivePrompt === "string" &&
              rawExperiment.positivePrompt.trim()
              ? rawExperiment.positivePrompt.trim()
              : run.brief?.trim() || "Identity calibration",
          negativePrompt:
            typeof rawExperiment.negativePrompt === "string"
              ? rawExperiment.negativePrompt
              : "",
          seedStrategy: experimentSeedStrategy,
          baseSeed:
            typeof rawExperiment.baseSeed === "string"
              ? rawExperiment.baseSeed
              : null,
          sourceAssetId:
            typeof rawExperiment.sourceAssetId === "string"
              ? rawExperiment.sourceAssetId
              : null,
          strength:
            typeof rawExperiment.strength === "number"
              ? rawExperiment.strength
              : 0.65,
        }
      : null;
  return {
    id: run.id,
    title: run.title,
    purpose: run.purpose,
    reviewContext: {
      brief: run.brief?.trim() || "No brief was preserved for this legacy Run.",
      orientation: run.orientation,
      profile: {
        key: run.profileId,
        version: run.profileVersion,
        label: profile?.label ?? null,
      },
      recipe: {
        key: run.recipeId,
        version: run.recipeVersion,
        label: recipe?.label ?? null,
      },
      referenceAssetCount: run.items[0]?.job
        ? new Set(nonEmptyStrings(run.items[0].job.referenceAssetIds)).size
        : 0,
      experiment: identityExperiment,
    },
    target: { type: run.targetType, id: run.targetId ?? run.id },
    ownerId: run.ownerId,
    dueAt: run.dueAt?.toISOString() ?? null,
    priority: run.priority,
    lifecycleState: run.lifecycleState,
    workflowStage: run.workflowStage,
    ...state,
    verificationState: run.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
    relatedIncidentIds,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      const latestDecision = latestByCreatedAt(decisions.filter((decision) => decision.runItemId === item.id));
      const latestAttempt = attempts.find((attempt) => attempt.requestId === item.jobId) ?? null;
      const latestTransport = transportExecutions.find((execution) => execution.attemptId === latestAttempt?.id) ?? null;
      const failure = creativeItemFailure(
        item.status,
        item.job?.errorCode ?? null,
        latestAttempt,
      );
      const placement = asset
        ? latestByCreatedAt(asset.placements.filter((candidate) =>
            ["published", "scheduled"].includes(candidate.status)
          ))
        : null;
      return {
        id: item.id,
        ordinal: item.itemIndex,
        status: item.status,
        executionState: deriveCreativeItemExecutionState({
          itemStatus: item.status,
          jobStatus: item.job?.status ?? null,
          attemptStatus: latestAttempt?.status ?? null,
          transportStatus: latestTransport?.status ?? null,
          hasAsset: Boolean(asset),
        }),
        identityReviewMode: creativeIdentityReviewMode({
          purpose: run.purpose,
          sourceMeta: item.job?.sourceMeta,
        }),
        direction: creativeDirectionSnapshot(item.directionSnapshot),
        version: item.version,
        retryability: latestAttempt?.retryability ?? (item.status === "failed" ? "unknown" : "not_applicable"),
        failure,
        lineage: {
          briefId: run.id,
          directionId: item.directionId,
          directionHash: item.directionHash,
          generationProfileKey: run.profileId,
          generationProfileVersion: run.profileVersion === null ? null : String(run.profileVersion),
          workflowKey: latestAttempt?.workflowKey ?? null,
          workflowVersion: latestAttempt?.workflowVersion === null || latestAttempt?.workflowVersion === undefined
            ? null
            : String(latestAttempt.workflowVersion),
          requestId: item.jobId,
          attemptId: latestAttempt?.id ?? null,
          providerRequestId: latestTransport?.providerRequestId ?? null,
          seed: item.job?.seed ?? null,
          assetId: asset?.id ?? null,
          reviewDecisionId: latestDecision?.id ?? null,
          placementVersionId: placement?.id ?? null,
        },
        asset: asset ? {
          id: asset.id,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
          width: asset.width,
          height: asset.height,
          automaticComposition: automaticCompositionSummary(asset.metadata),
        } : null,
        review: latestDecision
          ? {
              id: latestDecision.id,
              supersedesDecisionId: latestDecision.supersedesDecisionId,
              decision: latestDecision.decision,
              identityConsistency: latestDecision.identityConsistency,
              score: latestDecision.score,
              quality: creativeReviewQuality(latestDecision.evidence),
              reason: latestDecision.reason,
              reviewerId: latestDecision.reviewerId,
              createdAt: latestDecision.createdAt.toISOString(),
            }
          : null,
        placement: placement
          ? {
              id: placement.id,
              slot: placement.slot,
              targetType: placement.targetType,
              targetId: placement.targetId,
              status: placement.status,
              verificationState: placement.verificationState,
              verifiedAt: placement.verifiedAt?.toISOString() ?? null,
              rollbackPlacementId: placement.rollbackPlacementId,
            }
          : null,
      };
    }),
  };
}
