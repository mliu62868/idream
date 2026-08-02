import { Prisma } from "@prisma/client";
import {
  aiFinalizePayloadSchema,
  generationTerminalFinalizeDedupeKey,
  generationTerminalRecordChecksum,
  generationTerminalRecordIngestSchema,
  type GenerationTerminalRecordIngest,
} from "@idream/shared/contracts";
import { incrementCounter, setGauge } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { jobQueue, type EnqueueJobInput } from "@/server/jobs/queue";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import {
  ensureProducedGenerationArtifact,
  isGenerationTransportExecutionTransitionAllowed,
  lateArtifactDisposition,
  projectAttemptArtifactDisposition,
} from "./generation-evidence-transition-authority";
import { isGenerationAttemptTransitionAllowed } from "@/server/modules/admin-v2/shared/state-transition-authority";
import {
  generationInvocationUsageFactConflicts,
  recordGenerationInvocationUsageFact,
} from "./generation-invocation-usage";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { resolveExactGenerationDispatchAuthority } from "./generation-dispatch-evidence-authority";
import { generationAttemptOutputPrefix } from "@/server/modules/generation/attempt-dispatch";

export async function ingestGenerationTerminalRecord(
  rawInput: unknown,
): Promise<{ acknowledged: boolean; status: "persisted" | "duplicate" | "quarantined"; receiptId: string | null }> {
  const input = generationTerminalRecordIngestSchema.parse(rawInput);
  if (generationTerminalRecordChecksum(input.terminalRecord) !== input.terminalRecordChecksum) {
    return { acknowledged: false, status: "quarantined", receiptId: null };
  }
  const receiptPayloadHash = canonicalSha256({
    terminalRecordRef: input.terminalRecordRef,
    terminalRecordChecksum: input.terminalRecordChecksum,
  });
  const result = await prisma.$transaction(async (tx) => {
    // INVARIANT: this lock exists even before an Attempt is reserved, so two
    // identical deliveries cannot both observe an absent Receipt and race its
    // unique key. Transport and terminal ingest remain independently durable.
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`generation_terminal_record:${input.terminalRecord.attemptId}`}, 0)
      )::text AS "lock"
    `);
    const receiptWhere = {
      sourceService_sourceEventId: { sourceService: "gen", sourceEventId: input.terminalRecord.attemptId },
    } as const;
    const receipt = await tx.inboundEventReceipt.findUnique({ where: receiptWhere });
    if (receipt && receipt.payloadHash !== receiptPayloadHash) {
      const resolution = await ingestUnknownTerminalResolution(
        tx,
        input,
        receiptPayloadHash,
        receipt,
      );
      if (resolution) return resolution;
      const quarantined = await quarantineTerminalRecordEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        "terminal_record_envelope_conflict",
      );
      return { acknowledged: false, status: "quarantined" as const, receiptId: quarantined.id };
    }
    if (receipt?.processingState === "processed") {
      return { acknowledged: true, status: "duplicate" as const, receiptId: receipt.id };
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT id
      FROM generation_attempts
      WHERE id = ${input.terminalRecord.attemptId}
      FOR UPDATE
    `);
    const existingAttempt = await tx.generationAttempt.findUnique({
      where: { id: input.terminalRecord.attemptId },
    });
    if (!existingAttempt) {
      const quarantined = await quarantineTerminalRecordEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        "generation_attempt_not_reserved",
      );
      return {
        acknowledged: false,
        status: "quarantined" as const,
        receiptId: quarantined.id,
      };
    }
    if (
      (existingAttempt.requestId !== input.terminalRecord.generationJobId ||
        existingAttempt.attemptNo !== input.terminalRecord.attemptNo)
    ) {
      const quarantined = await quarantineTerminalRecordEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        "generation_attempt_identity_mismatch",
      );
      return { acknowledged: false, status: "quarantined" as const, receiptId: quarantined.id };
    }
    if (
      existingAttempt.provider !== null &&
      existingAttempt.provider !== input.terminalRecord.provider
    ) {
      const quarantined = await quarantineTerminalRecordEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        "generation_attempt_authority_mismatch",
      );
      return { acknowledged: false, status: "quarantined" as const, receiptId: quarantined.id };
    }
    if (
      existingAttempt.status === "unknown" &&
      input.terminalRecord.outcome !== "unknown"
    ) {
      const resolution = await ingestUnknownTerminalResolution(
        tx,
        input,
        receiptPayloadHash,
        receipt,
      );
      if (resolution) return resolution;
      const quarantined = await quarantineUnknownResolutionEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        "generation_unknown_resolution_unavailable",
      );
      return {
        acknowledged: false,
        status: "quarantined" as const,
        receiptId: quarantined.id,
      };
    }
    if (
      existingAttempt.terminalRecordRef !== null &&
      existingAttempt.terminalRecordRef !== input.terminalRecordRef
    ) {
      const quarantined = await quarantineTerminalRecordEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        "generation_attempt_authority_mismatch",
      );
      return { acknowledged: false, status: "quarantined" as const, receiptId: quarantined.id };
    }
    const authorityMismatch = await terminalRecordAuthorityMismatch(
      tx,
      input,
      existingAttempt,
    );
    if (authorityMismatch) {
      const quarantined = await quarantineTerminalRecordEnvelope(
        tx,
        input.terminalRecord.attemptId,
        receiptPayloadHash,
        authorityMismatch,
      );
      return {
        acknowledged: false,
        status: "quarantined" as const,
        receiptId: quarantined.id,
      };
    }
    if (receipt) {
      await tx.inboundEventReceipt.delete({ where: receiptWhere });
    }
    const lateValidationState = lateArtifactDisposition({
      attemptStatus: existingAttempt.status,
    });
    const assets = terminalAssets(input);
    if (lateValidationState) {
      const request = await tx.generationJob.findUniqueOrThrow({
        where: { id: existingAttempt.requestId },
        select: { userId: true },
      });
      const createdReceipt = await tx.inboundEventReceipt.create({ data: {
        sourceService: "gen",
        sourceEventId: input.terminalRecord.attemptId,
        payloadHash: receiptPayloadHash,
        processingState: "processed",
        processedAt: new Date(),
      } });
      if (existingAttempt.status === "unknown") {
        const linked = await tx.generationAttempt.updateMany({
          where: {
            id: existingAttempt.id,
            status: "unknown",
            terminalRecordRef: existingAttempt.terminalRecordRef,
          },
          data: { terminalRecordRef: input.terminalRecordRef },
        });
        if (linked.count !== 1) {
          throw Errors.conflict("Unknown Attempt changed during evidence recovery", {
            attemptId: existingAttempt.id,
          });
        }
        await recordRecoveredUnknownTransportEvidence(
          tx,
          input,
          existingAttempt.id,
        );
      } else {
        await recordTerminalTransportEvidence(tx, input, existingAttempt.id);
      }
      for (const asset of assets) {
        await ensureProducedGenerationArtifact(tx, {
          attemptId: existingAttempt.id,
          ordinal: asset.ordinal,
          providerRef: asset.providerKey,
          terminalRecordChecksum: input.terminalRecordChecksum,
        });
      }
      await projectAttemptArtifactDisposition(tx, {
        requestId: existingAttempt.requestId,
        attemptId: existingAttempt.id,
        targetId: request.userId,
        validationState: lateValidationState,
        deliveryStatus: "suppressed",
        occurredAt: new Date(input.terminalRecord.completedAt),
      });
      await tx.generationJobEvent.create({ data: {
        jobId: input.terminalRecord.generationJobId,
        type: existingAttempt.status === "unknown"
          ? "unknown_terminal_evidence_recovered"
          : assets.length > 0
            ? "late_artifact_archived"
            : "late_terminal_record_observed",
        message: existingAttempt.status === "unknown"
          ? "Durable terminal evidence was recovered for operator reconciliation without changing the unknown business outcome"
          : assets.length > 0
            ? "Provider artifacts arrived after a terminal outcome and were archived without delivery"
            : "Provider terminal evidence arrived after the business Attempt was already terminal",
        metadata: toInputJson({
          attemptId: existingAttempt.id,
          terminalStatus: existingAttempt.status,
          terminalRecordOutcome: input.terminalRecord.outcome,
          terminalRecordRef: input.terminalRecordRef,
          terminalRecordChecksum: input.terminalRecordChecksum,
          assetCount: assets.length,
          recoveredSuccess:
            input.terminalRecord.outcome === "succeeded"
              ? finalizePayload(input)
              : null,
        }),
      } });
      return { acknowledged: true, status: "persisted" as const, receiptId: createdReceipt.id };
    }
    if (!isGenerationAttemptTransitionAllowed(existingAttempt.status, "running")) {
      throw Errors.conflict("Terminal record cannot reopen a terminal Generation Attempt", {
        status: existingAttempt.status,
      });
    }
    const boundAttempt = await tx.generationAttempt.updateMany({
      where: {
        id: existingAttempt.id,
        provider: existingAttempt.provider,
        terminalRecordRef: existingAttempt.terminalRecordRef,
        status: existingAttempt.status,
      },
      data: {
        provider: existingAttempt.provider ?? input.terminalRecord.provider,
        terminalRecordRef: input.terminalRecordRef,
      },
    });
    if (boundAttempt.count !== 1) {
      throw Errors.conflict("Generation Attempt changed during terminal ingest", {
        attemptId: existingAttempt.id,
      });
    }
    const attempt = await tx.generationAttempt.findUniqueOrThrow({
      where: { id: existingAttempt.id },
    });
    await recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:terminal-record-ingested`,
      attemptId: attempt.id,
      eventType: "generation.attempt.terminal_record_ingested.v1",
      occurredAt: new Date(input.terminalRecord.completedAt),
      payload: {
        requestId: input.terminalRecord.generationJobId,
        terminalRecordRef: input.terminalRecordRef,
        terminalRecordChecksum: input.terminalRecordChecksum,
        provider: input.terminalRecord.provider,
        providerRequestId: input.terminalRecord.providerRequestId,
        transportAttemptNo: input.terminalRecord.transportAttemptNo,
        providerIdempotencyKey: input.terminalRecord.providerIdempotencyKey ?? input.terminalRecord.attemptId,
        terminalRecordOutcome: input.terminalRecord.outcome,
        providerInvoked: terminalRecordProviderInvoked(input),
        assetCount: assets.length,
      },
      status: "running",
      terminalRecordRef: input.terminalRecordRef,
    });
    const createdReceipt = await tx.inboundEventReceipt.create({
      data: {
        sourceService: "gen",
        sourceEventId: input.terminalRecord.attemptId,
        payloadHash: receiptPayloadHash,
        processingState: "processed",
        processedAt: new Date(),
      },
    });
    await recordTerminalTransportEvidence(tx, input, attempt.id);
    for (const asset of assets) {
      await ensureProducedGenerationArtifact(tx, {
        attemptId: attempt.id,
        ordinal: asset.ordinal,
        providerRef: asset.providerKey,
        terminalRecordChecksum: input.terminalRecordChecksum,
      });
    }
    const outboxId = `generation_terminal_record_${attempt.id}`;
    await tx.mainOutboxEvent.upsert({
      where: { id: outboxId },
      create: {
        id: outboxId,
        eventType: "generation.terminal_record.accepted.v1",
        aggregateType: "generation_attempt",
        aggregateId: attempt.id,
        payload: toInputJson(finalizePayload(input)),
      },
      update: {},
    });
    return { acknowledged: true, status: "persisted" as const, receiptId: createdReceipt.id };
  });
  if (result.status === "duplicate") {
    incrementCounter(
      "generation_terminal_record_replay_total",
      "Persisted generation terminal records replayed after durable ingest interruption",
      { outcome: "durable_duplicate" },
    );
  }
  return result;
}

function terminalTransportStatus(
  outcome: GenerationTerminalRecordIngest["terminalRecord"]["outcome"],
) {
  if (outcome === "failed") return "failed" as const;
  if (outcome === "unknown") return "unknown" as const;
  return "succeeded" as const;
}

type TerminalIngestResult = {
  acknowledged: boolean;
  status: "persisted" | "duplicate" | "quarantined";
  receiptId: string | null;
};

// SPEC: a provider may resolve an already-unknown Attempt with a later success,
// but that resolution is a second immutable evidence envelope. It never
// rewrites the original terminal Receipt, Attempt terminal fact, or unknown
// TransportExecution.
async function ingestUnknownTerminalResolution(
  tx: Prisma.TransactionClient,
  input: GenerationTerminalRecordIngest,
  payloadHash: string,
  canonicalReceipt: {
    readonly id: string;
    readonly payloadHash: string;
    readonly processingState: string;
  } | null,
): Promise<TerminalIngestResult | null> {
  if (input.terminalRecord.outcome !== "succeeded") return null;
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM generation_attempts
    WHERE id = ${input.terminalRecord.attemptId}
    FOR UPDATE
  `);
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: input.terminalRecord.attemptId },
  });
  if (!attempt || attempt.status !== "unknown") return null;
  const quarantine = async (code: string) => {
    const receipt = await quarantineUnknownResolutionEnvelope(
      tx,
      attempt.id,
      payloadHash,
      code,
    );
    return {
      acknowledged: false,
      status: "quarantined" as const,
      receiptId: receipt.id,
    };
  };
  if (
    attempt.requestId !== input.terminalRecord.generationJobId ||
    attempt.attemptNo !== input.terminalRecord.attemptNo ||
    (attempt.provider !== null && attempt.provider !== input.terminalRecord.provider)
  ) {
    return quarantine("generation_unknown_resolution_attempt_mismatch");
  }
  const authorityMismatch = await terminalRecordAuthorityMismatch(tx, input, attempt);
  if (authorityMismatch) {
    return quarantine(authorityMismatch);
  }

  let originalTerminalRecordRef: string | null = null;
  if (canonicalReceipt) {
    const originalOutbox = await tx.mainOutboxEvent.findUnique({
      where: { id: `generation_terminal_record_${attempt.id}` },
    });
    const originalPayload = aiFinalizePayloadSchema.safeParse(originalOutbox?.payload);
    if (
      canonicalReceipt.processingState !== "processed" ||
      !originalOutbox ||
      originalOutbox.eventType !== "generation.terminal_record.accepted.v1" ||
      originalOutbox.aggregateType !== "generation_attempt" ||
      originalOutbox.aggregateId !== attempt.id ||
      !originalPayload.success ||
      originalPayload.data.kind !== "generation.unknown" ||
      originalPayload.data.generationJobId !== attempt.requestId ||
      originalPayload.data.attemptId !== attempt.id ||
      originalPayload.data.attemptNo !== attempt.attemptNo ||
      canonicalReceipt.payloadHash !== canonicalSha256({
        terminalRecordRef: originalPayload.data.terminalRecordRef,
        terminalRecordChecksum: originalPayload.data.terminalRecordChecksum,
      }) ||
      attempt.terminalRecordRef !== originalPayload.data.terminalRecordRef
    ) {
      return quarantine("generation_unknown_resolution_original_evidence_mismatch");
    }
    originalTerminalRecordRef = originalPayload.data.terminalRecordRef;
  } else {
    const unknownEvent = await tx.generationAttemptEvent.findFirst({
      where: { attemptId: attempt.id, outcome: "unknown" },
      orderBy: [{ sequence: "desc" }, { occurredAt: "desc" }],
    });
    if (!unknownEvent || attempt.terminalRecordRef !== null) {
      return quarantine("generation_unknown_resolution_original_evidence_missing");
    }
  }

  const transport = await tx.generationTransportExecution.findUnique({
    where: {
      attemptId_transportAttemptNo: {
        attemptId: attempt.id,
        transportAttemptNo: input.terminalRecord.transportAttemptNo,
      },
    },
  });
  if (
    !transport ||
    transport.status !== "unknown" ||
    transport.idempotencyKey !== input.terminalRecord.providerIdempotencyKey ||
    transport.providerRequestId !== input.terminalRecord.providerRequestId ||
    transport.terminalRecordRef !== originalTerminalRecordRef
  ) {
    return quarantine("generation_unknown_resolution_transport_mismatch");
  }

  const resolutionWhere = {
    sourceService_sourceEventId: {
      sourceService: "gen_resolution",
      sourceEventId: attempt.id,
    },
  } as const;
  const resolutionReceipt = await tx.inboundEventReceipt.findUnique({
    where: resolutionWhere,
  });
  if (resolutionReceipt?.payloadHash === payloadHash) {
    return {
      acknowledged: true,
      status: "duplicate",
      receiptId: resolutionReceipt.id,
    };
  }
  if (resolutionReceipt) {
    return quarantine("generation_unknown_resolution_envelope_conflict");
  }

  const request = await tx.generationJob.findUniqueOrThrow({
    where: { id: attempt.requestId },
    select: { userId: true },
  });
  const assets = input.terminalRecord.assets;
  const createdReceipt = await tx.inboundEventReceipt.create({
    data: {
      sourceService: "gen_resolution",
      sourceEventId: attempt.id,
      payloadHash,
      processingState: "processed",
      processedAt: new Date(),
    },
  });
  for (const asset of assets) {
    await ensureProducedGenerationArtifact(tx, {
      attemptId: attempt.id,
      ordinal: asset.ordinal,
      providerRef: asset.providerKey,
      terminalRecordChecksum: input.terminalRecordChecksum,
    });
  }
  await projectAttemptArtifactDisposition(tx, {
    requestId: attempt.requestId,
    attemptId: attempt.id,
    targetId: request.userId,
    validationState: "late_after_unknown",
    deliveryStatus: "suppressed",
    occurredAt: new Date(input.terminalRecord.completedAt),
  });
  await tx.generationJobEvent.create({
    data: {
      id: `generation_unknown_resolution_${attempt.id}`,
      jobId: attempt.requestId,
      type: "unknown_terminal_resolution_evidence_recovered",
      message: "Provider success resolved an unknown outcome as append-only evidence for operator reconciliation",
      metadata: toInputJson({
        attemptId: attempt.id,
        terminalStatus: attempt.status,
        transportStatus: transport.status,
        terminalRecordOutcome: "succeeded",
        terminalRecordRef: input.terminalRecordRef,
        terminalRecordChecksum: input.terminalRecordChecksum,
        originalTerminalRecordRef,
        resolutionReceiptId: createdReceipt.id,
        resolutionPayloadHash: payloadHash,
        assetCount: assets.length,
        recoveredSuccess: finalizePayload(input),
      }),
    },
  });
  return {
    acknowledged: true,
    status: "persisted",
    receiptId: createdReceipt.id,
  };
}

