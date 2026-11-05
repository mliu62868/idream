// SPEC: projects one terminal outcome onto the Request: delivered assets and their
// settlement, or the failed, unknown or blocked disposition. Keyed by the finalize
// payload's discriminated union (ADR-13 §2.1.1).
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  appendCanonicalMetricEvent,
} from "@/server/modules/admin-v2/metrics/event-writer";
import {
  createClassifiedAnalyticsEvent,
} from "@/server/modules/admin-v2/metrics/classified-event-writer";
import { moderateText } from "@/server/moderation/text-authority";
import { markProductionItemGenerated } from "@/server/modules/content-production-state";
import { aiFinalizePayloadSchema, type AiFinalizePayload } from "./schemas";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import {
  transitionGenerationRequest,
  transitionGenerationRequestWithDisposition,
} from "./generation-request-transition";
import { refundGenerationRequest } from "./generation-refund";
import { lockGenerationRequestForSettlement } from "./generation-settlement";
import {
  deliverGenerationArtifacts,
  lateArtifactDisposition,
  projectAttemptArtifactDisposition,
} from "./generation-evidence-transition-authority";
import { removeGenerationAttemptQueueJob } from "./generation-attempt-queue";
import {
  createDeliveredGenerationAsset,
  generatedAssetQuality,
} from "./generation-asset-delivery";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { appendGenerationEvent, markGenerationTerminalRecordDelivered, toInputJson } from "./generation-finalize-events";
import { refundGeneration } from "./generation-terminal-settlement";

type GenerationFinalizePayload = Extract<
  AiFinalizePayload,
  { kind: `generation.${string}` }
>;

function isGenerationFinalize(
  payload: AiFinalizePayload,
): payload is GenerationFinalizePayload {
  return payload.kind.startsWith("generation.");
}

export async function processFinalize(payloadValue: Prisma.JsonValue) {
  const payload = aiFinalizePayloadSchema.parse(payloadValue);
  if (!isGenerationFinalize(payload)) return;

  // INTENT: the raw queue value travels alongside the parsed one because the
  // durable terminal-record match is a statement about the delivered wire bytes.
  // Hashing the parsed projection instead would make the check depend on which
  // fields the current schema happens to retain.
  switch (payload.kind) {
    case "generation.completed":
      return finalizeGenerationCompleted(payload, payloadValue);
    case "generation.failed":
      return finalizeGenerationFailed(payload, payloadValue);
    case "generation.unknown":
      return finalizeGenerationUnknown(payload, payloadValue);
    case "generation.blocked":
      return finalizeGenerationBlocked(payload, payloadValue);
    default: {
      // INVARIANT: every generation.* finalize kind is routed above. This
      // assignment stops compiling the moment one is added and left unhandled —
      // falling through silently would strand the Request and its held funds.
      const unhandled: never = payload;
      throw new Error(
        `Unhandled generation finalize kind: ${(unhandled as { kind: string }).kind}`,
      );
    }
  }
}

