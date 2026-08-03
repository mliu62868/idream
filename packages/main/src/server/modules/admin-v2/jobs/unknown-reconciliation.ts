import { randomUUID } from "node:crypto";
import {
  MAIN_TO_CHAT_EVENTS,
  aiFinalizePayloadSchema,
  type AiFinalizePayload,
} from "@idream/shared/contracts";
import {
  unknownGenerationReconciliationResultSchema,
  type UnknownGenerationReconciliationCommand,
  type UnknownGenerationReconciliationResult,
} from "@idream/shared/admin";
import {
  Prisma,
  type GenerationAttempt,
  type GenerationJob,
} from "@prisma/client";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import { ensureGenerationSettlementLinks } from "@/server/ai/generation-settlement";
import { refundGenerationRequest } from "@/server/ai/generation-refund";
import { removeGenerationAttemptQueueJob } from "@/server/ai/generation-attempt-queue";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { adoptRecoveredUnknownArtifacts } from "@/server/ai/generation-evidence-transition-authority";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  markProductionItemFailed,
  markProductionItemGenerated,
} from "@/server/modules/content-production-state";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { providers } from "@/server/providers";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

const ACTIVE_REQUEST_STATUSES = [
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
] as const;
const RECONCILABLE_REQUEST_STATUSES = [
  ...ACTIVE_REQUEST_STATUSES,
  "failed",
] as const;
const MAX_REVIEW_DELAY_MS = 90 * 24 * 60 * 60 * 1_000;
const RECOVERED_SUCCESS_EVENT_TYPES = [
  "unknown_terminal_evidence_recovered",
  "unknown_terminal_resolution_evidence_recovered",
] as const;
const TERMINAL_UNKNOWN_RECONCILIATION_EVENT_TYPES = [
  "unknown_reconciliation_adopt_succeeded",
  "unknown_reconciliation_confirm_failed",
] as const;

type UnknownReconciliationActor = {
  readonly id: string;
  readonly role: string;
};