async function terminalRecordAuthorityMismatch(
  tx: Prisma.TransactionClient,
  input: GenerationTerminalRecordIngest,
  attempt: {
    id: string;
    requestId: string;
    attemptNo: number;
    provider: string | null;
    profileKey: string | null;
    profileVersion: number | null;
    workflowKey: string | null;
    workflowVersion: number | null;
    status: string;
  },
) {
  if (input.terminalRecord.outcome === "succeeded") {
    const ordinals = input.terminalRecord.assets.map((asset) => asset.ordinal);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      return "generation_terminal_asset_ordinals_invalid";
    }
    const requiredPrefix = `${input.terminalRecord.mode}/`;
    if (input.terminalRecord.assets.some(
      (asset) => !asset.contentType.startsWith(requiredPrefix),
    )) {
      return "generation_terminal_asset_content_type_mismatch";
    }
  }
  const dispatch = await resolveExactGenerationDispatchAuthority(tx, {
    requestId: input.terminalRecord.requestId,
    generationJobId: input.terminalRecord.generationJobId,
    attemptId: input.terminalRecord.attemptId,
    attemptNo: input.terminalRecord.attemptNo,
    transportAttemptNo: input.terminalRecord.transportAttemptNo,
    provider: input.terminalRecord.provider,
    model: input.terminalRecord.model,
    providerIdempotencyKey: input.terminalRecord.providerIdempotencyKey,
  }, attempt);
  if (!dispatch.ok) return dispatch.code;
  const { mode: expectedMode, queuePayload: payload } = dispatch.authority;
  if (input.terminalRecord.mode !== expectedMode) {
    return "generation_terminal_mode_mismatch";
  }
  if (terminalRecordProviderInvoked(input) && attempt.status !== "unknown") {
    const existingTransport = await tx.generationTransportExecution.findUnique({
      where: {
        attemptId_transportAttemptNo: {
          attemptId: attempt.id,
          transportAttemptNo: input.terminalRecord.transportAttemptNo,
        },
      },
    });
    const expectedTransportStatus = terminalTransportStatus(
      input.terminalRecord.outcome,
    );
    if (
      existingTransport &&
      (existingTransport.idempotencyKey !==
          input.terminalRecord.providerIdempotencyKey ||
        (existingTransport.providerRequestId !== null &&
          existingTransport.providerRequestId !==
            input.terminalRecord.providerRequestId) ||
        (existingTransport.terminalRecordRef !== null &&
          existingTransport.terminalRecordRef !== input.terminalRecordRef))
    ) {
      return "generation_terminal_transport_identity_conflict";
    }
    if (
      existingTransport &&
      !isGenerationTransportExecutionTransitionAllowed(
        existingTransport.status,
        expectedTransportStatus,
      )
    ) {
      return "generation_terminal_transport_status_conflict";
    }
    if (
      existingTransport &&
      await generationInvocationUsageFactConflicts(
        tx,
        terminalRecordUsageFactInput(input, existingTransport.id),
      )
    ) {
      return "generation_terminal_accounting_replay_conflict";
    }
  }
  if (input.terminalRecord.outcome === "succeeded") {
    const assets = input.terminalRecord.assets;
    const outputPrefix = payload.outputPrefix;
    const expectedOutputPrefix = generationAttemptOutputPrefix(
      input.terminalRecord.generationJobId,
      input.terminalRecord.attemptId,
    );
    const keys = assets.map((asset) => asset.key);
    if (
      typeof outputPrefix !== "string" ||
      outputPrefix !== expectedOutputPrefix ||
      keys.some((key) => !key.startsWith(outputPrefix)) ||
      new Set(keys).size !== keys.length
    ) {
      return "generation_terminal_asset_storage_authority_mismatch";
    }
    if (
      (expectedMode === "image" &&
        (typeof payload.count !== "number" ||
          !Number.isSafeInteger(payload.count) ||
          assets.length > payload.count)) ||
      (expectedMode === "video" && assets.length !== 1)
    ) {
      return "generation_terminal_asset_count_mismatch";
    }
  }
  return null;
}

