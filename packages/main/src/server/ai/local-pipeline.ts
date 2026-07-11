import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { mockVideoMp4Bytes } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS, MAIN_TO_CHAT_QUEUE, idempotencyKeys } from "@idream/shared/contracts";
import {
  GeneratedImageSanityError,
  assertGeneratedImageSanity,
} from "@idream/shared/media/generated-image-sanity";
import { jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { providers } from "@/server/providers";
import {
  markProductionItemFailed,
  markProductionItemGenerated,
} from "@/server/modules/admin/content-production-state";
import {
  aiFinalizePayloadSchema,
  imageGeneratePayloadSchema,
  type AiFinalizePayload,
  type ImageGeneratePayload,
  type VideoGeneratePayload,
  videoGeneratePayloadSchema,
} from "./schemas";
import { hydratedImageReferenceInputs } from "./reference-images";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import { ensureGenerationSettlementLinks, linkGenerationLedgerEntry } from "./generation-settlement";

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
    error?: string;
  }>;
  processed: number;
}

const placeholderImagePng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

function baselineGeneratedImageQuality() {
  return {
    ...generatedImageQualityEvidence(
      "sanity-v1",
      { status: "unscored" as const, reason: "artifact_evaluator_unavailable" },
    ),
    sanity: { status: "passed" as const },
  };
}

function unscoredGeneratedImageQuality() {
  return generatedImageQualityEvidence(
    "not_provided",
    { status: "unscored" as const, reason: "worker_did_not_provide_evidence" },
  );
}

