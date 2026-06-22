import type { Prisma } from "@prisma/client";
import { jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import {
  aiFinalizePayloadSchema,
  imageGeneratePayloadSchema,
  type AiFinalizePayload,
  type ImageGeneratePayload,
  type VideoGeneratePayload,
  videoGeneratePayloadSchema,
} from "./schemas";

export const localAiQueueNames = [
  "ai.image.generate",
  "ai.video.generate",
  "app.ai.finalize",
] as const;

export interface LocalAiDrainResult {
  workerId: string;
  claimed: Array<{
    id: string;
    queue: string;
    status: string;
  }>;
  processed: number;
}

export async function drainLocalAiPipeline(input: {
  limit?: number;
  workerId?: string;
  queues?: string[];
} = {}): Promise<LocalAiDrainResult> {
  const workerId = input.workerId ?? `local-ai-${cryptoRandomId()}`;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const queues = input.queues ?? [...localAiQueueNames];
  const claimedSummary: LocalAiDrainResult["claimed"] = [];
  let processed = 0;

  for (let index = 0; index < limit; index += 1) {
    let claimed = false;

    for (const queue of queues) {
      const result = await jobQueue.processNext({
        queue,
        workerId,
        processor: processLocalAiJob,
      });
      if (!result.job) continue;

      claimed = true;
      claimedSummary.push({ id: result.job.id, queue: result.job.queue, status: result.status });
      if (result.status === "completed") processed += 1;
      break;
    }

    if (!claimed) break;
  }

  return { workerId, claimed: claimedSummary, processed };
}

async function processLocalAiJob(job: QueueJob) {
  if (job.queue === "ai.image.generate") {
    return processImageGenerate(job.payload);
  }
  if (job.queue === "ai.video.generate") {
    return processVideoGenerate(job.payload);
  }
  if (job.queue === "app.ai.finalize") {
    return processFinalize(job.payload);
  }

  throw new Error(`Unsupported local AI queue: ${job.queue}`);
}

async function processImageGenerate(payloadValue: Prisma.JsonValue) {
  const payload = imageGeneratePayloadSchema.parse(payloadValue);
  await markGenerationRunning(payload.generationJobId);

  const result = await providers.image.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
  });

  if (!result.ok) {
    if (result.error.retryable) throw new Error(result.error.message);
    await enqueueGenerationFailed(payload, result.error.code, result.error.message);
    return;
  }

  const assets = await Promise.all(
    result.data.assets.map(async (asset, index) => {
      const key = asset.key || `${payload.outputPrefix}${index}.webp`;
      await providers.blob.putPrivate({
        key,
        body: new TextEncoder().encode(`mock image ${payload.generationJobId} ${index}`),
        contentType: "image/webp",
      });
      return {
        key,
        width: asset.width,
        height: asset.height,
        contentType: "image/webp",
      };
    }),
  );

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.completed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "image",
      assets,
      usage: { gpuSeconds: assets.length * 1.2, model: payload.model },
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:completed`,
  });
}

async function processVideoGenerate(payloadValue: Prisma.JsonValue) {
  const payload = videoGeneratePayloadSchema.parse(payloadValue);
  await markGenerationRunning(payload.generationJobId);

  const result = await providers.video.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
  });

  if (!result.ok) {
    if (result.error.retryable) throw new Error(result.error.message);
    await enqueueGenerationFailed(payload, result.error.code, result.error.message);
    return;
  }

  await providers.blob.putPrivate({
    key: result.data.asset.key,
    body: new TextEncoder().encode(`mock video ${payload.generationJobId}`),
    contentType: "video/mp4",
  });

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.completed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "video",
      assets: [
        {
          key: result.data.asset.key,
          seconds: result.data.asset.seconds,
          contentType: "video/mp4",
        },
      ],
      usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:completed`,
  });
}

