import { Prisma } from "@prisma/client";
import { isGenerationRequestCancellableStatus } from "@idream/shared/catalog";
import { prisma } from "@/server/lib/db";

// SPEC: 用户侧读一条 Generation Job 时的取数形状与投影。
//
// INTENT: 下单 / 重试的领域函数把「排好队的那一行」交回给 HTTP 层去渲染，两边必须对
// 同一个 include 形状达成一致 —— 否则领域函数只能自己造 Response，接缝就白拆了。

export function generationJobInclude() {
  return {
    assets: true,
    events: { orderBy: { createdAt: "asc" as const } },
  } satisfies Prisma.GenerationJobInclude;
}

export type GenerationJobWithRelations = Prisma.GenerationJobGetPayload<{
  include: ReturnType<typeof generationJobInclude>;
}>;

export function effectiveGenerationJobStatus(
  storedStatus: string,
  latestAttemptStatus: string | null,
) {
  // INTENT: Attempt owns execution liveness, while Job remains authoritative
  // for moderation phases and every business terminal state.
  return storedStatus === "queued" && latestAttemptStatus === "running"
    ? "running"
    : storedStatus;
}

export function generationExecutionErrorCode(
  storedStatus: string,
  latestAttemptStatus: string | null,
  errorCode: string | null,
) {
  // Unknown is an execution fact, not a failed/refunded business outcome.
  // A later operator settlement or retry must supersede this read projection.
  return latestAttemptStatus === "unknown" && isGenerationRequestCancellableStatus(storedStatus)
    ? "provider_outcome_unknown"
    : errorCode;
}

function generationJobDTO(
  job: GenerationJobWithRelations,
  latestAttemptStatus: string | null,
  settlement: { charged: number; refunded: number },
) {
  return {
    id: job.id,
    userId: job.userId,
    characterId: job.characterId,
    visualProfileId: job.visualProfileId,
    visualProfileVersion: job.visualProfileVersion,
    consistencyMode: job.consistencyMode,
    seed: job.seed,
    referenceAssetIds: job.referenceAssetIds,
    referenceSetRevisionId: job.referenceSetRevisionId,
    referenceManifest: job.referenceManifest,
    momentSpec: job.momentSpec,
    lookId: job.lookId,
    lookSnapshot: job.lookSnapshot,
    derivedFromJobId: job.derivedFromJobId,
    mode: job.mode,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt,
    controls: job.controls,
    presetIds: job.presetIds,
    model: job.model,
    profileId: job.profileId,
    profileVersion: job.profileVersion,
    recipeId: job.recipeId,
    recipeVersion: job.recipeVersion,
    orientation: job.orientation,
    outputCount: job.outputCount,
    status: effectiveGenerationJobStatus(job.status, latestAttemptStatus),
    costDreamcoins: job.costDreamcoins,
    provider: job.provider,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    sourceMeta: job.sourceMeta,
    errorCode: generationExecutionErrorCode(job.status, latestAttemptStatus, job.errorCode),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    // SPEC: 每个 job 自带「收了多少 / 退了多少 / 交付几张」的账目。
    // INTENT: 退款和部分交付的文案原本只能说「已退款」，说不出退了多少、少了几张；
    //   这三项服务端本来就算得出来，让列表和详情用同一份账目，前台才能说清数。
    cost: {
      ...settlement,
      finalCharge: Math.max(0, settlement.charged - settlement.refunded),
      assetCount: job.assets.length,
      requestedCount: job.outputCount,
      missingOutputs: Math.max(0, job.outputCount - job.assets.length),
    },
  };
}

export async function readGenerationJobs(jobs: readonly GenerationJobWithRelations[]) {
  if (jobs.length === 0) return [];
  const requestIds = jobs.map(job => job.id);
  // INVARIANT: the quote and timeline are not financial authority. Every
  // production ledger write links its Request in the same transaction. Reads
  // join that immutable authority in one batch; they never repair or refund.
  const [statuses, settlements] = await Promise.all([
    latestGenerationAttemptStatuses(requestIds),
    prisma.$queryRaw<Array<{ id: string; charged: bigint; refunded: bigint }>>(Prisma.sql`
      SELECT j.id,
        coalesce(sum(CASE WHEN l.kind = 'generation_spend' AND d.delta < 0 THEN -d.delta ELSE 0 END), 0)::bigint AS charged,
        coalesce(sum(CASE WHEN l.kind = 'refund' AND d.delta > 0 THEN d.delta ELSE 0 END), 0)::bigint AS refunded
      FROM generation_jobs j
      LEFT JOIN generation_settlement_links l ON l."requestId" = j.id
      LEFT JOIN dreamcoin_ledger d ON d.id = l."ledgerEntryId"
        AND d."sourceId" = j.id AND d."userId" = j."userId" AND d.reason = l.kind
      WHERE j.id IN (${Prisma.join(requestIds)})
      GROUP BY j.id
    `),
  ]);
  const costs = new Map(settlements.map(row => [row.id, { charged: Number(row.charged), refunded: Number(row.refunded) }]));
  return jobs.map(job => generationJobDTO(job, statuses.get(job.id) ?? null, costs.get(job.id) ?? { charged: 0, refunded: 0 }));
}

export async function latestGenerationAttemptStatuses(requestIds: string[]) {
  if (requestIds.length === 0) return new Map<string, string>();
  const attempts = await prisma.generationAttempt.findMany({
    where: { requestId: { in: requestIds } },
    select: { requestId: true, status: true },
    orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
  });
  const latestStatuses = new Map<string, string>();
  for (const attempt of attempts) {
    if (!latestStatuses.has(attempt.requestId)) {
      latestStatuses.set(attempt.requestId, attempt.status);
    }
  }
  return latestStatuses;
}