// INVARIANT: a canonical processed Receipt is an immutable ACK. A conflicting
// envelope receives its own quarantine Receipt so replaying the canonical
// envelope remains a duplicate ACK instead of being poisoned by the conflict.
async function quarantineTerminalRecordEnvelope(
  tx: Prisma.TransactionClient,
  attemptId: string,
  payloadHash: string,
  code: string,
) {
  const sourceEventId = `${attemptId}:${payloadHash}`;
  return tx.inboundEventReceipt.upsert({
    where: {
      sourceService_sourceEventId: {
        sourceService: "gen_quarantine",
        sourceEventId,
      },
    },
    create: {
      sourceService: "gen_quarantine",
      sourceEventId,
      payloadHash,
      processingState: "quarantined",
      quarantinedAt: new Date(),
      error: toInputJson({ code, canonicalAttemptId: attemptId }),
    },
    update: {},
  });
}

async function quarantineUnknownResolutionEnvelope(
  tx: Prisma.TransactionClient,
  attemptId: string,
  payloadHash: string,
  code: string,
) {
  const sourceEventId = `${attemptId}:${payloadHash}`;
  return tx.inboundEventReceipt.upsert({
    where: {
      sourceService_sourceEventId: {
        sourceService: "gen_resolution_quarantine",
        sourceEventId,
      },
    },
    create: {
      sourceService: "gen_resolution_quarantine",
      sourceEventId,
      payloadHash,
      processingState: "quarantined",
      quarantinedAt: new Date(),
      error: toInputJson({ code, canonicalAttemptId: attemptId }),
    },
    update: {},
  });
}