async function finalizeGenerationCompleted(
  payload: Extract<AiFinalizePayload, { kind: "generation.completed" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  const attemptId = resolved.attempt.id;
  if (job.status === "completed") return;
  if (["failed", "blocked", "cancelled", "refunded"].includes(job.status)) {
    await prisma.$transaction(async (tx) => {
      const validationState =
        lateArtifactDisposition({ requestStatus: job.status }) ??
          "late_after_failed";
      await projectAttemptArtifactDisposition(tx, {
        requestId: job.id,
        attemptId,
        targetId: job.userId,
        validationState,
        deliveryStatus: "suppressed",
        occurredAt: new Date(),
      });
      await markGenerationTerminalRecordDelivered(tx, attemptId);
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
      attemptId,
      {
        attemptOutcome: "blocked",
        retryability: "not_retryable",
        terminalRecordRef: payload.terminalRecordRef,
        terminalRecordChecksum: payload.terminalRecordChecksum,
      },
    );
    return;
  }

  const existingAssets = await prisma.mediaAsset.count({
    where: { sourceJobId: payload.generationJobId },
  });

  await prisma.$transaction(async (tx) => {
    await lockGenerationRequestForSettlement(tx, job.id);
    if (existingAssets === 0) {
      for (const [index, asset] of payload.assets.entries()) {
        const mediaId = `media_${cryptoRandomId()}`;
        await createDeliveredGenerationAsset(tx, {
          id: mediaId,
          request: job,
          payload,
          provider: payload.provider ?? job.provider ?? "unknown",
          asset,
          ordinal: index,
          safetyStatus: outputModeration.status,
        });
        await appendGenerationEvent(tx, job.id, "image_quality_scored", "Image quality evidence recorded", {
          mediaAssetId: mediaId,
          assetIndex: index,
          quality: generatedAssetQuality(asset),
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
      const amount = await refundGenerationRequest(tx, {
        requestId: job.id,
        userId: job.userId,
        cause: { kind: "partial" },
        requested: Math.ceil((job.costDreamcoins * missingOutputs) / job.outputCount),
      });
      if (amount > 0) {
        await appendGenerationEvent(tx, job.id, "refunded", "Partial generation refund issued", {
          amount,
          missingOutputs,
        });
      }
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
        terminalRecordChecksum: payload.terminalRecordChecksum ?? null,
      },
      terminalRecordRef: payload.terminalRecordRef ?? null,
    });
    await markGenerationTerminalRecordDelivered(tx, attemptId);
    await appendGenerationEvent(tx, job.id, "completed", "Generation job completed", {
      assets: payload.assets.length,
      requested: job.outputCount,
    });
    const persistedAssets = await tx.mediaAsset.findMany({
      where: { sourceJobId: job.id },
      select: { id: true, width: true, height: true, metadata: true },
    });
    const persistedAssetsByOrdinal = new Map<number, (typeof persistedAssets)[number]>();
    for (const asset of persistedAssets) {
      const ordinal = mediaAssetGenerationOrdinal(asset.metadata);
      if (ordinal === null) continue;
      if (persistedAssetsByOrdinal.has(ordinal)) {
        throw Errors.conflict("Generation produced duplicate MediaAsset ordinals", {
          requestId: job.id,
          ordinal,
        });
      }
      persistedAssetsByOrdinal.set(ordinal, asset);
    }
    const deliveredAssets = payload.assets.map((_, ordinal) => {
      const asset = persistedAssetsByOrdinal.get(ordinal);
      if (!asset) {
        throw Errors.conflict("Generation Artifact ordinal has no persisted MediaAsset", {
          requestId: job.id,
          ordinal,
        });
      }
      return asset;
    });
    const productionAsset = deliveredAssets[0];
    if (productionAsset) {
      await markProductionItemGenerated(tx, {
        jobId: job.id,
        mediaAssetId: productionAsset.id,
      });
    }
    await deliverGenerationArtifacts(tx, {
      requestId: job.id,
      attemptId,
      targetId: job.userId,
      assets: deliveredAssets.map((asset, ordinal) => ({
        ordinal,
        assetId: asset.id,
      })),
      occurredAt: completedAt,
    });
    if (deliveredAssets.length > 0) {
      await appendCanonicalProductEvent(tx, {
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
    const chatAsset = deliveredAssets[0];
    if (chatAsset && (job.sourceType === "chat_image" || job.sourceType === "chat_video")) {
      // Main owns both the Generation Request and the user-visible Turn. The
      // delivery transaction projects the attachment directly; no callback to
      // Chat and no second product-state machine are involved.
      await tx.chatTurnAttachment.updateMany({
        where: { generationJobId: job.id },
        data: {
          status: "completed",
          mediaAssetId: chatAsset.id,
          width: chatAsset.width,
          height: chatAsset.height,
          errorCode: null,
        },
      });
    }
    if (!payload.terminalRecordRef) {
      await appendCanonicalProductEvent(tx, {
        sourceEventId: `ai-usage:${attemptId}:v2`,
        eventType: "ai.usage.recorded.v2",
        occurredAt: completedAt,
        userId: job.userId,
        context: { characterId: job.characterId, characterReleaseId: null },
        payload: {
          invocationId: attemptId,
          requestId: job.id,
          attemptId,
          userId: job.userId,
          provider: payload.provider ?? job.provider ?? "unknown",
          model: payload.model ?? job.model ??
            (typeof payload.usage.model === "string" ? payload.usage.model : "unknown"),
          usage: payload.usage,
          pricingVersion: null,
        },
      });
    }
  });

  await trackEvent("generation_completed", { jobId: job.id, mode: payload.mode }, { userId: job.userId });
}

async function appendCanonicalProductEvent(
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
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  if (["completed", "failed", "blocked", "refunded", "cancelled"].includes(job.status)) return;
  await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "failed",
    payload.error.code,
    job.sourceType,
    resolved.attempt.id,
    {
      attemptOutcome: "failed",
      retryability: payload.error.retryability,
      terminalRecordRef: payload.terminalRecordRef,
      terminalRecordChecksum: payload.terminalRecordChecksum,
    },
  );
}

// SPEC: an ambiguous provider outcome settles nothing. No refund is issued and
// no business retry is allowed until an operator reconciles the provider request.
// INVARIANT: reachable only from the generation.unknown finalize variant, so a
// plain failure can never be routed here (and vice versa).
async function finalizeGenerationUnknown(
  payload: Extract<AiFinalizePayload, { kind: "generation.unknown" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  const attemptId = resolved.attempt.id;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generation_jobs WHERE id = ${job.id} FOR UPDATE
    `);
    const current = await tx.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    if (
      !["queued", "moderating_input", "running", "moderating_output"].includes(
        current.status,
      )
    ) return;
    const latest = await tx.generationAttempt.findFirst({
      where: { requestId: current.id },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    if (latest?.id !== attemptId) return;
    const attempt = await tx.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    if (attempt.status !== "unknown") {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:terminal`,
        attemptId,
        eventType: "generation.attempt.unknown.v1",
        outcome: "unknown",
        occurredAt: attempt.finishedAt ?? new Date(),
        payload: {
          requestId: current.id,
          requestOutcome: "needs_reconciliation",
          errorCode: payload.error.code,
          terminalRecordChecksum: payload.terminalRecordChecksum,
        },
        terminalRecordRef: payload.terminalRecordRef,
        errorCode: payload.error.code,
        errorClass: "ambiguous_provider_outcome",
        errorSignature: `ambiguous_provider_outcome:${payload.error.code}`,
        retryability: payload.error.retryability ?? "operator_retry",
        operatorGuidance:
          "Reconcile the provider request before settlement or business retry.",
      });
    }
    await markGenerationTerminalRecordDelivered(tx, attemptId);
    await tx.generationJobEvent.upsert({
      where: { id: `generation_request_unknown_${attemptId}` },
      create: {
        id: `generation_request_unknown_${attemptId}`,
        jobId: current.id,
        type: "provider_outcome_unknown",
        message: "Provider outcome is unknown and requires operator reconciliation",
        metadata: toInputJson({
          attemptId,
          errorCode: payload.error.code,
          terminalRecordRef: payload.terminalRecordRef,
          terminalRecordChecksum: payload.terminalRecordChecksum,
        }),
      },
      update: {},
    });
  });
}

async function finalizeGenerationBlocked(
  payload: Extract<AiFinalizePayload, { kind: "generation.blocked" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  if (["completed", "failed", "blocked", "refunded", "cancelled"].includes(job.status)) return;
  await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "blocked",
    payload.policyCode,
    job.sourceType,
    resolved.attempt.id,
    {
      attemptOutcome: "blocked",
      retryability: "not_retryable",
      terminalRecordRef: payload.terminalRecordRef,
      terminalRecordChecksum: payload.terminalRecordChecksum,
      moderation: {
        layer: payload.layer,
        policyCode: payload.policyCode,
        message: payload.message,
      },
    },
  );
}

async function resolveGenerationAttemptForFinalize(
  jobId: string,
  payload: Extract<
    AiFinalizePayload,
    {
      kind:
        | "generation.completed"
        | "generation.failed"
        | "generation.unknown"
        | "generation.blocked";
    }
  >,
  rawPayload: Prisma.JsonValue,
) {
  const [attempt, latestAttempt, terminalOutbox] = await Promise.all([
    prisma.generationAttempt.findFirst({
      where: {
        id: payload.attemptId,
        requestId: jobId,
        attemptNo: payload.attemptNo,
      },
    }),
    prisma.generationAttempt.findFirst({
      where: { requestId: jobId },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    }),
    prisma.mainOutboxEvent.findUnique({
      where: { id: `generation_terminal_record_${payload.attemptId}` },
    }),
  ]);
  if (!attempt) {
    throw Errors.conflict(
      "Generation finalize Attempt identity does not belong to the Request",
      {
        requestId: jobId,
        attemptId: payload.attemptId,
        attemptNo: payload.attemptNo,
      },
    );
  }
  if (
    !terminalOutbox ||
    terminalOutbox.eventType !== "generation.terminal_record.accepted.v1" ||
    terminalOutbox.aggregateType !== "generation_attempt" ||
    terminalOutbox.aggregateId !== attempt.id ||
    canonicalSha256(terminalOutbox.payload) !== canonicalSha256(rawPayload)
  ) {
    throw Errors.conflict(
      "Generation finalize payload does not match its durable terminal record",
      { requestId: jobId, attemptId: attempt.id },
    );
  }
  return { attempt, isLatest: latestAttempt?.id === attempt.id };
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

function mediaAssetGenerationOrdinal(metadata: Prisma.JsonValue | null) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    return null;
  }
  const ordinal = metadata.index;
  return typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0
    ? ordinal
    : null;
}

function cryptoRandomId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
