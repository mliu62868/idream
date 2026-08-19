import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { isRecord } from "@/server/lib/request-json";

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

export function generationJobDTO(
  job: GenerationJobWithRelations,
  latestAttemptStatus: string | null = null,
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
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

export function generationRefundAmount(events: GenerationJobWithRelations["events"]) {
  return events.reduce((total, event) => {
    if (event.type !== "refunded") return total;
    const metadata = isRecord(event.metadata) ? event.metadata : {};
    const amount = metadata.amount;
    return total + (typeof amount === "number" && Number.isFinite(amount) ? amount : 0);
  }, 0);
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
