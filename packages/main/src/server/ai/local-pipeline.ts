import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { mockVideoMp4Bytes } from "@idream/shared";
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
  // character preview: enqueued by previewDraft, drained here so slow image
  // providers don't block the HTTP request (the client polls the job status).
  "character.preview",
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

const placeholderImagePng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

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

export async function reconcileStaleGenerationJobs(input: {
  now?: Date;
  timeoutMs?: number;
  limit?: number;
} = {}) {
  const now = input.now ?? new Date();
  const timeoutMs =
    input.timeoutMs ??
    Number.parseInt(process.env.JOB_STALE_TIMEOUT_MS ?? `${10 * 60 * 1000}`, 10);
  const cutoff = new Date(now.getTime() - timeoutMs);
  const jobs = await prisma.generationJob.findMany({
    where: {
      status: { in: ["queued", "moderating_input", "running", "moderating_output"] },
      updatedAt: { lt: cutoff },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(input.limit ?? 25, 100)),
  });

  for (const job of jobs) {
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: toInputJson({
        version: 1,
        kind: "generation.failed",
        requestId: `stale_${job.id}`,
        generationJobId: job.id,
        mode: job.mode === "video" ? "video" : "image",
        error: {
          code: "stale_timeout",
          message: "Generation job exceeded the stale timeout",
          retryable: false,
        },
      } satisfies AiFinalizePayload),
      dedupeKey: `generation-finalize:${job.id}:failed`,
    });
  }

  return { scanned: jobs.length, enqueued: jobs.length, cutoff };
}

async function processLocalAiJob(job: QueueJob) {
  if (job.queue === "ai.image.generate") {
    return processImageGenerate(job.payload, job);
  }
  if (job.queue === "ai.video.generate") {
    return processVideoGenerate(job.payload, job);
  }
  if (job.queue === "app.ai.finalize") {
    return processFinalize(job.payload);
  }
  if (job.queue === "character.preview") {
    return processCharacterPreview(job.payload);
  }

  throw new Error(`Unsupported local AI queue: ${job.queue}`);
}

// SPEC: async character preview. previewDraft enqueues {draftId, previewJobId};
// this generates the preview image off the request path and settles the
// CharacterPreviewJob to completed|failed so the client poll resolves.
// INVARIANTS: terminal-only outcome (never strands at running); idempotent — a
// re-delivered job whose preview already completed (or whose job/draft row is
// gone) is a no-op. ownerId is read from the draft (SSoT), not the payload.
const previewPayloadSchema = z.object({
  draftId: z.string().min(1),
  previewJobId: z.string().min(1),
});

async function processCharacterPreview(payloadValue: Prisma.JsonValue) {
  const { draftId, previewJobId } = previewPayloadSchema.parse(payloadValue);

  const job = await prisma.characterPreviewJob.findUnique({ where: { id: previewJobId } });
  if (!job || job.status === "completed") return; // already settled / gone

  const draft = await prisma.characterDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    await failPreview(previewJobId, "draft_not_found");
    return;
  }

  await prisma.characterPreviewJob.update({
    where: { id: previewJobId },
    data: { status: "running" },
  });

  const image = await providers.image.generate({
    prompt: draft.name ?? "custom character",
    count: 1,
    seed: draftId,
  });
  if (!image.ok) {
    await failPreview(previewJobId, image.error.code ?? "preview_generate_failed");
    return;
  }

  // Persist the generated image and expose it via the same /user-content route as
  // normal generation, so the preview shows the REAL character image. Mock
  // providers return no body → fall back to the placeholder PNG bytes. The storage
  // key is per-job (previewJobId) so regenerating the same draft can't collide on
  // the unique storageKey.
  const generated = image.data.assets[0];
  const contentType = generated?.contentType ?? "image/png";
  const key = `preview/${previewJobId}${mediaFileExtension(contentType)}`;
  const persisted = await providers.blob.putPrivate({
    key,
    body: generated?.body ?? new Uint8Array(placeholderImagePng),
    contentType,
  });
  if (!persisted.ok) {
    await failPreview(previewJobId, "preview_persist_failed");
    return;
  }

  const mediaId = `media_${cryptoRandomId()}`;
  const displayUrl = `/user-content/${mediaRouteToken(mediaId)}/content${mediaFileExtension(contentType)}`;
  const asset = await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      ownerId: draft.ownerId,
      type: "image",
      url: displayUrl,
      thumbnailUrl: displayUrl,
      storageKey: key,
      contentType,
      width: generated?.width,
      height: generated?.height,
      providerAssetId: key,
      prompt: draft.name,
      visibility: "private",
      safetyStatus: "passed",
      metadata: { providerKey: key, source: "character_preview" },
    },
  });

  await prisma.characterPreviewJob.update({
    where: { id: previewJobId },
    data: { status: "completed", resultAssetId: asset.id, completedAt: new Date() },
  });
  await prisma.characterDraft.update({
    where: { id: draftId },
    data: { previewJobId },
  });
}