async function processFinalize(payloadValue: Prisma.JsonValue) {
  const payload = aiFinalizePayloadSchema.parse(payloadValue);

  if (payload.kind === "generation.completed") return finalizeGenerationCompleted(payload);
  if (payload.kind === "generation.failed") return finalizeGenerationFailed(payload);
}

async function finalizeGenerationCompleted(
  payload: Extract<AiFinalizePayload, { kind: "generation.completed" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  if (job.status === "completed") return;

  const outputModeration = await moderateText(
    "generation_job",
    payload.generationJobId,
    payload.assets.map((asset) => asset.key).join(" "),
    "output",
  );
  if (outputModeration.status === "blocked") {
    await refundGeneration(job.userId, job.id, job.costDreamcoins, "blocked", "output_blocked");
    return;
  }

  const existingAssets = await prisma.mediaAsset.count({
    where: { sourceJobId: payload.generationJobId },
  });
  const displayUrl =
    payload.mode === "image"
      ? await imageUrlForCharacter(job.characterId ?? undefined)
      : "/images/ourdream/promo-card-female.webp";

  await prisma.$transaction(async (tx) => {
    if (existingAssets === 0) {
      for (const [index, asset] of payload.assets.entries()) {
        await tx.mediaAsset.create({
          data: {
            ownerId: job.userId,
            sourceJobId: job.id,
            characterId: job.characterId,
            type: payload.mode,
            url: displayUrl,
            thumbnailUrl: displayUrl,
            prompt: job.prompt,
            visibility: "private",
            safetyStatus: outputModeration.status,
            metadata: toInputJson({
              index,
              provider: "mock-pipeline",
              providerKey: asset.key,
              contentType: asset.contentType,
              width: asset.width,
              height: asset.height,
              seconds: asset.seconds,
              usage: payload.usage,
            }),
          },
        });
      }
    }

    await tx.generationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        errorCode: null,
      },
    });
  });

  await trackEvent("generation_completed", { jobId: job.id, mode: payload.mode }, { userId: job.userId });
}

async function finalizeGenerationFailed(
  payload: Extract<AiFinalizePayload, { kind: "generation.failed" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job || job.status === "completed") return;
  await refundGeneration(job.userId, job.id, job.costDreamcoins, "failed", payload.error.code);
}

async function enqueueGenerationFailed(
  payload: ImageGeneratePayload | VideoGeneratePayload,
  code: string,
  message: string,
) {
  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.failed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: payload.kind,
      error: { code, message, retryable: false },
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:failed`,
  });
}

async function markGenerationRunning(generationJobId: string) {
  await prisma.generationJob.updateMany({
    where: { id: generationJobId, status: { in: ["queued", "running", "failed", "refunded"] } },
    data: { status: "running", errorCode: null },
  });
}

async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw new Error(result.error.message);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: result.data.status,
      policyCode: result.data.policyCode,
      confidence: result.data.confidence,
      details: {},
    },
  });

  return result.data;
}

async function refundGeneration(
  userId: string,
  jobId: string,
  cost: number,
  status: "failed" | "blocked",
  errorCode: string,
) {
  await prisma.$transaction(async (tx) => {
    const existingRefund = await tx.dreamcoinLedger.findFirst({
      where: { userId, sourceId: jobId, reason: "refund" },
    });
    if (!existingRefund && cost > 0) {
      await appendLedger(tx, userId, cost, "refund", jobId);
    }
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status, errorCode, completedAt: new Date() },
    });
  });
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
) {
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  const balance = aggregate._sum.delta ?? 0;
  return tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
    },
  });
}

async function imageUrlForCharacter(characterId?: string) {
  if (!characterId) return "/images/ourdream/promo-card-female.webp";
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    include: { imageAsset: true },
  });
  return character?.imageAsset?.url ?? "/images/ourdream/card-sarah-mercer.webp";
}

async function trackEvent(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
) {
  return prisma.analyticsEvent.create({
    data: {
      userId: ctx.userId,
      anonymousId: ctx.anonymousId,
      name,
      props: toInputJson(props),
    },
  });
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function cryptoRandomId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