function terminalRecordProviderInvoked(
  input: GenerationTerminalRecordIngest,
) {
  return input.terminalRecord.providerInvoked;
}

async function recordTerminalTransportEvidence(
  tx: Prisma.TransactionClient,
  input: GenerationTerminalRecordIngest,
  attemptId: string,
) {
  if (!terminalRecordProviderInvoked(input)) return null;
  const status = terminalTransportStatus(input.terminalRecord.outcome);
  const key = {
    attemptId_transportAttemptNo: {
      attemptId,
      transportAttemptNo: input.terminalRecord.transportAttemptNo,
    },
  } as const;
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM generation_transport_executions
    WHERE "attemptId" = ${attemptId}
      AND "transportAttemptNo" = ${input.terminalRecord.transportAttemptNo}
    FOR UPDATE
  `);
  const existing = await tx.generationTransportExecution.findUnique({ where: key });
  const idempotencyKey = input.terminalRecord.providerIdempotencyKey ?? attemptId;
  if (
    existing &&
    ((existing.idempotencyKey !== null && existing.idempotencyKey !== idempotencyKey) ||
      (existing.providerRequestId !== null &&
        existing.providerRequestId !== input.terminalRecord.providerRequestId) ||
      (existing.terminalRecordRef !== null &&
        existing.terminalRecordRef !== input.terminalRecordRef))
  ) {
    throw Errors.conflict(
      "Terminal record conflicts with immutable TransportExecution identity",
      { attemptId, transportAttemptNo: input.terminalRecord.transportAttemptNo },
    );
  }
  if (
    existing &&
    !isGenerationTransportExecutionTransitionAllowed(existing.status, status)
  ) {
    throw Errors.conflict(
      "Terminal record cannot rewrite a terminal TransportExecution",
      { status: existing.status },
    );
  }
  let transport = existing;
  if (!existing) {
    transport = await tx.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: input.terminalRecord.transportAttemptNo,
        providerRequestId: input.terminalRecord.providerRequestId,
        idempotencyKey,
        status,
        latencyMs: input.terminalRecord.accounting?.latencyMs,
        costMicros: terminalRecordCostMicros(input),
        pricingVersion: input.terminalRecord.accounting?.pricingVersion,
        terminalRecordRef: input.terminalRecordRef,
        finishedAt: new Date(input.terminalRecord.completedAt),
      },
    });
  } else if (existing.status !== status) {
    const updated = await tx.generationTransportExecution.updateMany({
      where: {
        attemptId,
        transportAttemptNo: input.terminalRecord.transportAttemptNo,
        status: existing.status,
        idempotencyKey: existing.idempotencyKey,
        providerRequestId: existing.providerRequestId,
        terminalRecordRef: existing.terminalRecordRef,
      },
      data: {
        status,
        providerRequestId:
          input.terminalRecord.providerRequestId ?? existing.providerRequestId,
        latencyMs: input.terminalRecord.accounting?.latencyMs,
        costMicros: terminalRecordCostMicros(input),
        pricingVersion: input.terminalRecord.accounting?.pricingVersion,
        terminalRecordRef: input.terminalRecordRef,
        finishedAt: new Date(input.terminalRecord.completedAt),
      },
    });
    if (updated.count !== 1) {
      throw Errors.conflict("TransportExecution changed during terminal ingest", {
        attemptId,
        transportAttemptNo: input.terminalRecord.transportAttemptNo,
      });
    }
    transport = await tx.generationTransportExecution.findUniqueOrThrow({ where: key });
  }
  if (!transport) {
    throw Errors.conflict("TransportExecution was not persisted", { attemptId });
  }
  await recordGenerationInvocationUsageFact(
    tx,
    terminalRecordUsageFactInput(input, transport.id),
  );
  return transport;
}

// INTENT: A recovered terminal blob is evidence for reconciliation, not authority
// to silently turn an already-unknown business Attempt into success or failure.
async function recordRecoveredUnknownTransportEvidence(
  tx: Prisma.TransactionClient,
  input: GenerationTerminalRecordIngest,
  attemptId: string,
) {
  if (!terminalRecordProviderInvoked(input)) return null;
  if (input.terminalRecord.outcome !== "unknown") {
    throw Errors.conflict(
      "A resolved provider outcome requires append-only resolution evidence",
      { attemptId },
    );
  }
  const key = {
    attemptId_transportAttemptNo: {
      attemptId,
      transportAttemptNo: input.terminalRecord.transportAttemptNo,
    },
  } as const;
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM generation_transport_executions
    WHERE "attemptId" = ${attemptId}
      AND "transportAttemptNo" = ${input.terminalRecord.transportAttemptNo}
    FOR UPDATE
  `);
  const idempotencyKey = input.terminalRecord.providerIdempotencyKey ?? attemptId;
  let transport = await tx.generationTransportExecution.findUnique({ where: key });
  const resolvedStatus = "unknown" as const;
  if (
    transport &&
    (!(
      transport.status === "unknown" ||
      transport.status === resolvedStatus
    ) ||
      (transport.idempotencyKey !== null &&
        transport.idempotencyKey !== idempotencyKey) ||
      (transport.providerRequestId !== null &&
        transport.providerRequestId !== input.terminalRecord.providerRequestId))
  ) {
    throw Errors.conflict(
      "Recovered terminal evidence conflicts with unknown TransportExecution",
      { attemptId, transportAttemptNo: input.terminalRecord.transportAttemptNo },
    );
  }
  if (!transport) {
    transport = await tx.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: input.terminalRecord.transportAttemptNo,
        providerRequestId: input.terminalRecord.providerRequestId,
        idempotencyKey,
        status: resolvedStatus,
        latencyMs: input.terminalRecord.accounting?.latencyMs,
        costMicros: terminalRecordCostMicros(input),
        pricingVersion: input.terminalRecord.accounting?.pricingVersion,
        terminalRecordRef: input.terminalRecordRef,
        finishedAt: new Date(input.terminalRecord.completedAt),
      },
    });
  } else if (transport.terminalRecordRef === null) {
    const linked = await tx.generationTransportExecution.updateMany({
      where: {
        id: transport.id,
        status: transport.status,
        terminalRecordRef: null,
        idempotencyKey: transport.idempotencyKey,
        providerRequestId: transport.providerRequestId,
      },
      data: {
        status: "unknown",
        providerRequestId:
          transport.providerRequestId ?? input.terminalRecord.providerRequestId,
        latencyMs:
          transport.latencyMs ?? input.terminalRecord.accounting?.latencyMs,
        costMicros:
          transport.costMicros ?? terminalRecordCostMicros(input),
        pricingVersion:
          transport.pricingVersion ?? input.terminalRecord.accounting?.pricingVersion,
        terminalRecordRef: input.terminalRecordRef,
        finishedAt: transport.finishedAt ?? new Date(input.terminalRecord.completedAt),
      },
    });
    if (linked.count !== 1) {
      throw Errors.conflict(
        "Unknown TransportExecution changed during terminal evidence recovery",
        { attemptId, transportAttemptNo: input.terminalRecord.transportAttemptNo },
      );
    }
    transport = await tx.generationTransportExecution.findUniqueOrThrow({ where: key });
  } else if (transport.terminalRecordRef !== input.terminalRecordRef) {
    throw Errors.conflict(
      "Recovered terminal evidence changed TransportExecution terminal reference",
      { attemptId, transportAttemptNo: input.terminalRecord.transportAttemptNo },
    );
  }
  await recordGenerationInvocationUsageFact(
    tx,
    terminalRecordUsageFactInput(input, transport.id),
  );
  return transport;
}

