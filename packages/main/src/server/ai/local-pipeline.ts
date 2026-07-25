import type { Prisma } from "@prisma/client";
import { mockVideoMp4Bytes } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS, MAIN_TO_CHAT_QUEUE, idempotencyKeys } from "@idream/shared/contracts";
import {
  GeneratedImageSanityError,
  assertGeneratedImageSanity,
  type GeneratedImageSanityEvidence,
} from "@idream/shared/media/generated-image-sanity";
import { jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";
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
import {
  transitionGenerationRequest,
  transitionGenerationRequestWithDisposition,
} from "./generation-request-transition";
import { ensureGenerationSettlementLinks, linkGenerationLedgerEntry } from "./generation-settlement";
import {
  isGenerationArtifactArchiveTransitionAllowed,
  isGenerationArtifactValidationTransitionAllowed,
  isGenerationDeliveryTransitionAllowed,
} from "./generation-evidence-transition-authority";

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
    error?: string;
  }>;
  processed: number;
}

class GeneratedAssetBodyMissingError extends Error {
  readonly code = "asset_body_missing";

  constructor(message: string) {
    super(message);
    this.name = "GeneratedAssetBodyMissingError";
  }
}

function baselineGeneratedImageQuality(
  evidence: GeneratedImageSanityEvidence,
) {
  return {
    ...generatedImageQualityEvidence(
      evidence.evaluatorVersion,
      { status: "unscored" as const, reason: "artifact_evaluator_unavailable" },
    ),
    sanity: evidence.sanity,
    composition: evidence.composition,
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
  videoTimeoutMs?: number;
  limit?: number;
} = {}) {
  const now = input.now ?? new Date();
  const timeoutMs =
    input.timeoutMs ??
    Number.parseInt(process.env.JOB_STALE_TIMEOUT_MS ?? `${10 * 60 * 1000}`, 10);
  const videoTimeoutMs =
    input.videoTimeoutMs ??
    Number.parseInt(
      process.env.VIDEO_JOB_STALE_TIMEOUT_MS ?? `${35 * 60 * 1000}`,
      10,
    );
  const cutoff = new Date(now.getTime() - timeoutMs);
  const videoCutoff = new Date(now.getTime() - videoTimeoutMs);
  const jobs = await prisma.generationJob.findMany({
    where: {
      status: { in: ["queued", "moderating_input", "running", "moderating_output"] },
      OR: [
        { mode: "video", updatedAt: { lt: videoCutoff } },
        { mode: { not: "video" }, updatedAt: { lt: cutoff } },
      ],
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

  return { scanned: jobs.length, enqueued: jobs.length, cutoff, videoCutoff };
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

  throw new Error(`Unsupported local AI queue: ${job.queue}`);
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
  if (!inputModeration) return;
  if (inputModeration.status === "blocked") {
    await enqueueGenerationBlocked(
      payload,
      inputModeration.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }
  if (!await markGenerationRunning(payload.generationJobId, payload.attemptId)) return;
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
        if (!asset.body) {
          throw new GeneratedAssetBodyMissingError(
            `Image provider returned no bytes for asset ${index + 1}`,
          );
        }
        const contentType = asset.contentType ?? "image/png";
        const key = generatedAssetStorageKey(
          payload.outputPrefix,
          `image-${index + 1}`,
          contentType,
          ".png",
        );
        const body = asset.body;
        const sanityEvidence = assertGeneratedImageSanity(
          Buffer.from(body),
          `${payload.generationJobId} asset ${index + 1}`,
          {
            singleContinuousFrame:
              payload.controls.compositionRequirement ===
              "single_subject_single_frame",
          },
        );
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
          quality: baselineGeneratedImageQuality(sanityEvidence),
        };
      }),
    );
  } catch (error) {
    if (!isFinalAttempt(jobMeta)) throw error;
    await enqueueGenerationFailed(
      payload,
      error instanceof GeneratedImageSanityError || error instanceof GeneratedAssetBodyMissingError
        ? error.code
        : "asset_persist_failed",
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
      provider: env.IMAGE_PROVIDER,
      model: payload.model,
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
  if (!inputModeration) return;
  if (inputModeration.status === "blocked") {
    await enqueueGenerationBlocked(
      payload,
      inputModeration.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }
  if (!await markGenerationRunning(payload.generationJobId, payload.attemptId)) return;

  const result = await providers.video.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: payload.requestId,
    referenceImages: payload.referenceImages,
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
      provider: "mock",
      model: payload.model,
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

  if (payload.kind === "character.preview.completed") {
    return finalizeCharacterPreviewCompleted(payload);
  }
  if (payload.kind === "character.preview.failed") {
    return finalizeCharacterPreviewFailed(payload);
  }
  if (payload.kind === "generation.completed") return finalizeGenerationCompleted(payload);
  if (payload.kind === "generation.failed") return finalizeGenerationFailed(payload);
  if (payload.kind === "generation.blocked") return finalizeGenerationBlocked(payload);
}

async function finalizeCharacterPreviewCompleted(
  payload: Extract<AiFinalizePayload, { kind: "character.preview.completed" }>,
) {
  const previewJob = await prisma.characterPreviewJob.findFirst({
    where: {
      id: payload.previewJobId,
      draftId: payload.draftId,
    },
    include: {
      draft: {
        select: {
          ownerId: true,
          name: true,
        },
      },
    },
  });
  if (!previewJob || previewJob.status === "completed" || previewJob.status === "failed") {
    return;
  }
  if (previewJob.draft.ownerId !== payload.userId) {
    await finalizeCharacterPreviewFailed({
      version: 1,
      kind: "character.preview.failed",
      requestId: payload.requestId,
      previewJobId: payload.previewJobId,
      draftId: payload.draftId,
      userId: payload.userId,
      error: {
        code: "preview_owner_mismatch",
        message: "Character preview owner did not match the authoritative draft",
        retryable: false,
      },
    });
    return;
  }

  const mediaId = `media_preview_${payload.previewJobId}`;
  const displayUrl =
    `/user-content/${mediaRouteToken(mediaId)}/content` +
    mediaFileExtension(payload.asset.contentType);
  const providerKey =
    typeof payload.asset.providerKey === "string"
      ? payload.asset.providerKey
      : payload.asset.key;

  await prisma.$transaction(async (tx) => {
    await tx.mediaAsset.upsert({
      where: { id: mediaId },
      update: {},
      create: {
        id: mediaId,
        ownerId: payload.userId,
        type: "image",
        url: displayUrl,
        thumbnailUrl: displayUrl,
        storageKey: payload.asset.key,
        contentType: payload.asset.contentType,
        width: payload.asset.width,
        height: payload.asset.height,
        providerAssetId: providerKey,
        prompt: previewJob.draft.name,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {
          provider: payload.provider,
          model: payload.model,
          providerKey,
          source: "character_preview",
          synthetic: payload.provider === "mock",
        },
      },
    });
    const settled = await tx.characterPreviewJob.updateMany({
      where: {
        id: payload.previewJobId,
        draftId: payload.draftId,
        status: { notIn: ["completed", "failed"] },
      },
      data: {
        status: "completed",
        provider: payload.provider,
        resultAssetId: mediaId,
        errorCode: null,
        completedAt: new Date(),
      },
    });
    if (settled.count === 1) {
      await tx.characterDraft.updateMany({
        where: { id: payload.draftId, ownerId: payload.userId },
        data: { previewJobId: payload.previewJobId },
      });
    }
  });
}

async function finalizeCharacterPreviewFailed(
  payload: Extract<AiFinalizePayload, { kind: "character.preview.failed" }>,
) {
  await prisma.characterPreviewJob.updateMany({
    where: {
      id: payload.previewJobId,
      draftId: payload.draftId,
      draft: { ownerId: payload.userId },
      status: { notIn: ["completed", "failed"] },
    },
    data: {
      status: "failed",
      errorCode: payload.error.code,
      completedAt: new Date(),
    },
  });
}

async function recordTerminalArtifactDeliveryEvidence(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly targetId: string;
    readonly validationState: string;
    readonly deliveryStatus: "failed" | "suppressed";
  },
) {
  const artifacts = await tx.generationArtifact.findMany({
    where: { attemptId: input.attemptId },
    orderBy: { ordinal: "asc" },
  });
  for (const artifact of artifacts) {
    if (
      !isGenerationArtifactValidationTransitionAllowed(
        artifact.validationState,
        input.validationState,
      ) ||
      !isGenerationArtifactArchiveTransitionAllowed(
        artifact.archiveState,
        "archived",
      )
    ) {
      throw Errors.conflict("Terminal Request outcome cannot rewrite Artifact evidence", {
        artifactId: artifact.id,
        validationState: artifact.validationState,
        archiveState: artifact.archiveState,
      });
    }
    const artifactUpdated = await tx.generationArtifact.updateMany({
      where: {
        id: artifact.id,
        validationState: artifact.validationState,
        archiveState: artifact.archiveState,
      },
      data: {
        validationState: input.validationState,
        archiveState: "archived",
      },
    });
    if (artifactUpdated.count !== 1) {
      throw Errors.conflict("Artifact evidence changed during terminal projection", {
        artifactId: artifact.id,
      });
    }

    const deliveryKey = {
      artifactId_targetType_targetId: {
        artifactId: artifact.id,
        targetType: "user_library",
        targetId: input.targetId,
      },
    } as const;
    const existingDelivery = await tx.generationDelivery.findUnique({
      where: deliveryKey,
    });
    const fromStatus = existingDelivery?.status ?? "pending";
    if (!isGenerationDeliveryTransitionAllowed(fromStatus, input.deliveryStatus)) {
      throw Errors.conflict("Generation Delivery is already terminal", {
        deliveryId: existingDelivery?.id ?? null,
        status: fromStatus,
      });
    }
    if (existingDelivery) {
      const deliveryUpdated = await tx.generationDelivery.updateMany({
        where: { id: existingDelivery.id, status: existingDelivery.status },
        data: { status: input.deliveryStatus, deliveredAt: null },
      });
      if (deliveryUpdated.count !== 1) {
        throw Errors.conflict("Generation Delivery changed during terminal projection", {
          deliveryId: existingDelivery.id,
        });
      }
    } else {
      await tx.generationDelivery.create({
        data: {
          id: `generation_delivery_${input.requestId}_${artifact.ordinal}`,
          requestId: input.requestId,
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: input.targetId,
          status: input.deliveryStatus,
        },
      });
    }
  }
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
        const validationState = `late_after_${job.status}`;
        await recordTerminalArtifactDeliveryEvidence(tx, {
          requestId: job.id,
          attemptId,
          targetId: job.userId,
          validationState,
          deliveryStatus: "suppressed",
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

  if (!await markGenerationModeratingOutput(job.id, payload.assets.length)) return;

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
          `/user-content/${mediaRouteToken(mediaId)}/content${mediaFileExtension(asset.contentType)}`;
        await tx.mediaAsset.create({
          data: {
            id: mediaId,
            ownerId: job.userId,
            sourceJobId: job.id,
            characterId: job.characterId,
            type: payload.mode,
            url: displayUrl,
            thumbnailUrl: payload.mode === "image" ? displayUrl : null,
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
              provider: payload.provider ?? job.provider ?? "unknown",
              providerKey,
              synthetic: payload.provider?.startsWith("mock") ?? false,
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
    await transitionGenerationRequest(tx, {
      requestId: job.id,
      to: "completed",
      expected: { from: "moderating_output" },
      data: {
        completedAt,
        finishedAt: completedAt,
        deliveredOutputCount: Math.min(job.outputCount, payload.assets.length),
        errorCode: null,
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
        if (!isGenerationArtifactValidationTransitionAllowed(artifact.validationState, "valid")) {
          throw Errors.conflict("Artifact validation is already terminal", {
            artifactId: artifact.id,
            validationState: artifact.validationState,
          });
        }
        await tx.generationArtifact.update({
          where: { id: artifact.id },
          data: { assetId: asset.id, validationState: "valid" },
        });
      }
      const deliveryKey = {
        artifactId_targetType_targetId: {
          artifactId: artifact?.id ?? `legacy:${asset.id}`,
          targetType: "user_library",
          targetId: job.userId,
        },
      };
      const existingDelivery = await tx.generationDelivery.findUnique({ where: deliveryKey });
      if (existingDelivery && !isGenerationDeliveryTransitionAllowed(existingDelivery.status, "delivered")) {
        throw Errors.conflict("Generation Delivery is already terminal", {
          deliveryId: existingDelivery.id,
          status: existingDelivery.status,
        });
      }
      await tx.generationDelivery.upsert({
        where: deliveryKey,
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
    if (!payload.completionManifestRef) {
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
          provider: payload.provider ?? job.provider ?? "local-pipeline",
          model: payload.model ?? job.model ??
            (typeof payload.usage.model === "string" ? payload.usage.model : "unknown"),
          usage: payload.usage,
          pricingVersion: null,
        },
      });
    }
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
  if (["completed", "failed", "blocked", "refunded", "cancelled"].includes(job.status)) return;
  const transitioned = await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "failed",
    payload.error.code,
    job.sourceType,
    attempt?.id,
    { attemptOutcome: payload.error.attemptOutcome, retryability: payload.error.retryability },
  );
  if (transitioned) await enqueueChatImageFailed(job.id, "failed", payload.error.code);
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
  if (["completed", "failed", "blocked", "refunded", "cancelled"].includes(job.status)) return;
  const transitioned = await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "blocked",
    payload.policyCode,
    job.sourceType,
    attempt?.id,
    {
      moderation: {
        layer: payload.layer,
        policyCode: payload.policyCode,
        message: payload.message,
      },
    },
  );
  if (transitioned) await enqueueChatImageFailed(job.id, "blocked", payload.policyCode);
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
  const transitioned = await prisma.$transaction(async (tx) => {
    const result = await transitionGenerationRequestWithDisposition(tx, {
      requestId: payload.generationJobId,
      to: "moderating_input",
      expected: { from: ["queued", "moderating_input"] },
      data: { errorCode: null },
      onConflict: "return-null",
    });
    if (!result) return false;
    if (result.disposition === "applied") {
      await appendGenerationEvent(
        tx,
        payload.generationJobId,
        "moderating_input",
        "Input moderation started",
        { requestId: payload.requestId },
      );
    }
    return true;
  });
  if (!transitioned) return null;
  return moderateText(
    "generation_job",
    payload.generationJobId,
    `${payload.prompt} ${payload.negativePrompt ?? ""}`,
    "input",
  );
}

async function markGenerationRunning(generationJobId: string, attemptId?: string) {
  return prisma.$transaction(async (tx) => {
    const result = await transitionGenerationRequestWithDisposition(tx, {
      requestId: generationJobId,
      to: "running",
      expected: { from: ["queued", "moderating_input", "running"] },
      data: { errorCode: null },
      onConflict: "return-null",
    });
    if (!result) return false;
    if (attemptId && result.disposition === "applied") {
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
    if (result.disposition === "applied") {
      await appendGenerationEvent(tx, generationJobId, "running", "Provider generation started", {});
    }
    return true;
  });
}

async function markGenerationModeratingOutput(generationJobId: string, assetCount: number) {
  return prisma.$transaction(async (tx) => {
    const result = await transitionGenerationRequestWithDisposition(tx, {
      requestId: generationJobId,
      to: "moderating_output",
      expected: { from: ["queued", "moderating_input", "running", "moderating_output"] },
      onConflict: "return-null",
    });
    if (!result) return false;
    if (result.disposition === "applied") {
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
    }
    return true;
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
  terminal: {
    attemptOutcome?: "failed" | "unknown";
    retryability?: "retryable" | "not_retryable" | "operator_retry";
    moderation?: { layer: string; policyCode: string; message: string };
  } = {},
) {
  // INVARIANT: content_production jobs are never debited, so they must never be
  // credited on refund — their costDreamcoins is record-keeping only (ops batches
  // don't charge a wallet on creation).
  const isDebitedJob = sourceType !== "content_production_item";
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${jobId} FOR UPDATE`;
    const transitioned = await transitionGenerationRequest(tx, {
      requestId: jobId,
      to: status,
      expected: { from: ["queued", "moderating_input", "running", "moderating_output"] },
      data: {
        errorCode,
        completedAt: null,
        finishedAt: new Date(),
        deliveredOutputCount: 0,
      },
      onConflict: "return-null",
    });
    if (!transitioned) return false;
    if (terminal.moderation) {
      await tx.moderationEvent.create({
        data: {
          targetType: "generation_job",
          targetId: jobId,
          layer: terminal.moderation.layer,
          status: "blocked",
          policyCode: terminal.moderation.policyCode,
          confidence: 1,
          details: toInputJson({ message: terminal.moderation.message }),
        },
      });
    }
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
    if (attemptId) {
      await recordTerminalArtifactDeliveryEvidence(tx, {
        requestId: jobId,
        attemptId,
        targetId: userId,
        validationState: status === "blocked" ? "rejected" : "invalid",
        deliveryStatus: "failed",
      });
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
    return true;
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
  return createClassifiedAnalyticsEvent(prisma, {
    userId: ctx.userId,
    anonymousId: ctx.anonymousId,
    name,
    props,
    sourceService: "main-worker",
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