function generatedImageQualityEvidence(
  evaluatorVersion: string,
  artifact: { status: "unscored"; reason: string },
) {
  return {
    schemaVersion: "1" as const,
    evaluatorVersion,
    artifact,
    faceCount: { status: "unscored" as const, reason: "evaluator_unavailable" },
    identity: { status: "unscored" as const, reason: "evaluator_unavailable" },
    intent: { status: "unscored" as const, reason: "evaluator_unavailable" },
  };
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
      claimedSummary.push({
        id: result.job.id,
        queue: result.job.queue,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
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
    return processCharacterPreview(job.payload, job);
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

async function processCharacterPreview(payloadValue: Prisma.JsonValue, jobMeta: QueueJob) {
  const { draftId, previewJobId } = previewPayloadSchema.parse(payloadValue);
  try {
    return await runCharacterPreview(draftId, previewJobId);
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await failPreview(previewJobId, "preview_worker_error");
  }
}

async function runCharacterPreview(draftId: string, previewJobId: string) {
  const job = await prisma.characterPreviewJob.findUnique({ where: { id: previewJobId } });
  if (!job || job.status === "completed" || job.status === "failed") return; // already settled / gone

  const draft = await prisma.characterDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    await failPreview(previewJobId, "draft_not_found");
    return;
  }

  const claimed = await prisma.characterPreviewJob.updateMany({
    where: { id: previewJobId, status: { notIn: ["completed", "failed"] } },
    data: { status: "running" },
  });
  if (claimed.count === 0) return;

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
  await markGenerationRunning(payload.generationJobId, payload.attemptId);
  const referenceImages = await hydratedImageReferenceInputs(
    payload.referenceImages,
    providers.blob,
  );

  const result = await providers.image.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: payload.requestId,
    orientation: payload.orientation,
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
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
    providerKey: string | null;
  }>;
  try {
    assets = await Promise.all(
      result.data.assets.map(async (asset, index) => {
        const hasProviderBody = Boolean(asset.body);
        const contentType = hasProviderBody ? (asset.contentType ?? "image/png") : "image/png";
        const key = generatedAssetStorageKey(
          payload.outputPrefix,
          `image-${index + 1}`,
          contentType,
          ".png",
        );
        const body = asset.body ?? new Uint8Array(placeholderImagePng);
        if (hasProviderBody) {
          assertGeneratedImageSanity(
            Buffer.from(body),
            `${payload.generationJobId} asset ${index + 1}`,
          );
        }
        const persisted = await providers.blob.putPrivate({
          key,
          body,
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
          providerKey: asset.key ?? null,
          quality: baselineGeneratedImageQuality(),
        };
      }),
    );
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await enqueueGenerationFailed(
      payload,
      error instanceof GeneratedImageSanityError ? error.code : "asset_persist_failed",
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
      attemptId: payload.attemptId,
      attemptNo: payload.attemptNo,
      mode: "image",
      assets,
      usage: { gpuSeconds: assets.length * 1.2, model: payload.model },
    } satisfies AiFinalizePayload),
    dedupeKey: generationFinalizeDedupeKey(payload, "completed"),
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
  await markGenerationRunning(payload.generationJobId, payload.attemptId);

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

  const contentType = "video/mp4";
  const assetKey = generatedAssetStorageKey(payload.outputPrefix, "video", contentType, ".mp4");
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
      attemptId: payload.attemptId,
      attemptNo: payload.attemptNo,
      mode: "video",
      assets: [
        {
          key: assetKey,
          seconds: result.data.asset.seconds,
          contentType,
          providerKey: result.data.asset.key ?? null,
        },
      ],
      usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
    } satisfies AiFinalizePayload),
    dedupeKey: generationFinalizeDedupeKey(payload, "completed"),
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
  const attempt = await resolveGenerationAttemptForFinalize(job.id, payload.attemptId);
  const attemptId = attempt?.id;
  await removeGenerationWorkQueueJob(job.id, job.mode);
  if (job.status === "completed") {
    await enqueueChatImageCompleted(job.id);
    return;
  }
  if (["failed", "blocked", "cancelled", "refunded"].includes(job.status)) {
    await prisma.$transaction(async (tx) => {
      if (attemptId) {
        await tx.generationArtifact.updateMany({
          where: { attemptId },
          data: { validationState: `late_after_${job.status}`, archiveState: "archived" },
        });
        await tx.mainOutboxEvent.updateMany({
          where: { id: `generation_manifest_${attemptId}` },
          data: { status: "delivered", deliveredAt: new Date() },
        });
      }
      await appendGenerationEvent(tx, job.id, "late_artifact_archived", "Provider artifacts arrived after a terminal Request outcome and were suppressed", { attemptId: attemptId ?? null, requestStatus: job.status, assetCount: payload.assets.length });
    });
    return;
  }

  await markGenerationModeratingOutput(job.id, payload.assets.length);

  const outputModeration = await moderateText(
    "generation_job",
    payload.generationJobId,
    payload.assets.map((asset) => asset.key).join(" "),
    "output",
  );
  if (outputModeration.status === "blocked") {
    await refundGeneration(
      job.userId,
      job.id,
      job.costDreamcoins,
      "blocked",
      "output_blocked",
      job.sourceType,
    );
    await enqueueChatImageFailed(job.id, "blocked", "output_blocked");
    return;
  }

  const existingAssets = await prisma.mediaAsset.count({
    where: { sourceJobId: payload.generationJobId },
  });

  await prisma.$transaction(async (tx) => {
    if (existingAssets === 0) {
      for (const [index, asset] of payload.assets.entries()) {
        const mediaId = `media_${cryptoRandomId()}`;
        const providerKey = typeof asset.providerKey === "string" ? asset.providerKey : asset.key;
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
            providerAssetId: providerKey,
            sourcePromptHash: job.prompt ? promptHash(job.prompt) : null,
            prompt: job.prompt,
            visibility: "private",
            safetyStatus: outputModeration.status,
            metadata: toInputJson({
              index,
              provider: "mock-pipeline",
              providerKey,
              contentType: asset.contentType,
              width: asset.width,
              height: asset.height,
              seconds: asset.seconds,
              usage: payload.usage,
              storageKey: asset.key,
              visualProfileId: job.visualProfileId,
              visualProfileVersion: job.visualProfileVersion,
              consistencyMode: job.consistencyMode,
              seed: job.seed,
              referenceAssetIds: job.referenceAssetIds,
              quality: asset.quality ?? unscoredGeneratedImageQuality(),
            }),
          },
        });
        await appendGenerationEvent(tx, job.id, "image_quality_scored", "Image quality evidence recorded", {
          mediaAssetId: mediaId,
          assetIndex: index,
          quality: asset.quality ?? unscoredGeneratedImageQuality(),
        });
      }
    }

    await appendGenerationEvent(tx, job.id, "moderation_passed", "Output moderation passed", {
      assets: payload.assets.length,
    });

    // INVARIANT: content_production jobs are never debited, so they must never be
    // credited on refund — their costDreamcoins is record-keeping only.
    const missingOutputs = Math.max(0, job.outputCount - payload.assets.length);
    if (missingOutputs > 0 && job.costDreamcoins > 0 && job.sourceType !== "content_production_item") {
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

    const completedAt = new Date();
    await tx.generationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        completedAt,
        finishedAt: completedAt,
        deliveredOutputCount: Math.min(job.outputCount, payload.assets.length),
        errorCode: null,
        version: { increment: 1 },
      },
    });
    if (attemptId) {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:terminal`,
        attemptId,
        eventType: "generation.attempt.succeeded.v1",
        outcome: "succeeded",
        occurredAt: completedAt,
        payload: {
          requestId: job.id,
          assetCount: payload.assets.length,
          expectedOutputCount: job.outputCount,
          completionManifestChecksum: payload.completionManifestChecksum ?? null,
        },
        completionManifestRef: payload.completionManifestRef ?? null,
      });
    }
    if (attemptId) {
      await tx.mainOutboxEvent.updateMany({
        where: { id: `generation_manifest_${attemptId}` },
        data: { status: "delivered", deliveredAt: new Date() },
      });
    }
    await appendGenerationEvent(tx, job.id, "completed", "Generation job completed", {
      assets: payload.assets.length,
      requested: job.outputCount,
    });
    const productionAsset = await tx.mediaAsset.findFirst({
      where: { sourceJobId: job.id },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (productionAsset) {
      await markProductionItemGenerated(tx, {
        jobId: job.id,
        mediaAssetId: productionAsset.id,
      });
    }
    const deliveredAssets = await tx.mediaAsset.findMany({
      where: { sourceJobId: job.id },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const attemptArtifacts = attemptId
      ? await tx.generationArtifact.findMany({
        where: { attemptId },
        orderBy: { ordinal: "asc" },
      })
      : [];
    for (const [index, asset] of deliveredAssets.entries()) {
      const artifact = attemptArtifacts[index];
      if (artifact) {
        await tx.generationArtifact.update({
          where: { id: artifact.id },
          data: { assetId: asset.id, validationState: "valid" },
        });
      }
      await tx.generationDelivery.upsert({
        where: {
          artifactId_targetType_targetId: {
            artifactId: artifact?.id ?? `legacy:${asset.id}`,
            targetType: "user_library",
            targetId: job.userId,
          },
        },
        create: {
          id: `generation_delivery_${job.id}_${index}`,
          requestId: job.id,
          artifactId: artifact?.id ?? `legacy:${asset.id}`,
          targetType: "user_library",
          targetId: job.userId,
          status: "delivered",
          deliveredAt: completedAt,
        },
        update: { status: "delivered", deliveredAt: completedAt },
      });
    }
    if (deliveredAssets.length > 0) {
      await appendLocalCanonicalProductEvent(tx, {
        sourceEventId: `generation-delivery:${job.id}:v2`,
        eventType: "generation.delivery.completed.v2",
        occurredAt: completedAt,
        userId: job.userId,
        context: { characterId: job.characterId, characterReleaseId: null },
        payload: {
          requestId: job.id,
          artifactId: deliveredAssets[0].id,
          userId: job.userId,
          expectedOutputCount: job.outputCount,
          deliveredOutputCount: deliveredAssets.length,
          valid: true,
          displayable: true,
        },
      });
    }
    await appendLocalCanonicalProductEvent(tx, {
      sourceEventId: `ai-usage:${attemptId ?? job.id}:v2`,
      eventType: "ai.usage.recorded.v2",
      occurredAt: completedAt,
      userId: job.userId,
      context: { characterId: job.characterId, characterReleaseId: null },
      payload: {
        invocationId: attemptId ?? job.id,
        requestId: job.id,
        ...(attemptId ? { attemptId } : {}),
        userId: job.userId,
        provider: job.provider ?? "local-pipeline",
        model: job.model ?? (typeof payload.usage.model === "string" ? payload.usage.model : "unknown"),
        usage: payload.usage,
        pricingVersion: `generation-${job.profileVersion ?? "legacy"}`,
      },
    });
  });

  await trackEvent("generation_completed", { jobId: job.id, mode: payload.mode }, { userId: job.userId });
  await enqueueChatImageCompleted(job.id);
}

async function appendLocalCanonicalProductEvent(
  tx: Prisma.TransactionClient,
  input: {
    sourceEventId: string;
    eventType: string;
    occurredAt: Date;
    userId: string;
    context: Readonly<Record<string, unknown>>;
    payload: Readonly<Record<string, unknown>>;
  },
) {
  await appendCanonicalMetricEvent(tx, input);
}

async function finalizeGenerationFailed(
  payload: Extract<AiFinalizePayload, { kind: "generation.failed" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const attempt = await resolveGenerationAttemptForFinalize(job.id, payload.attemptId);
  await removeGenerationWorkQueueJob(job.id, job.mode);
  if (["completed", "blocked", "refunded"].includes(job.status)) return;
  await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "failed",
    payload.error.code,
    job.sourceType,
    attempt?.id,
    { attemptOutcome: payload.error.attemptOutcome, retryability: payload.error.retryability },
  );
  await enqueueChatImageFailed(job.id, "failed", payload.error.code);
}

async function finalizeGenerationBlocked(
  payload: Extract<AiFinalizePayload, { kind: "generation.blocked" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const attempt = await resolveGenerationAttemptForFinalize(job.id, payload.attemptId);
  await removeGenerationWorkQueueJob(job.id, job.mode);
  if (["completed", "blocked", "refunded"].includes(job.status)) return;
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
  await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "blocked",
    payload.policyCode,
    job.sourceType,
    attempt?.id,
  );
  await enqueueChatImageFailed(job.id, "blocked", payload.policyCode);
}

async function resolveGenerationAttemptForFinalize(jobId: string, suppliedAttemptId?: string) {
  const attempt = suppliedAttemptId
    ? await prisma.generationAttempt.findFirst({
        where: { id: suppliedAttemptId, requestId: jobId },
      })
    : await prisma.generationAttempt.findFirst({
        where: { requestId: jobId },
        orderBy: { attemptNo: "desc" },
      });
  if (suppliedAttemptId && !attempt) {
    throw new Error(`Generation Attempt ${suppliedAttemptId} does not belong to Request ${jobId}`);
  }
  return attempt;
}

async function removeGenerationWorkQueueJob(jobId: string, mode: string) {
  const queue = mode === "video" ? "ai.video.generate" : "ai.image.generate";
  await jobQueue.removeByDedupePrefix(`generation:${jobId}`, [queue]);
}

async function enqueueChatImageCompleted(jobId: string) {
  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    include: { assets: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  if (!job || job.sourceType !== "chat_image" || !job.sourceId) return;
  const asset = job.assets[0];
  if (!asset) return;
  const eventId = `chat_image_completed_${job.sourceId}_${job.id}_${asset.id}`;
  await jobQueue.enqueue({
    queue: MAIN_TO_CHAT_QUEUE,
    payload: {
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
      payload: {
        version: 1,
        kind: "chat.image.completed",
        attachmentId: job.sourceId,
        generationJobId: job.id,
        mediaAssetId: asset.id,
        width: asset.width,
        height: asset.height,
        summary: chatImageCompletedSummary(job),
      },
    } as Prisma.InputJsonValue,
    dedupeKey: idempotencyKeys.chatInbox(eventId),
  });
}

// P4 Task 5: what the chat agent should recall having sent. sourceMeta.promptHint
// (the raw human-facing request, set on chat.image.requested — see service.ts
// buildChatImagePrompt) is preferred: job.prompt is the fully-composed generation
// prompt (character description + style directives), which at a 200-char clip
// would truncate away the actual request. job.prompt is the fallback for the rare
// case a job carries no hint. No extra query — job is already loaded.
function chatImageCompletedSummary(job: {
  prompt: string | null;
  sourceMeta: Prisma.JsonValue | null;
}): string | undefined {
  const sourceMeta =
    job.sourceMeta && typeof job.sourceMeta === "object" && !Array.isArray(job.sourceMeta)
      ? (job.sourceMeta as Record<string, unknown>)
      : {};
  const promptHint = typeof sourceMeta.promptHint === "string" ? sourceMeta.promptHint : null;
  const raw = promptHint?.trim() || job.prompt?.trim();
  if (!raw) return undefined;
  return raw.length <= 200 ? raw : `${raw.slice(0, 199)}…`;
}

async function enqueueChatImageFailed(
  jobId: string,
  status: "failed" | "blocked" | "refunded",
  errorCode: string,
) {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job || job.sourceType !== "chat_image" || !job.sourceId) return;
  const eventId = `chat_image_failed_${job.sourceId}_${job.id}_${status}_${errorCode}`;
  await jobQueue.enqueue({
    queue: MAIN_TO_CHAT_QUEUE,
    payload: {
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
      payload: {
        version: 1,
        kind: "chat.image.failed",
        attachmentId: job.sourceId,
        generationJobId: job.id,
        status,
        errorCode,
      },
    } as Prisma.InputJsonValue,
    dedupeKey: idempotencyKeys.chatInbox(eventId),
  });
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
      attemptId: payload.attemptId,
      attemptNo: payload.attemptNo,
      mode: payload.kind,
      error: { code, message, retryable: false },
    } satisfies AiFinalizePayload),
    dedupeKey: generationFinalizeDedupeKey(payload, "failed"),
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
      attemptId: payload.attemptId,
      attemptNo: payload.attemptNo,
      mode: payload.kind,
      policyCode,
      message,
      layer,
    } satisfies AiFinalizePayload),
    dedupeKey: generationFinalizeDedupeKey(payload, "blocked"),
  });
}

function generationFinalizeDedupeKey(
  payload: { generationJobId: string; attemptId?: string; attemptNo?: number },
  outcome: "completed" | "failed" | "blocked",
) {
  return payload.attemptId && (payload.attemptNo ?? 1) > 1
    ? `generation-finalize:${payload.generationJobId}:${payload.attemptId}:${outcome}`
    : `generation-finalize:${payload.generationJobId}:${outcome}`;
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

async function markGenerationRunning(generationJobId: string, attemptId?: string) {
  await prisma.$transaction(async (tx) => {
    await tx.generationJob.updateMany({
      where: { id: generationJobId, status: { in: ["queued", "moderating_input", "running"] } },
      data: { status: "running", errorCode: null },
    });
    if (attemptId) {
      const attempt = await tx.generationAttempt.findFirstOrThrow({
        where: { id: attemptId, requestId: generationJobId },
      });
      const startedAt = attempt.startedAt ?? new Date();
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:running`,
        attemptId,
        eventType: "generation.attempt.running.v1",
        occurredAt: startedAt,
        payload: { requestId: generationJobId },
        status: "running",
        startedAt,
      });
    }
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
  sourceType: string,
  attemptId?: string,
  terminal: { attemptOutcome?: "failed" | "unknown"; retryability?: "retryable" | "not_retryable" | "operator_retry" } = {},
) {
  // INVARIANT: content_production jobs are never debited, so they must never be
  // credited on refund — their costDreamcoins is record-keeping only (ops batches
  // don't charge a wallet on creation).
  const isDebitedJob = sourceType !== "content_production_item";
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${jobId} FOR UPDATE`;
    const settlement = isDebitedJob ? await ensureGenerationSettlementLinks(tx, jobId) : { refundable: 0 };
    const refundAmount = Math.min(cost, settlement.refundable);
    if (refundAmount > 0 && isDebitedJob) {
      await appendLedger(
        tx,
        userId,
        refundAmount,
        "refund",
        jobId,
        `generation:${jobId}:refund`,
      );
    }
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status, errorCode, completedAt: null, finishedAt: new Date(), deliveredOutputCount: 0, version: { increment: 1 } },
    });
    if (attemptId) {
      const attempt = await tx.generationAttempt.findFirstOrThrow({
        where: { id: attemptId, requestId: jobId },
      });
      const finishedAt = attempt.finishedAt ?? new Date();
      const attemptOutcome = terminal.attemptOutcome ?? "failed";
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:terminal`,
        attemptId,
        eventType: `generation.attempt.${attemptOutcome}.v1`,
        outcome: attemptOutcome,
        occurredAt: finishedAt,
        payload: {
          requestId: jobId,
          requestOutcome: status,
          errorCode,
          refundAmount,
        },
        errorCode,
        errorClass: attemptOutcome === "unknown" ? "ambiguous_provider_outcome" : undefined,
        errorSignature: attemptOutcome === "unknown" ? `ambiguous_provider_outcome:${errorCode}` : undefined,
        retryability: terminal.retryability ?? (status === "failed" ? "retryable" : "not_retryable"),
        operatorGuidance: attemptOutcome === "unknown" ? "Reconcile the provider request before any business retry." : undefined,
      });
    }
    await markProductionItemFailed(tx, jobId);
    await appendGenerationEvent(tx, jobId, status, `Generation job ${status}`, {
      errorCode,
    });
    await appendGenerationEvent(tx, jobId, "refunded", "Dreamcoins refunded", {
      amount: refundAmount,
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
    if (existing) {
      await linkGenerationLedgerEntry(tx, existing);
      return existing;
    }
  }
  await lockUserLedger(tx, userId);
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  const balance = aggregate._sum.delta ?? 0;
  const created = await tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
      idempotencyKey,
    },
  });
  await linkGenerationLedgerEntry(tx, created);
  return created;
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

function generatedAssetStorageKey(
  outputPrefix: string,
  name: string,
  contentType: string | undefined,
  fallbackExtension: string,
) {
  return `${outputPrefix}${name}${mediaFileExtension(contentType) || fallbackExtension}`;
}

function mediaRouteToken(id: string) {
  return Buffer.from(id, "utf8").toString("base64url");
}