function terminalAssets(input: GenerationTerminalRecordIngest) {
  return input.terminalRecord.outcome === "succeeded"
    ? input.terminalRecord.assets
    : [];
}

function terminalRecordCostMicros(input: GenerationTerminalRecordIngest): bigint | null {
  const costMicros = input.terminalRecord.accounting?.costMicros;
  return costMicros === null || costMicros === undefined ? null : BigInt(costMicros);
}

function terminalRecordUsageFactInput(
  input: GenerationTerminalRecordIngest,
  transportExecutionId: string,
) {
  return {
    attemptId: input.terminalRecord.attemptId,
    generationJobId: input.terminalRecord.generationJobId,
    transportAttemptNo: input.terminalRecord.transportAttemptNo,
    transportExecutionId,
    provider: input.terminalRecord.provider,
    model: input.terminalRecord.model,
    usage: input.terminalRecord.accounting?.usage ?? input.terminalRecord.usage,
    latencyMs: input.terminalRecord.accounting?.latencyMs ?? null,
    costMicros: input.terminalRecord.accounting?.costMicros ?? null,
    pricingVersion: input.terminalRecord.accounting?.pricingVersion ?? null,
    occurredAt: new Date(input.terminalRecord.completedAt),
  };
}

function finalizePayload(input: GenerationTerminalRecordIngest) {
  const record = input.terminalRecord;
  const common = {
    version: 1,
    requestId: record.requestId,
    generationJobId: record.generationJobId,
    attemptId: record.attemptId,
    attemptNo: record.attemptNo,
    terminalRecordRef: input.terminalRecordRef,
    terminalRecordChecksum: input.terminalRecordChecksum,
    mode: record.mode,
  } as const;
  if (record.outcome === "succeeded") {
    return {
      ...common,
      kind: "generation.completed" as const,
      provider: record.provider,
      model: record.model,
      assets: record.assets.map((asset) => ({
        key: asset.key,
        contentType: asset.contentType,
        width: asset.width,
        height: asset.height,
        seconds: asset.seconds,
        providerKey: asset.providerKey,
        quality: asset.quality,
      })),
      usage: record.usage,
    };
  }
  if (record.outcome === "blocked") {
    return {
      ...common,
      kind: "generation.blocked" as const,
      policyCode: record.block.policyCode,
      message: record.block.message,
      layer: record.block.layer,
    };
  }
  const error = {
    code: record.error.code,
    message: record.error.message,
    retryable: record.error.retryability === "retryable",
    retryability: record.error.retryability,
  };
  // INTENT: Gen's ambiguous terminal outcome keeps its own finalize kind all the
  // way to settlement. Collapsing it into generation.failed would hand a possibly
  // charged, possibly produced Attempt to the refund-and-retry path.
  if (record.outcome === "unknown") {
    return { ...common, kind: "generation.unknown" as const, error };
  }
  return { ...common, kind: "generation.failed" as const, error };
}