// updateMany (not update) so a job row deleted mid-flight settles to a no-op
// instead of throwing and forcing a pointless BullMQ retry.
async function failPreview(previewJobId: string, errorCode: string) {
  await prisma.characterPreviewJob.updateMany({
    where: { id: previewJobId },
    data: { status: "failed", errorCode, completedAt: new Date() },
  });
}

async function processImageGenerate(payloadValue: Prisma.JsonValue, jobMeta: QueueJob) {
  // SPEC: any unhandled error (moderation calls, status writes, provider throws,
  // finalize enqueue) must not strand the job in a non-terminal state with coins
  // debited. On the final attempt funnel to a refund-emitting generation.failed;
  // otherwise rethrow so the queue keeps retrying.
  const payload = imageGeneratePayloadSchema.parse(payloadValue);
  try {
    return await runImageGenerate(payload, jobMeta);
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await enqueueGenerationFailed(
      payload,
      "worker_error",
      errorMessage(error, "Image generation worker failed"),
    );
  }
}

async function runImageGenerate(payload: ImageGeneratePayload, jobMeta: QueueJob) {
  const inputModeration = await markGenerationModeratingInput(payload);
  if (inputModeration.status === "blocked") {
    await enqueueGenerationBlocked(
      payload,
      inputModeration.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }
  await markGenerationRunning(payload.generationJobId);

  const result = await providers.image.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: payload.requestId,
    orientation: payload.orientation,
  });

  if (!result.ok) {
    if (result.error.retryable && !isFinalAttempt(jobMeta)) throw new Error(result.error.message);
    if (result.error.code === "content_blocked") {
      await enqueueGenerationBlocked(payload, result.error.code, result.error.message, "provider");
      return;
    }
    await enqueueGenerationFailed(payload, result.error.code, result.error.message);
    return;
  }

  if (result.data.assets.length === 0) {
    await enqueueGenerationFailed(
      payload,
      "empty_provider_result",
      "Image provider returned no assets",
    );
    return;
  }

  let assets: Array<{
    key: string;
    width: number;
    height: number;
    contentType: string;
  }>;
  try {
    assets = await Promise.all(
      result.data.assets.map(async (asset, index) => {
        const key = asset.key || `${payload.outputPrefix}${index}.webp`;
        const hasProviderBody = Boolean(asset.body);
        const contentType = hasProviderBody ? (asset.contentType ?? "image/png") : "image/png";
        const persisted = await providers.blob.putPrivate({
          key,
          body: asset.body ?? new Uint8Array(placeholderImagePng),
          contentType,
        });
        if (!persisted.ok) {
          throw new Error(`Blob write failed for ${key}: ${persisted.error.message}`);
        }
        return {
          key,
          width: asset.width,
          height: asset.height,
          contentType,
        };
      }),
    );
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await enqueueGenerationFailed(
      payload,
      "asset_persist_failed",
      errorMessage(error, "Failed to persist generated image assets"),
    );
    return;
  }

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