export async function reconcileUnknownGenerationRequest(input: {
  readonly requestId: string;
  readonly command: UnknownGenerationReconciliationCommand;
  readonly actor: UnknownReconciliationActor;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly now?: Date;
}): Promise<UnknownGenerationReconciliationResult> {
  const now = input.now ?? new Date();
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalSha256({
    commandType: "generation.request.reconcile_unknown",
    requestId: input.requestId,
    entityVersion: input.command.entityVersion,
    resolution: input.command.resolution,
    reason: input.command.reason,
    providerEvidenceRefs: input.command.providerEvidenceRefs,
    nextReviewAt:
      input.command.resolution === "remain_unknown"
        ? input.command.nextReviewAt
        : null,
  });
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey },
    },
  });
  if (existing) {
    const replay = replayUnknownReconciliation(existing, requestHash);
    if (replay.resolution === "confirm_failed") {
      await removeGenerationAttemptQueueJob({
        requestId: input.requestId,
        attemptId: replay.attemptId,
      }).catch(() => false);
    }
    return replay;
  }

  const recoveredSuccess = input.command.resolution === "adopt_succeeded"
    ? await prepareRecoveredSuccessAdoption(input.requestId)
    : null;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${input.idempotencyKey}`}))`;
    const replay = await tx.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey },
      },
    });
    if (replay) return replayUnknownReconciliation(replay, requestHash);

    const requestLock = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM generation_jobs WHERE id = ${input.requestId} FOR UPDATE
    `);
    if (requestLock.length !== 1) {
      throw Errors.notFound("Generation Request not found");
    }
    const request = await tx.generationJob.findUniqueOrThrow({
      where: { id: input.requestId },
    });
    if (request.version !== input.command.entityVersion) {
      throw Errors.conflict("Generation Request changed before unknown reconciliation", {
        expectedVersion: input.command.entityVersion,
        actualVersion: request.version,
      });
    }
    if (!(RECONCILABLE_REQUEST_STATUSES as readonly string[]).includes(request.status)) {
      throw Errors.conflict("Generation Request cannot reconcile an unknown Attempt from its current status", {
        requestStatus: request.status,
      });
    }

    const latestAttempt = await tx.generationAttempt.findFirst({
      where: { requestId: request.id },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
    });
    if (!latestAttempt) {
      throw Errors.conflict("Generation Request has no Attempt to reconcile");
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generation_attempts WHERE id = ${latestAttempt.id} FOR UPDATE
    `);
    const latestAfterLock = await tx.generationAttempt.findFirst({
      where: { requestId: request.id },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
    });
    if (latestAfterLock?.id !== latestAttempt.id || latestAfterLock.status !== "unknown") {
      throw Errors.conflict("Latest Generation Attempt is not an unknown outcome", {
        latestAttemptId: latestAfterLock?.id ?? null,
        latestAttemptStatus: latestAfterLock?.status ?? null,
      });
    }

    const priorTerminalDecisions = await tx.generationJobEvent.findMany({
      where: {
        jobId: request.id,
        type: { in: [...TERMINAL_UNKNOWN_RECONCILIATION_EVENT_TYPES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const priorTerminalDecision = priorTerminalDecisions.find(
      (event) => jsonRecord(event.metadata).attemptId === latestAttempt.id,
    );
    if (priorTerminalDecision) {
      throw Errors.conflict(
        "Unknown Generation Attempt already has a terminal operator resolution",
        {
          requestId: request.id,
          attemptId: latestAttempt.id,
          resolution: priorTerminalDecision.type.replace(
            "unknown_reconciliation_",
            "",
          ),
          reconciliationEventId: priorTerminalDecision.id,
        },
      );
    }

    const nextReviewAt = validateNextReviewAt(input.command, now);
    if (input.command.resolution === "confirm_failed") {
      const [deliveredCount, resolvedSuccess] = await Promise.all([
        tx.generationDelivery.count({
          where: { requestId: request.id, status: "delivered" },
        }),
        validatedUnknownSuccessResolution(tx, latestAttempt.id),
      ]);
      if (resolvedSuccess) {
        throw Errors.conflict(
          "Recovered provider success exists; confirm_failed cannot overwrite it",
          {
            attemptId: latestAttempt.id,
            terminalRecordRef: resolvedSuccess.payload.terminalRecordRef,
            resolutionReceiptId: resolvedSuccess.receiptId,
          },
        );
      }
      if (deliveredCount > 0 || request.deliveredOutputCount > 0) {
        throw Errors.conflict(
          "Delivered output exists; confirm_failed cannot suppress successful customer delivery",
          { deliveredCount, deliveredOutputCount: request.deliveredOutputCount },
        );
      }
    }

    const commandId = randomUUID();
    let requestStatus = request.status;
    let requestVersion = request.version;
    let refundAmount = 0;
    let deliveredCount = 0;
    if (input.command.resolution === "adopt_succeeded") {
      if (!recoveredSuccess) {
        throw Errors.conflict("Recovered success evidence is unavailable");
      }
      const adopted = await adoptRecoveredSuccess(tx, {
        request,
        attempt: latestAttempt,
        evidence: recoveredSuccess,
        now,
      });
      requestStatus = adopted.requestStatus;
      requestVersion = adopted.requestVersion;
      refundAmount = adopted.refundAmount;
      deliveredCount = adopted.deliveredCount;
    }
    if (input.command.resolution === "confirm_failed") {
      const transitioned = await transitionGenerationRequest(tx, {
        requestId: request.id,
        to: "failed",
        expected: {
          from: RECONCILABLE_REQUEST_STATUSES,
          version: input.command.entityVersion,
        },
        data: {
          errorCode: "operator_confirmed_provider_failure",
          deliveredOutputCount: 0,
          completedAt: null,
          finishedAt: now,
        },
      });
      requestStatus = transitioned.status;
      requestVersion = transitioned.version;
      if (request.sourceType !== "content_production_item") {
        const refundedAmount = await refundGenerationRequest(tx, {
          requestId: request.id,
          userId: request.userId,
          cause: { kind: "unknown_confirmed" },
          requested: request.costDreamcoins,
        });
        refundAmount = refundedAmount;
      }
      await markProductionItemFailed(tx, request.id);
      if (request.sourceType === "chat_image" && request.sourceId) {
        await recordMainToChatEvent({
          eventId: `chat_image_failed_${request.sourceId}_${request.id}_unknown_confirmed_failed`,
          eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
          aggregateType: "chat_attachment",
          aggregateId: request.sourceId,
          payload: {
            version: 1,
            kind: "chat.image.failed",
            attachmentId: request.sourceId,
            generationJobId: request.id,
            status: "failed",
            errorCode: "operator_confirmed_provider_failure",
          },
        }, tx);
      }
    }

    const response = unknownGenerationReconciliationResultSchema.parse({
      commandId,
      requestId: request.id,
      attemptId: latestAttempt.id,
      attemptStatus: "unknown",
      resolution: input.command.resolution,
      requestStatus,
      version: requestVersion,
      refundAmount,
      deliveredCount,
      nextReviewAt: nextReviewAt?.toISOString() ?? null,
      reconciledAt: now.toISOString(),
    });
    const evidence = {
      providerEvidenceRefs: input.command.providerEvidenceRefs,
      nextReviewAt: response.nextReviewAt,
    };

    await tx.generationJobEvent.create({
      data: {
        jobId: request.id,
        type: `unknown_reconciliation_${input.command.resolution}`,
        message: input.command.reason,
        metadata: toInputJson({
          commandId,
          actorId: input.actor.id,
          attemptId: latestAttempt.id,
          resolution: input.command.resolution,
          refundAmount,
          deliveredCount,
          ...evidence,
        }),
      },
    });
    await tx.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope,
        idempotencyKey: input.idempotencyKey,
        commandType: "generation.request.reconcile_unknown",
        targetType: "generation_request",
        targetId: request.id,
        actorId: input.actor.id,
        requestId: input.traceId,
        requestHash,
        requestPayload: toInputJson({
          expectedVersion: input.command.entityVersion,
          resolution: input.command.resolution,
          reason: input.command.reason,
          ...evidence,
        }),
        expectedVersion: input.command.entityVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson(response),
        finishedAt: now,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: `generation.request.unknown.${input.command.resolution}`,
        targetType: "generation_request",
        targetId: request.id,
        reason: input.command.reason,
        before: toInputJson({
          requestStatus: request.status,
          requestVersion: request.version,
          attemptId: latestAttempt.id,
          attemptStatus: latestAttempt.status,
        }),
        after: toInputJson({ ...response, ...evidence }),
        requestId: input.traceId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        id: `generation_unknown_reconciliation_${commandId}`,
        eventType: "generation.request.unknown_reconciled.v2",
        aggregateType: "generation_request",
        aggregateId: request.id,
        payload: toInputJson({ ...response, ...evidence }),
      },
    });
    return response;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (result.resolution === "confirm_failed") {
    await removeGenerationAttemptQueueJob({
      requestId: input.requestId,
      attemptId: result.attemptId,
    }).catch(() => false);
  }
  return result;
}

function replayUnknownReconciliation(
  command: { readonly requestHash: string; readonly result: Prisma.JsonValue | null },
  requestHash: string,
) {
  if (command.requestHash !== requestHash) {
    throw Errors.conflict(
      "Idempotency key is bound to another unknown Generation reconciliation",
    );
  }
  return unknownGenerationReconciliationResultSchema.parse(command.result);
}

function validateNextReviewAt(
  command: UnknownGenerationReconciliationCommand,
  now: Date,
) {
  if (command.resolution !== "remain_unknown") return null;
  const nextReviewAt = new Date(command.nextReviewAt);
  if (nextReviewAt.getTime() <= now.getTime()) {
    throw Errors.badRequest("Unknown outcome next review must be in the future");
  }
  if (nextReviewAt.getTime() - now.getTime() > MAX_REVIEW_DELAY_MS) {
    throw Errors.badRequest("Unknown outcome next review cannot be more than 90 days away");
  }
  return nextReviewAt;
}

type RecoveredSuccessPayload = Extract<
  AiFinalizePayload,
  { kind: "generation.completed" }
>;

type PreparedRecoveredSuccess = {
  readonly eventId: string;
  readonly eventType: (typeof RECOVERED_SUCCESS_EVENT_TYPES)[number];
  readonly receiptSource: "gen" | "gen_resolution";
  readonly evidenceHash: string;
  readonly payload: RecoveredSuccessPayload;
  readonly moderation: {
    readonly status: "passed" | "flagged";
    readonly policyCode?: string;
    readonly confidence: number;
  };
};

async function validatedUnknownSuccessResolution(
  tx: Prisma.TransactionClient,
  attemptId: string,
) {
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: attemptId },
    select: { requestId: true, status: true },
  });
  if (!attempt || attempt.status !== "unknown") return null;
  const event = await tx.generationJobEvent.findFirst({
    where: {
      jobId: attempt.requestId,
      type: { in: [...RECOVERED_SUCCESS_EVENT_TYPES] },
      metadata: { path: ["attemptId"], equals: attemptId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const metadata = jsonRecord(event?.metadata);
  const parsed = aiFinalizePayloadSchema.safeParse(metadata.recoveredSuccess);
  if (
    !event ||
    !parsed.success ||
    parsed.data.kind !== "generation.completed" ||
    parsed.data.attemptId !== attemptId ||
    parsed.data.generationJobId !== attempt.requestId
  ) return null;
  const expectedHash = canonicalSha256({
    terminalRecordRef: parsed.data.terminalRecordRef,
    terminalRecordChecksum: parsed.data.terminalRecordChecksum,
  });
  const receiptSource = recoveredReceiptSource(event.type);
  if (!receiptSource) return null;
  const receipt = await tx.inboundEventReceipt.findUnique({
    where: {
      sourceService_sourceEventId: {
        sourceService: receiptSource,
        sourceEventId: attemptId,
      },
    },
  });
  if (
    receipt?.processingState !== "processed" ||
    !recoveredReceiptHashMatches(
      receiptSource,
      receipt.payloadHash,
      expectedHash,
      parsed.data.terminalRecordChecksum,
    ) ||
    (receiptSource === "gen_resolution" &&
      (metadata.resolutionReceiptId !== receipt.id ||
        metadata.resolutionPayloadHash !== expectedHash))
  ) return null;
  return { payload: parsed.data, receiptId: receipt.id, eventId: event.id };
}

async function prepareRecoveredSuccessAdoption(
  requestId: string,
): Promise<PreparedRecoveredSuccess> {
  const latestAttempt = await prisma.generationAttempt.findFirst({
    where: { requestId },
    orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (!latestAttempt) {
    throw Errors.conflict(
      "adopt_succeeded requires a Generation Attempt",
    );
  }
  const event = await prisma.generationJobEvent.findFirst({
    where: {
      jobId: requestId,
      type: { in: [...RECOVERED_SUCCESS_EVENT_TYPES] },
      metadata: { path: ["attemptId"], equals: latestAttempt.id },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!event) {
    throw Errors.conflict(
      "adopt_succeeded requires a validated recovered terminal record",
    );
  }
  const receiptSource = recoveredReceiptSource(event.type);
  if (!receiptSource) {
    throw Errors.conflict("Recovered terminal evidence authority is unsupported");
  }
  const parsed = aiFinalizePayloadSchema.safeParse(
    jsonRecord(event.metadata).recoveredSuccess,
  );
  if (
    !parsed.success ||
    parsed.data.kind !== "generation.completed" ||
    parsed.data.generationJobId !== requestId ||
    parsed.data.assets.length === 0 ||
    typeof parsed.data.provider !== "string" ||
    parsed.data.assets.some((asset) => {
      const providerKey = jsonRecord(asset).providerKey;
      return providerKey !== null && typeof providerKey !== "string";
    })
  ) {
    throw Errors.conflict(
      "Recovered terminal evidence is not an adoptable provider success",
    );
  }
  const moderation = await providers.moderation.check({
    targetType: parsed.data.mode,
    content: parsed.data.assets.map((asset) => asset.key).join(" "),
  });
  if (!moderation.ok) {
    throw Errors.unavailable("Output moderation is unavailable for recovered success", {
      code: moderation.error.code,
    });
  }
  if (moderation.data.status === "blocked") {
    throw Errors.conflict("Recovered success did not pass output moderation", {
      policyCode: moderation.data.policyCode ?? null,
    });
  }
  return {
    eventId: event.id,
    eventType: event.type as PreparedRecoveredSuccess["eventType"],
    receiptSource,
    evidenceHash: canonicalSha256(parsed.data),
    payload: parsed.data,
    moderation: {
      status: moderation.data.status as "passed" | "flagged",
      policyCode: moderation.data.policyCode,
      confidence: moderation.data.confidence,
    },
  };
}

async function adoptRecoveredSuccess(
  tx: Prisma.TransactionClient,
  input: {
    readonly request: GenerationJob;
    readonly attempt: GenerationAttempt;
    readonly evidence: PreparedRecoveredSuccess;
    readonly now: Date;
  },
) {
  const event = await tx.generationJobEvent.findUnique({
    where: { id: input.evidence.eventId },
  });
  const recovered = aiFinalizePayloadSchema.safeParse(
    jsonRecord(event?.metadata).recoveredSuccess,
  );
  if (
    !event ||
    event.jobId !== input.request.id ||
    event.type !== input.evidence.eventType ||
    !recovered.success ||
    recovered.data.kind !== "generation.completed" ||
    canonicalSha256(recovered.data) !== input.evidence.evidenceHash
  ) {
    throw Errors.conflict("Recovered success evidence changed before adoption");
  }
  const payload = recovered.data;
  const originalTerminalRecordRef = input.evidence.receiptSource === "gen"
    ? payload.terminalRecordRef
    : jsonRecord(event.metadata).originalTerminalRecordRef ?? null;
  if (
    payload.generationJobId !== input.request.id ||
    payload.attemptId !== input.attempt.id ||
    payload.attemptNo !== input.attempt.attemptNo ||
    input.attempt.terminalRecordRef !== originalTerminalRecordRef ||
    payload.mode !== input.request.mode
  ) {
    throw Errors.conflict("Recovered success does not match the locked Attempt", {
      requestId: input.request.id,
      attemptId: input.attempt.id,
    });
  }
  const expectedReceiptHash = canonicalSha256({
    terminalRecordRef: payload.terminalRecordRef,
    terminalRecordChecksum: payload.terminalRecordChecksum,
  });
  const [resolutionReceipt, unknownTransport, artifacts, priorAssets, deliveredBefore] =
    await Promise.all([
      tx.inboundEventReceipt.findUnique({
        where: {
          sourceService_sourceEventId: {
            sourceService: input.evidence.receiptSource,
            sourceEventId: input.attempt.id,
          },
        },
      }),
      tx.generationTransportExecution.findFirst({
        where: {
          attemptId: input.attempt.id,
          status: "unknown",
        },
        orderBy: { transportAttemptNo: "desc" },
      }),
      tx.generationArtifact.findMany({
        where: { attemptId: input.attempt.id },
        orderBy: { ordinal: "asc" },
      }),
      tx.mediaAsset.count({ where: { sourceJobId: input.request.id } }),
      tx.generationDelivery.count({
        where: { requestId: input.request.id, status: "delivered" },
      }),
    ]);
  if (
    resolutionReceipt?.processingState !== "processed" ||
    !recoveredReceiptHashMatches(
      input.evidence.receiptSource,
      resolutionReceipt.payloadHash,
      expectedReceiptHash,
      payload.terminalRecordChecksum,
    ) ||
    (input.evidence.receiptSource === "gen_resolution" &&
      (jsonRecord(event.metadata).resolutionReceiptId !== resolutionReceipt.id ||
        jsonRecord(event.metadata).resolutionPayloadHash !== expectedReceiptHash)) ||
    !unknownTransport ||
    unknownTransport.terminalRecordRef !== originalTerminalRecordRef
  ) {
    throw Errors.conflict(
      "Recovered success lacks its immutable resolution Receipt and unknown Transport evidence",
      { attemptId: input.attempt.id },
    );
  }
  if (
    priorAssets !== 0 ||
    deliveredBefore !== 0 ||
    input.request.deliveredOutputCount !== 0 ||
    artifacts.length !== payload.assets.length ||
    artifacts.some((artifact, ordinal) => {
      const asset = payload.assets[ordinal];
      return !asset ||
        artifact.ordinal !== ordinal ||
        artifact.providerRef !== recoveredProviderRef(asset) ||
        artifact.terminalRecordChecksum !== payload.terminalRecordChecksum ||
        artifact.validationState !== "late_after_unknown" ||
        artifact.archiveState !== "archived" ||
        artifact.assetId !== null;
    })
  ) {
    throw Errors.conflict("Recovered success projection is not in its adoptable state", {
      attemptId: input.attempt.id,
    });
  }

  let refundAmount = 0;
  if (input.request.sourceType !== "content_production_item") {
    const settlement = await ensureGenerationSettlementLinks(tx, input.request.id);
    if (settlement.refunded > 0) {
      throw Errors.conflict("A refunded unknown Request cannot adopt late success", {
        refunded: settlement.refunded,
      });
    }
    const missingOutputs = Math.max(
      0,
      input.request.outputCount - payload.assets.length,
    );
    const requestedRefund = missingOutputs > 0 && input.request.outputCount > 0
      ? Math.ceil(
          (input.request.costDreamcoins * missingOutputs) /
            input.request.outputCount,
        )
      : 0;
    const refundedAmount = await refundGenerationRequest(tx, {
      requestId: input.request.id,
      userId: input.request.userId,
      cause: { kind: "partial" },
      requested: requestedRefund,
    });
    refundAmount = refundedAmount;
  }

  const persistedAssets = [] as Array<{ id: string }>;
  for (const [ordinal, asset] of payload.assets.entries()) {
    const providerRef = recoveredProviderRef(asset);
    const mediaProviderRef = providerRef ?? asset.key;
    const mediaId = `media_unknown_${canonicalSha256({
      attemptId: input.attempt.id,
      ordinal,
    }).slice(0, 32)}`;
    const displayUrl = `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content${mediaFileExtension(asset.contentType)}`;
    const created = await tx.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: input.request.userId,
        sourceJobId: input.request.id,
        characterId: input.request.characterId,
        type: payload.mode,
        url: displayUrl,
        thumbnailUrl: payload.mode === "image" ? displayUrl : null,
        storageKey: asset.key,
        contentType: asset.contentType,
        width: asset.width,
        height: asset.height,
        providerAssetId: mediaProviderRef,
        sourcePromptHash: input.request.prompt
          ? generationPromptHash(input.request.prompt)
          : null,
        prompt: input.request.prompt,
        visibility: "private",
        safetyStatus: input.evidence.moderation.status,
        metadata: toInputJson({
          index: ordinal,
          provider: payload.provider,
          providerKey: mediaProviderRef,
          recoveredUnknown: true,
          terminalRecordRef: payload.terminalRecordRef,
          terminalRecordChecksum: payload.terminalRecordChecksum,
          contentType: asset.contentType,
          width: asset.width,
          height: asset.height,
          seconds: asset.seconds,
          usage: payload.usage,
          storageKey: asset.key,
          visualProfileId: input.request.visualProfileId,
          visualProfileVersion: input.request.visualProfileVersion,
          consistencyMode: input.request.consistencyMode,
          seed: input.request.seed,
          referenceAssetIds: input.request.referenceAssetIds,
        }),
      },
      select: { id: true },
    });
    persistedAssets.push(created);
  }
  await tx.moderationEvent.create({
    data: {
      targetType: "generation_job",
      targetId: input.request.id,
      layer: "output",
      status: input.evidence.moderation.status,
      policyCode: input.evidence.moderation.policyCode,
      confidence: input.evidence.moderation.confidence,
      details: toInputJson({ recoveredUnknown: true }),
    },
  });
  const deliveredCount = await adoptRecoveredUnknownArtifacts(tx, {
    requestId: input.request.id,
    attemptId: input.attempt.id,
    targetId: input.request.userId,
    assets: persistedAssets.map((asset, ordinal) => ({
      ordinal,
      assetId: asset.id,
      providerRef: recoveredProviderRef(payload.assets[ordinal]!),
      terminalRecordChecksum: payload.terminalRecordChecksum,
    })),
    occurredAt: input.now,
  });
  const firstAsset = persistedAssets[0];
  if (firstAsset) {
    await markProductionItemGenerated(tx, {
      jobId: input.request.id,
      mediaAssetId: firstAsset.id,
    });
  }
  const reopened = input.request.status === "failed"
    ? await transitionGenerationRequest(tx, {
        requestId: input.request.id,
        to: "queued",
        expected: { from: "failed", version: input.request.version },
        data: { errorCode: null, finishedAt: null },
      })
    : input.request;
  const moderating = reopened.status === "moderating_output"
    ? reopened
    : await transitionGenerationRequest(tx, {
        requestId: input.request.id,
        to: "moderating_output",
        expected: {
          from: reopened.status as (typeof ACTIVE_REQUEST_STATUSES)[number],
          version: reopened.version,
        },
      });
  const completed = await transitionGenerationRequest(tx, {
    requestId: input.request.id,
    to: "completed",
    expected: { from: "moderating_output", version: moderating.version },
    data: {
      completedAt: input.now,
      finishedAt: input.now,
      deliveredOutputCount: Math.min(input.request.outputCount, deliveredCount),
      errorCode: null,
    },
  });
  if (firstAsset) {
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `generation-delivery:${input.request.id}:v2`,
      eventType: "generation.delivery.completed.v2",
      occurredAt: input.now,
      userId: input.request.userId,
      context: {
        characterId: input.request.characterId,
        characterReleaseId: null,
      },
      payload: {
        requestId: input.request.id,
        artifactId: firstAsset.id,
        userId: input.request.userId,
        expectedOutputCount: input.request.outputCount,
        deliveredOutputCount: deliveredCount,
        valid: true,
        displayable: true,
        recoveredUnknown: true,
      },
    });
  }
  if (
    firstAsset &&
    input.request.sourceType === "chat_image" &&
    input.request.sourceId
  ) {
    await recordMainToChatEvent({
      eventId: `chat_image_completed_${input.request.sourceId}_${input.request.id}_${firstAsset.id}`,
      eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
      aggregateType: "chat_attachment",
      aggregateId: input.request.sourceId,
      payload: {
        version: 1,
        kind: "chat.image.completed",
        attachmentId: input.request.sourceId,
        generationJobId: input.request.id,
        mediaAssetId: firstAsset.id,
        width: payload.assets[0]?.width ?? null,
        height: payload.assets[0]?.height ?? null,
      },
    }, tx);
  }
  await tx.generationJobEvent.create({
    data: {
      jobId: input.request.id,
      type: "unknown_success_adopted",
      message: "Validated recovered provider success was adopted and delivered",
      metadata: toInputJson({
        attemptId: input.attempt.id,
        terminalRecordRef: payload.terminalRecordRef,
        terminalRecordChecksum: payload.terminalRecordChecksum,
        deliveredCount,
        refundAmount,
      }),
    },
  });
  return {
    requestStatus: completed.status,
    requestVersion: completed.version,
    deliveredCount,
    refundAmount,
  };
}

function recoveredProviderRef(
  asset: RecoveredSuccessPayload["assets"][number],
) {
  const providerKey = jsonRecord(asset).providerKey;
  if (providerKey === null) return null;
  if (typeof providerKey === "string") return providerKey;
  throw Errors.conflict("Recovered success asset lacks provider identity");
}

function mediaFileExtension(contentType: string) {
  const extensions: Readonly<Record<string, string>> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return extensions[contentType] ?? "";
}

// INVARIANT: MediaAsset.sourcePromptHash keeps the established generation
// projection format so adopted and normal outputs remain query-compatible.
function generationPromptHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = (hash * 33) ^ char.charCodeAt(0);
  return `prompt_${Math.abs(hash)}`;
}

function recoveredReceiptSource(eventType: string) {
  if (eventType === "unknown_terminal_evidence_recovered") return "gen" as const;
  if (eventType === "unknown_terminal_resolution_evidence_recovered") {
    return "gen_resolution" as const;
  }
  return null;
}

function recoveredReceiptHashMatches(
  source: "gen" | "gen_resolution",
  actual: string,
  envelopeHash: string,
  terminalRecordChecksum: string,
) {
  return actual === envelopeHash ||
    (source === "gen" && actual === terminalRecordChecksum);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
