import {
  characterMediaOperationsProjectionSchema,
  type CharacterMediaOperationsProjection,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import {
  pinnedVoiceProviderPayloadSchema,
  voiceClipSynthesisPayloadSchema,
} from "@/server/modules/ourdream/voice-clip";
import { VOICE_PROVIDER_REPLAY } from "@/server/providers/types";
import {
  OPERATIONAL_USER_DATA_CLASSES,
  operationalGenerationJobWhere,
} from "@/server/modules/admin/shared/metric-data-scope";
import { resolveGenerationAttemptRetryAuthority } from "@/server/modules/generation/generation-attempt-authority";

// SPEC: This projector only reads evidence owned by Generation and Voice authorities.
// INTENT: CharacterWorkspace consumes one stable operations view without learning how
// transport attempts, billing ledger entries, or durable voice usage are stored.
export async function loadCharacterMediaOperationsProjection(
  characterId: string,
): Promise<CharacterMediaOperationsProjection> {
  const projectionAsOf = new Date();
  const characterHref = `/admin/characters/${encodeURIComponent(characterId)}`;
  const unavailable = (
    modality: "image" | "video" | "voice",
    tab: "assets" | "video" | "voice",
  ) => ({
    modality,
    requestId: null,
    status: null,
    attempt: null,
    provider: null,
    timing: null,
    costDreamcoins: null,
    output: null,
    recoverability: {
      state: "unavailable" as const,
      reason: "No operation evidence exists for this Character.",
    },
    studioHref: `${characterHref}?tab=${tab}`,
    operationsHref: null,
  });
  const latestGenerationJob = (mode: "image" | "video") =>
    prisma.generationJob.findFirst({
      where: operationalGenerationJobWhere({ characterId, mode }),
      include: {
        assets: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  const voiceRequestWhere = {
    characterId,
    user: {
      is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
    },
  } satisfies Prisma.VoiceClipRequestWhereInput;
  const voiceRequestSelect = {
    id: true,
    status: true,
    attemptNo: true,
    provider: true,
    providerRequestId: true,
    errorCode: true,
    synthesisPayload: true,
    providerPayload: true,
    leaseExpiresAt: true,
    startedAt: true,
    completedAt: true,
    createdAt: true,
    mediaAsset: true,
    usageFacts: {
      include: { mediaAsset: true },
      orderBy: [
        { attemptNo: "desc" as const },
        { occurredAt: "desc" as const },
        { id: "desc" as const },
      ],
      take: 1,
    },
  } satisfies Prisma.VoiceClipRequestSelect;
  const [imageJob, videoJob, expiredVoiceRequests, latestVoiceRequest] =
    await Promise.all([
    latestGenerationJob("image"),
    latestGenerationJob("video"),
    prisma.voiceClipRequest.findMany({
      where: {
        ...voiceRequestWhere,
        status: "running",
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: projectionAsOf } },
        ],
      },
      select: voiceRequestSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.voiceClipRequest.findFirst({
      where: voiceRequestWhere,
      select: voiceRequestSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  const voiceRequest = expiredVoiceRequests.find((request) => {
    const provider = pinnedVoiceProviderPayloadSchema.safeParse(
      request.providerPayload,
    );
    return (
      voiceClipSynthesisPayloadSchema.safeParse(request.synthesisPayload)
        .success &&
      provider.success &&
      VOICE_PROVIDER_REPLAY[provider.data.providerKey] === "durable_same_key"
    );
  }) ?? latestVoiceRequest;
  const requestIds = [imageJob?.id, videoJob?.id].filter(
    (id): id is string => Boolean(id),
  );
  const attempts = requestIds.length === 0
    ? []
    : await prisma.generationAttempt.findMany({
        where: { requestId: { in: requestIds } },
        orderBy: [
          { requestId: "asc" },
          { attemptNo: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
      });
  const latestAttemptByRequestId = new Map<
    string,
    (typeof attempts)[number]
  >();
  for (const attempt of attempts) {
    if (!latestAttemptByRequestId.has(attempt.requestId)) {
      latestAttemptByRequestId.set(attempt.requestId, attempt);
    }
  }
  const attemptIds = [...latestAttemptByRequestId.values()].map(
    (attempt) => attempt.id,
  );
  const [transportExecutions, ledgerEntries] = await Promise.all([
    attemptIds.length === 0
      ? Promise.resolve([])
      : prisma.generationTransportExecution.findMany({
          where: { attemptId: { in: attemptIds } },
          orderBy: [
            { attemptId: "asc" },
            { transportAttemptNo: "desc" },
            { finishedAt: "desc" },
            { id: "desc" },
          ],
        }),
    requestIds.length === 0
      ? Promise.resolve([])
      : prisma.dreamcoinLedger.findMany({
          where: {
            sourceId: { in: requestIds },
            reason: { in: ["generation_spend", "refund"] },
          },
          select: { sourceId: true, delta: true },
        }),
  ]);
  const retryAuthorities = await Promise.all(
    [imageJob, videoJob].map(async (job) => {
      if (!job) return null;
      const latestAttempt = latestAttemptByRequestId.get(job.id) ?? null;
      return [
        job.id,
        await resolveGenerationAttemptRetryAuthority(prisma, {
          request: job,
          latestAttempt,
        }),
      ] as const;
    }),
  );
  const retryAuthorityByRequestId = new Map(
    retryAuthorities.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    ),
  );
  const latestTransportByAttemptId = new Map<
    string,
    (typeof transportExecutions)[number]
  >();
  for (const execution of transportExecutions) {
    if (!latestTransportByAttemptId.has(execution.attemptId)) {
      latestTransportByAttemptId.set(execution.attemptId, execution);
    }
  }
  const ledgerDeltaByRequestId = new Map<string, number>();
  for (const entry of ledgerEntries) {
    if (!entry.sourceId) continue;
    ledgerDeltaByRequestId.set(
      entry.sourceId,
      (ledgerDeltaByRequestId.get(entry.sourceId) ?? 0) + entry.delta,
    );
  }

  const generationOperation = (
    modality: "image" | "video",
    tab: "assets" | "video",
    job: typeof imageJob,
  ) => {
    if (!job) return unavailable(modality, tab);
    const attempt = latestAttemptByRequestId.get(job.id) ?? null;
    const transport = attempt
      ? latestTransportByAttemptId.get(attempt.id) ?? null
      : null;
    const asset = job.assets[0] ?? null;
    const finishedAt = attempt?.finishedAt ?? job.finishedAt ?? job.completedAt;
    const latencyMs = attempt?.startedAt && finishedAt
      ? Math.max(0, finishedAt.getTime() - attempt.startedAt.getTime())
      : null;
    const providerKey = attempt?.provider ?? job.provider;
    const outputMetadata = asset ? metadataRecord(asset.metadata) : {};
    const outputDuration = outputMetadata.durationMs;
    const attemptRetryability =
      attempt?.retryability === "retryable" ||
        attempt?.retryability === "not_retryable" ||
        attempt?.retryability === "operator_retry"
        ? attempt.retryability
        : null;
    const retryAuthority = retryAuthorityByRequestId.get(job.id) ?? null;
    const recovery = (() => {
      if (attempt?.status === "unknown") {
        if (
          retryAuthority?.allowed &&
          retryAuthority.basis === "operator_confirmed_unknown_failure"
        ) {
          return {
            state: "retryable" as const,
            reason:
              "The provider failure was confirmed by an operator; create a new pinned Attempt.",
          };
        }
        return {
          state: "operator_action" as const,
          reason:
            attempt.operatorGuidance ??
            "The latest Attempt outcome is unknown; reconcile provider and terminal evidence before retrying.",
        };
      }
      if (!["failed", "blocked"].includes(job.status)) {
        return { state: "not_needed" as const, reason: null };
      }
      if (!attemptRetryability) {
        return {
          state: "unavailable" as const,
          reason: "No retryability evidence is recorded for the latest Attempt.",
        };
      }
      const reason = attempt?.operatorGuidance ?? {
        retryable: "The latest Attempt is marked retryable.",
        operator_retry: "The latest Attempt requires an operator retry.",
        not_retryable: "The latest Attempt is marked not retryable.",
      }[attemptRetryability];
      return attemptRetryability === "retryable"
        ? { state: "retryable" as const, reason }
        : attemptRetryability === "operator_retry"
          ? { state: "operator_action" as const, reason }
          : { state: "not_recoverable" as const, reason };
    })();
    return {
      modality,
      requestId: job.id,
      status: job.status,
      attempt: attempt ? {
        id: attempt.id,
        number: attempt.attemptNo,
        status: attempt.status,
        errorCode: attempt.errorCode,
        retryability: attemptRetryability,
        operatorGuidance: attempt.operatorGuidance,
      } : null,
      provider: providerKey || transport?.providerRequestId
        ? {
            key: providerKey,
            requestId: transport?.providerRequestId ?? null,
          }
        : null,
      timing: {
        requestedAt: job.createdAt.toISOString(),
        startedAt: attempt?.startedAt?.toISOString() ?? null,
        finishedAt: finishedAt?.toISOString() ?? null,
        latencyMs,
      },
      // The request price is an estimate. Only captured spend minus refunds is cost.
      costDreamcoins: Math.max(0, -(ledgerDeltaByRequestId.get(job.id) ?? 0)),
      output: asset ? {
        mediaAssetId: asset.id,
        availability: asset.deletedAt ? "deleted" as const : "available" as const,
        url: asset.deletedAt ? null : asset.url,
        createdAt: asset.createdAt.toISOString(),
        durationMs:
          typeof outputDuration === "number" &&
          Number.isInteger(outputDuration) &&
          outputDuration >= 0
            ? outputDuration
            : null,
      } : null,
      recoverability: recovery,
      studioHref: `${characterHref}?tab=${tab}`,
      operationsHref: ["failed", "blocked"].includes(job.status)
        ? `/admin/ops/jobs?view=dead-letter&search=${encodeURIComponent(job.id)}`
        : `/admin/ops/jobs?job=${encodeURIComponent(job.id)}`,
    };
  };
  const voiceOperation = (() => {
    if (!voiceRequest) return unavailable("voice", "voice");
    const usage = voiceRequest.usageFacts[0] ?? null;
    const asset = voiceRequest.mediaAsset ?? usage?.mediaAsset ?? null;
    const latencyMs = voiceRequest.startedAt && voiceRequest.completedAt
      ? Math.max(
          0,
          voiceRequest.completedAt.getTime() - voiceRequest.startedAt.getTime(),
        )
      : null;
    const terminalWithoutRecoveryEvidence = ["failed", "skipped"].includes(
      voiceRequest.status,
    );
    const runningLeaseExpired =
      voiceRequest.status === "running" &&
      (voiceRequest.leaseExpiresAt === null ||
        voiceRequest.leaseExpiresAt <= projectionAsOf);
    const projectedProviderPayload = pinnedVoiceProviderPayloadSchema.safeParse(
      voiceRequest.providerPayload,
    );
    const durableSynthesisPayload =
      voiceClipSynthesisPayloadSchema.safeParse(voiceRequest.synthesisPayload)
        .success &&
      projectedProviderPayload.success &&
      VOICE_PROVIDER_REPLAY[projectedProviderPayload.data.providerKey] ===
        "durable_same_key";
    const reclaimActionHref =
      `/api/v2/admin/characters/${encodeURIComponent(characterId)}` +
      `/voice-clips/${encodeURIComponent(voiceRequest.id)}/commands/reclaim`;
    return {
      modality: "voice" as const,
      requestId: voiceRequest.id,
      status: voiceRequest.status,
      attempt: {
        id: null,
        number: voiceRequest.attemptNo,
        status: voiceRequest.status,
        errorCode: voiceRequest.errorCode,
        retryability: null,
        operatorGuidance: null,
      },
      provider: voiceRequest.provider || voiceRequest.providerRequestId
        ? {
            key: voiceRequest.provider,
            requestId: voiceRequest.providerRequestId,
          }
        : null,
      timing: {
        requestedAt: voiceRequest.createdAt.toISOString(),
        startedAt: voiceRequest.startedAt?.toISOString() ?? null,
        finishedAt: voiceRequest.completedAt?.toISOString() ?? null,
        latencyMs,
      },
      costDreamcoins: usage?.costDreamcoins ?? null,
      output: asset || usage ? {
        mediaAssetId: asset?.id ?? usage?.mediaAssetId ?? null,
        availability: asset
          ? asset.deletedAt ? "deleted" as const : "available" as const
          : "unavailable" as const,
        url: asset && !asset.deletedAt ? asset.url : null,
        createdAt: asset?.createdAt.toISOString() ?? null,
        durationMs: usage?.durationMs ?? null,
      } : null,
      recoverability: runningLeaseExpired && durableSynthesisPayload
        ? {
            state: "operator_action" as const,
            reason:
              "The Voice synthesis lease expired; reclaim the durable request before retrying provider execution.",
            actionHref: reclaimActionHref,
            actionConfirmation: `RECLAIM VOICE ${voiceRequest.id}`,
          }
        : runningLeaseExpired
          ? {
              state: "unavailable" as const,
              reason:
                "This Voice request lacks replay-safe durable provider authority and cannot be reclaimed.",
            }
        : terminalWithoutRecoveryEvidence
          ? {
            state: "unavailable" as const,
            reason: voiceRequest.errorCode
              ? `Voice request ended with ${voiceRequest.errorCode}; no retryability evidence is recorded.`
              : "No retryability evidence is recorded for this Voice request.",
            }
          : { state: "not_needed" as const, reason: null },
      studioHref: `${characterHref}?tab=voice`,
      operationsHref: null,
    };
  })();
  return characterMediaOperationsProjectionSchema.parse({
    projectionVersion: 1,
    asOf: projectionAsOf.toISOString(),
    operations: [
      generationOperation("image", "assets", imageJob),
      generationOperation("video", "video", videoJob),
      voiceOperation,
    ],
  });
}

function metadataRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
