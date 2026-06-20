import type { Prisma } from "@prisma/client";
import { jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import {
  aiFinalizePayloadSchema,
  imageGeneratePayloadSchema,
  memoryForgetPayloadSchema,
  memoryRebuildPayloadSchema,
  memorySyncPayloadSchema,
  type AiFinalizePayload,
  type ImageGeneratePayload,
  type MemoryRebuildPayload,
  type MemorySyncPayload,
  type VideoGeneratePayload,
  videoGeneratePayloadSchema,
} from "./schemas";

export const localAiQueueNames = [
  "ai.memory.sync",
  "ai.memory.forget",
  "ai.memory.rebuild",
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

type SyncedMemory = Extract<MemorySyncPayload["changes"][number], { operation: "upsert" }>["memory"];

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
  if (job.queue === "ai.memory.sync") {
    return processMemorySync(job.payload);
  }
  if (job.queue === "ai.memory.forget") {
    return processMemoryForget(job.payload);
  }
  if (job.queue === "ai.memory.rebuild") {
    return processMemoryRebuild(job.payload);
  }
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

async function processMemoryForget(payloadValue: Prisma.JsonValue) {
  const payload = memoryForgetPayloadSchema.parse(payloadValue);
  const ids = new Set([
    ...payload.memoryIds,
    ...(payload.scope === "memory" ? payload.targetIds : []),
  ]);
  const messageIds = new Set(payload.scope === "message" ? payload.targetIds : []);
  if (payload.sourceMessageId) messageIds.add(payload.sourceMessageId);

  if (payload.sessionId) {
    const sessionMemories = await prisma.companionMemory.findMany({
      where: {
        userId: payload.userId,
        sessionId: payload.sessionId,
        status: "active",
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const memory of sessionMemories) ids.add(memory.id);
  }

  if (messageIds.size > 0) {
    const memories = await prisma.companionMemory.findMany({
      where: { userId: payload.userId, status: "active", deletedAt: null },
      select: { id: true, sourceMessageIds: true },
    });
    for (const memory of memories) {
      if (jsonStringArray(memory.sourceMessageIds).some((id) => messageIds.has(id))) {
        ids.add(memory.id);
      }
    }
  }

  if (payload.scope === "character") {
    await prisma.companionMemory.findMany({
      where: {
        userId: payload.userId,
        characterId: { in: payload.targetIds },
        status: "active",
        deletedAt: null,
      },
      select: { id: true },
    }).then((memories) => memories.forEach((memory) => ids.add(memory.id)));
  }

  if (payload.scope === "account") {
    await prisma.companionMemory.findMany({
      where: { userId: payload.userId, status: "active", deletedAt: null },
      select: { id: true },
    }).then((memories) => memories.forEach((memory) => ids.add(memory.id)));
  }

  if (ids.size > 0) {
    await prisma.companionMemory.updateMany({
      where: { id: { in: [...ids] }, userId: payload.userId },
      data: {
        status: "deleted",
        deletedAt: new Date(),
      },
    });
  }

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "memory.forgotten",
      requestId: payload.requestId,
      userId: payload.userId,
      scope: payload.scope,
      targetIds: payload.targetIds,
      deletedMemoryIds: [...ids],
      reason: payload.reason,
    } satisfies AiFinalizePayload),
    dedupeKey: `memory-forgotten:${payload.requestId}`,
  });
}

async function processMemorySync(payloadValue: Prisma.JsonValue) {
  const payload = memorySyncPayloadSchema.parse(payloadValue);
  await prisma.$transaction(async (tx) => {
    for (const change of payload.changes) {
      if (change.operation === "delete") {
        await tx.companionMemory.updateMany({
          where: { id: change.memoryId, userId: payload.userId },
          data: { status: "deleted", deletedAt: new Date() },
        });
        continue;
      }

      await upsertSyncedMemory(tx, payload, change.memory);
    }
  });
}

async function processMemoryRebuild(payloadValue: Prisma.JsonValue) {
  const payload = memoryRebuildPayloadSchema.parse(payloadValue);
  const snapshotIds = new Set(payload.source.memories.map((memory) => memory.id));

  await prisma.$transaction(async (tx) => {
    await tx.companionMemory.updateMany({
      where: {
        userId: payload.userId,
        characterId: payload.characterId ?? undefined,
        status: "active",
        deletedAt: null,
        id: snapshotIds.size > 0 ? { notIn: [...snapshotIds] } : undefined,
      },
      data: { status: "deleted", deletedAt: new Date() },
    });

    for (const memory of payload.source.memories) {
      await upsertSyncedMemory(tx, payload, memory);
    }
  });
}

async function upsertSyncedMemory(
  tx: Prisma.TransactionClient,
  payload: MemorySyncPayload | MemoryRebuildPayload,
  memory: SyncedMemory,
) {
  const deleted = memory.status === "deleted";
  await tx.companionMemory.upsert({
    where: { id: memory.id },
    update: {
      userId: payload.userId,
      characterId: memory.scope === "global" ? null : (memory.characterId ?? payload.characterId ?? null),
      sessionId: memory.scope === "session" ? (memory.sessionId ?? null) : null,
      scope: memory.scope,
      type: memory.type,
      text: memory.text,
      confidence: memory.confidence,
      status: memory.status,
      sourceMessageIds: toInputJson(memory.sourceMessageIds),
      deletedAt: deleted ? new Date() : null,
    },
    create: {
      id: memory.id,
      userId: payload.userId,
      characterId: memory.scope === "global" ? null : (memory.characterId ?? payload.characterId ?? null),
      sessionId: memory.scope === "session" ? (memory.sessionId ?? null) : null,
      scope: memory.scope,
      type: memory.type,
      text: memory.text,
      confidence: memory.confidence,
      status: memory.status,
      sourceMessageIds: toInputJson(memory.sourceMessageIds),
      deletedAt: deleted ? new Date() : null,
    },
  });
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

  if (payload.kind === "memory.forgotten") return finalizeMemoryForgotten(payload);
  if (payload.kind === "generation.completed") return finalizeGenerationCompleted(payload);
  if (payload.kind === "generation.failed") return finalizeGenerationFailed(payload);
}

async function finalizeMemoryForgotten(
  payload: Extract<AiFinalizePayload, { kind: "memory.forgotten" }>,
) {
  await trackEvent(
    "memory_forgotten",
    {
      requestId: payload.requestId,
      scope: payload.scope,
      targetIds: payload.targetIds,
      deletedMemoryIds: payload.deletedMemoryIds,
      reason: payload.reason,
    },
    { userId: payload.userId },
  );
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

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function cryptoRandomId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