async function processVideoGenerate(payloadValue: Prisma.JsonValue, jobMeta: QueueJob) {
  // Same final-attempt funnel as the image worker — see processImageGenerate.
  const payload = videoGeneratePayloadSchema.parse(payloadValue);
  try {
    return await runVideoGenerate(payload, jobMeta);
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await enqueueGenerationFailed(
      payload,
      "worker_error",
      errorMessage(error, "Video generation worker failed"),
    );
  }
}

async function runVideoGenerate(payload: VideoGeneratePayload, jobMeta: QueueJob) {
  const inputModeration = await markGenerationModeratingInput(payload);
  if (inputModeration.status === "blocked") {
    await enqueueGenerationBlocked(
      payload,
      inputModeration.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }
  await markGenerationRunning(payload.generationJobId);

  const result = await providers.video.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: payload.requestId,
  });

  if (!result.ok) {
    if (result.error.retryable && !isFinalAttempt(jobMeta)) throw new Error(result.error.message);
    if (result.error.code === "content_blocked") {
      await enqueueGenerationBlocked(payload, result.error.code, result.error.message, "provider");
      return;
    }
    await enqueueGenerationFailed(payload, result.error.code, result.error.message);
    return;
  }

  const assetKey = result.data.asset.key || `${payload.outputPrefix}video.mp4`;
  const contentType = "video/mp4";
  try {
    const persisted = await providers.blob.putPrivate({
      key: assetKey,
      body: mockVideoMp4Bytes(),
      contentType,
    });
    if (!persisted.ok) {
      throw new Error(`Blob write failed for ${assetKey}: ${persisted.error.message}`);
    }
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await enqueueGenerationFailed(
      payload,
      "asset_persist_failed",
      errorMessage(error, "Failed to persist generated video asset"),
    );
    return;
  }

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
          key: assetKey,
          seconds: result.data.asset.seconds,
          contentType,
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
  if (payload.kind === "generation.blocked") return finalizeGenerationBlocked(payload);
}