export async function dispatchPendingGenerationTerminalRecords(
  input: number | {
    readonly batch?: number;
    readonly outboxIds?: readonly string[];
    readonly queue?: { enqueue(input: EnqueueJobInput): Promise<unknown> };
  } = 100,
): Promise<number> {
  const requestedBatch = typeof input === "number" ? input : input.batch ?? 100;
  const batch = Math.min(100, Math.max(1, requestedBatch));
  const outboxIds = typeof input === "number" ? undefined : input.outboxIds;
  const queue = typeof input === "number" ? jobQueue : input.queue ?? jobQueue;
  const now = new Date();
  const pendingWhere: Prisma.MainOutboxEventWhereInput = {
    eventType: "generation.terminal_record.accepted.v1",
    status: { in: ["pending", "dispatched"] },
    ...(outboxIds ? { id: { in: [...outboxIds] } } : {}),
  };
  const [oldestPending, rows] = await Promise.all([
    prisma.mainOutboxEvent.findFirst({
      where: pendingWhere,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: { ...pendingWhere, nextRunAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: batch,
    }),
  ]);
  setGauge(
    "main_outbox_pending_age_seconds",
    "Age of the oldest pending Main outbox event",
    { queue: "generation_terminal_record" },
    oldestPending ? Math.max(0, now.getTime() - oldestPending.createdAt.getTime()) / 1_000 : 0,
  );
  let dispatched = 0;
  for (const row of rows) {
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const claimed = await prisma.mainOutboxEvent.updateMany({
      where: {
        id: row.id,
        status: row.status,
        nextRunAt: row.nextRunAt,
      },
      data: {
        status: "dispatched",
        attempts: { increment: 1 },
        nextRunAt: leaseExpiresAt,
        lastError: Prisma.DbNull,
      },
    });
    if (claimed.count !== 1) continue;
    try {
      await queue.enqueue({
        queue: "app.ai.finalize",
        payload: row.payload as Prisma.InputJsonValue,
        dedupeKey: generationTerminalFinalizeDedupeKey(row.aggregateId),
      });
      const acknowledged = await prisma.mainOutboxEvent.updateMany({
        where: {
          id: row.id,
          status: "dispatched",
          nextRunAt: leaseExpiresAt,
        },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          lastError: Prisma.DbNull,
        },
      });
      if (acknowledged.count === 1) dispatched += 1;
    } catch (error) {
      await prisma.mainOutboxEvent.updateMany({
        where: {
          id: row.id,
          status: "dispatched",
          nextRunAt: leaseExpiresAt,
        },
        data: {
          status: "pending",
          nextRunAt: new Date(Date.now() + 30_000),
          lastError: toInputJson({ message: error instanceof Error ? error.message : "terminal record dispatch failed" }),
        },
      });
    }
  }
  return dispatched;
}