async function finalizeGenerationCompleted(
  payload: Extract<AiFinalizePayload, { kind: "generation.completed" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  if (job.status === "completed") return;
  if (["failed", "blocked", "refunded"].includes(job.status)) return;

  await markGenerationModeratingOutput(job.id, payload.assets.length);

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

  await prisma.$transaction(async (tx) => {
    if (existingAssets === 0) {
      for (const [index, asset] of payload.assets.entries()) {
        const mediaId = `media_${cryptoRandomId()}`;
        const displayUrl =
          payload.mode === "image"
            ? `/user-content/${mediaRouteToken(mediaId)}/content${mediaFileExtension(asset.contentType)}`
            : "/images/ourdream/promo-card-female.webp";
        await tx.mediaAsset.create({
          data: {
            id: mediaId,
            ownerId: job.userId,
            sourceJobId: job.id,
            characterId: job.characterId,
            type: payload.mode,
            url: displayUrl,
            thumbnailUrl: displayUrl,
            storageKey: asset.key,
            contentType: asset.contentType,
            width: asset.width,
            height: asset.height,
            providerAssetId: asset.key,
            sourcePromptHash: job.prompt ? promptHash(job.prompt) : null,
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

    await appendGenerationEvent(tx, job.id, "moderation_passed", "Output moderation passed", {
      assets: payload.assets.length,
    });

    const missingOutputs = Math.max(0, job.outputCount - payload.assets.length);
    if (missingOutputs > 0 && job.costDreamcoins > 0) {
      const refundAmount = Math.ceil((job.costDreamcoins * missingOutputs) / job.outputCount);
      await appendLedger(
        tx,
        job.userId,
        refundAmount,
        "refund",
        job.id,
        `generation:${job.id}:partial-refund`,
      );
      await appendGenerationEvent(tx, job.id, "refunded", "Partial generation refund issued", {
        amount: refundAmount,
        missingOutputs,
      });
    }

    await tx.generationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        errorCode: null,
      },
    });
    await appendGenerationEvent(tx, job.id, "completed", "Generation job completed", {
      assets: payload.assets.length,
      requested: job.outputCount,
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
  if (!job || ["completed", "blocked", "refunded"].includes(job.status)) return;
  await refundGeneration(job.userId, job.id, job.costDreamcoins, "failed", payload.error.code);
}

async function finalizeGenerationBlocked(
  payload: Extract<AiFinalizePayload, { kind: "generation.blocked" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job || ["completed", "blocked", "refunded"].includes(job.status)) return;
  await prisma.moderationEvent.create({
    data: {
      targetType: "generation_job",
      targetId: job.id,
      layer: payload.layer,
      status: "blocked",
      policyCode: payload.policyCode,
      confidence: 1,
      details: toInputJson({ message: payload.message }),
    },
  });
  await refundGeneration(job.userId, job.id, job.costDreamcoins, "blocked", payload.policyCode);
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

async function enqueueGenerationBlocked(
  payload: ImageGeneratePayload | VideoGeneratePayload,
  policyCode: string,
  message: string,
  layer: "input" | "output" | "provider",
) {
  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.blocked",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: payload.kind,
      policyCode,
      message,
      layer,
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:blocked`,
  });
}

async function markGenerationModeratingInput(payload: ImageGeneratePayload | VideoGeneratePayload) {
  await prisma.$transaction(async (tx) => {
    await tx.generationJob.updateMany({
      where: { id: payload.generationJobId, status: { in: ["queued", "moderating_input"] } },
      data: { status: "moderating_input", errorCode: null },
    });
    await appendGenerationEvent(
      tx,
      payload.generationJobId,
      "moderating_input",
      "Input moderation started",
      { requestId: payload.requestId },
    );
  });
  return moderateText(
    "generation_job",
    payload.generationJobId,
    `${payload.prompt} ${payload.negativePrompt ?? ""}`,
    "input",
  );
}

async function markGenerationRunning(generationJobId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.generationJob.updateMany({
      where: { id: generationJobId, status: { in: ["queued", "moderating_input", "running"] } },
      data: { status: "running", errorCode: null },
    });
    await appendGenerationEvent(tx, generationJobId, "running", "Provider generation started", {});
  });
}

async function markGenerationModeratingOutput(generationJobId: string, assetCount: number) {
  await prisma.$transaction(async (tx) => {
    await tx.generationJob.updateMany({
      where: { id: generationJobId, status: { in: ["running", "moderating_output"] } },
      data: { status: "moderating_output" },
    });
    await appendGenerationEvent(
      tx,
      generationJobId,
      "provider_completed",
      "Provider returned assets",
      { assetCount },
    );
    await appendGenerationEvent(
      tx,
      generationJobId,
      "moderating_output",
      "Output moderation started",
      { assetCount },
    );
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
    if (cost > 0) {
      await appendLedger(
        tx,
        userId,
        cost,
        "refund",
        jobId,
        `generation:${jobId}:refund`,
      );
    }
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status, errorCode, completedAt: new Date() },
    });
    await appendGenerationEvent(tx, jobId, status, `Generation job ${status}`, {
      errorCode,
    });
    await appendGenerationEvent(tx, jobId, "refunded", "Dreamcoins refunded", {
      amount: cost,
    });
  });
}

async function appendGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
  idempotencyKey?: string,
) {
  if (idempotencyKey) {
    const existing = await tx.dreamcoinLedger.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
  }
  await lockUserLedger(tx, userId);
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
      idempotencyKey,
    },
  });
}

async function lockUserLedger(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
}

function isFinalAttempt(job: QueueJob) {
  return job.attemptsMade + 1 >= job.maxAttempts;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function promptHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = (hash * 33) ^ char.charCodeAt(0);
  return `prompt_${Math.abs(hash)}`;
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

function mediaFileExtension(contentType: string | undefined) {
  const extensions: Record<string, string> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return contentType ? (extensions[contentType] ?? "") : "";
}

function mediaRouteToken(id: string) {
  return Buffer.from(id, "utf8").toString("base64url");
}
