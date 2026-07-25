import { Prisma } from "@prisma/client";
import {
  generationManifestChecksum,
  generationManifestIngestSchema,
  type GenerationManifestIngest,
} from "@idream/shared/contracts";
import { incrementCounter, setGauge } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import {
  isGenerationArtifactArchiveTransitionAllowed,
  isGenerationArtifactValidationTransitionAllowed,
  isGenerationDeliveryTransitionAllowed,
  isGenerationTransportExecutionTransitionAllowed,
} from "./generation-evidence-transition-authority";
import { isGenerationAttemptTransitionAllowed } from "@/server/modules/admin-v2/shared/state-transition-authority";
import { recordGenerationInvocationUsageFact } from "./generation-invocation-usage";

export async function ingestGenerationManifest(
  rawInput: unknown,
): Promise<{ acknowledged: boolean; status: "persisted" | "duplicate" | "quarantined"; receiptId: string | null }> {
  const input = generationManifestIngestSchema.parse(rawInput);
  if (generationManifestChecksum(input.manifest) !== input.manifestChecksum) {
    return { acknowledged: false, status: "quarantined", receiptId: null };
  }
  const result = await prisma.$transaction(async (tx) => {
    const receiptWhere = {
      sourceService_sourceEventId: { sourceService: "gen", sourceEventId: input.manifest.attemptId },
    } as const;
    const receipt = await tx.inboundEventReceipt.findUnique({ where: receiptWhere });
    if (receipt) {
      if (receipt.payloadHash === input.manifestChecksum) {
        return { acknowledged: true, status: "duplicate" as const, receiptId: receipt.id };
      }
      await tx.inboundEventReceipt.update({
        where: receiptWhere,
        data: {
          processingState: "quarantined",
          quarantinedAt: new Date(),
          error: toInputJson({ code: "manifest_checksum_conflict" }),
        },
      });
      return { acknowledged: false, status: "quarantined" as const, receiptId: receipt.id };
    }
    const existingAttempt = await tx.generationAttempt.findUnique({
      where: { id: input.manifest.attemptId },
    });
    if (
      existingAttempt &&
      (existingAttempt.requestId !== input.manifest.generationJobId ||
        existingAttempt.attemptNo !== input.manifest.attemptNo)
    ) {
      const quarantined = await tx.inboundEventReceipt.create({
        data: {
          sourceService: "gen",
          sourceEventId: input.manifest.attemptId,
          payloadHash: input.manifestChecksum,
          processingState: "quarantined",
          quarantinedAt: new Date(),
          error: toInputJson({ code: "generation_attempt_identity_mismatch" }),
        },
      });
      return { acknowledged: false, status: "quarantined" as const, receiptId: quarantined.id };
    }
    const lateValidationState = existingAttempt
      ? lateArtifactValidationState(existingAttempt.status)
      : null;
    if (existingAttempt && lateValidationState) {
      const request = await tx.generationJob.findUniqueOrThrow({
        where: { id: existingAttempt.requestId },
        select: { userId: true },
      });
      const createdReceipt = await tx.inboundEventReceipt.create({ data: {
        sourceService: "gen",
        sourceEventId: input.manifest.attemptId,
        payloadHash: input.manifestChecksum,
        processingState: "processed",
        processedAt: new Date(),
      } });
      const transportKey = { attemptId_transportAttemptNo: { attemptId: existingAttempt.id, transportAttemptNo: input.manifest.transportAttemptNo } };
      const existingTransport = await tx.generationTransportExecution.findUnique({ where: transportKey });
      if (existingTransport && !isGenerationTransportExecutionTransitionAllowed(existingTransport.status, "succeeded")) {
        throw Errors.conflict("Completion manifest cannot rewrite a terminal TransportExecution", { status: existingTransport.status });
      }
      const transport = await tx.generationTransportExecution.upsert({
        where: transportKey,
        create: {
          attemptId: existingAttempt.id,
          transportAttemptNo: input.manifest.transportAttemptNo,
          providerRequestId: input.manifest.providerRequestId,
          idempotencyKey: input.manifest.providerIdempotencyKey ?? existingAttempt.id,
          status: "succeeded",
          latencyMs: input.manifest.accounting?.latencyMs,
          costMicros: manifestCostMicros(input),
          pricingVersion: input.manifest.accounting?.pricingVersion,
          manifestRef: input.manifestRef,
          finishedAt: new Date(input.manifest.completedAt),
        },
        update: {
          status: "succeeded",
          latencyMs: input.manifest.accounting?.latencyMs,
          costMicros: manifestCostMicros(input),
          pricingVersion: input.manifest.accounting?.pricingVersion,
          manifestRef: input.manifestRef,
          finishedAt: new Date(input.manifest.completedAt),
        },
      });
      await recordGenerationInvocationUsageFact(tx, manifestUsageFactInput(input, transport.id));
      for (const asset of input.manifest.assets) {
        const artifactKey = { attemptId_ordinal: { attemptId: existingAttempt.id, ordinal: asset.ordinal } };
        const existingArtifact = await tx.generationArtifact.findUnique({ where: artifactKey });
        if (existingArtifact && (
          !isGenerationArtifactValidationTransitionAllowed(existingArtifact.validationState, lateValidationState) ||
          !isGenerationArtifactArchiveTransitionAllowed(existingArtifact.archiveState, "archived")
        )) {
          throw Errors.conflict("Late completion cannot rewrite terminal Artifact evidence", {
            validationState: existingArtifact.validationState,
            archiveState: existingArtifact.archiveState,
          });
        }
        const artifact = await tx.generationArtifact.upsert({
          where: artifactKey,
          create: {
            attemptId: existingAttempt.id,
            ordinal: asset.ordinal,
            providerRef: asset.providerKey,
            manifestChecksum: input.manifestChecksum,
            validationState: lateValidationState,
            archiveState: "archived",
          },
          update: { validationState: lateValidationState, archiveState: "archived" },
        });
        const deliveryKey = {
          artifactId_targetType_targetId: {
            artifactId: artifact.id,
            targetType: "user_library",
            targetId: request.userId,
          },
        } as const;
        const existingDelivery = await tx.generationDelivery.findUnique({
          where: deliveryKey,
        });
        const fromStatus = existingDelivery?.status ?? "pending";
        if (!isGenerationDeliveryTransitionAllowed(fromStatus, "suppressed")) {
          throw Errors.conflict("Late completion cannot rewrite terminal Delivery evidence", {
            status: fromStatus,
          });
        }
        await tx.generationDelivery.upsert({
          where: deliveryKey,
          create: {
            id: `generation_delivery_${existingAttempt.requestId}_${asset.ordinal}`,
            requestId: existingAttempt.requestId,
            artifactId: artifact.id,
            targetType: "user_library",
            targetId: request.userId,
            status: "suppressed",
          },
          update: { status: "suppressed", deliveredAt: null },
        });
      }
      await tx.generationJobEvent.create({ data: {
        jobId: input.manifest.generationJobId,
        type: "late_artifact_archived",
        message: "Provider artifacts arrived after a terminal outcome and were archived without delivery",
        metadata: toInputJson({
          attemptId: existingAttempt.id,
          terminalStatus: existingAttempt.status,
          manifestRef: input.manifestRef,
          assetCount: input.manifest.assets.length,
        }),
      } });
      return { acknowledged: true, status: "persisted" as const, receiptId: createdReceipt.id };
    }
    if (existingAttempt && !isGenerationAttemptTransitionAllowed(existingAttempt.status, "running")) {
      throw Errors.conflict("Completion manifest cannot reopen a terminal Generation Attempt", {
        status: existingAttempt.status,
      });
    }
    const attempt = await tx.generationAttempt.upsert({
      where: { id: input.manifest.attemptId },
      create: {
        id: input.manifest.attemptId,
        requestId: input.manifest.generationJobId,
        attemptNo: input.manifest.attemptNo,
        provider: input.manifest.provider,
        status: "running",
        completionManifestRef: input.manifestRef,
      },
      update: {
        provider: input.manifest.provider,
        status: "running",
        completionManifestRef: input.manifestRef,
      },
    });
    await recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:manifest-ingested`,
      attemptId: attempt.id,
      eventType: "generation.attempt.manifest_ingested.v1",
      occurredAt: new Date(input.manifest.completedAt),
      payload: {
        requestId: input.manifest.generationJobId,
        manifestRef: input.manifestRef,
        manifestChecksum: input.manifestChecksum,
        provider: input.manifest.provider,
        providerRequestId: input.manifest.providerRequestId,
        transportAttemptNo: input.manifest.transportAttemptNo,
        providerIdempotencyKey: input.manifest.providerIdempotencyKey ?? input.manifest.attemptId,
        assetCount: input.manifest.assets.length,
      },
      status: "running",
      completionManifestRef: input.manifestRef,
    });
    const createdReceipt = await tx.inboundEventReceipt.create({
      data: {
        sourceService: "gen",
        sourceEventId: input.manifest.attemptId,
        payloadHash: input.manifestChecksum,
        processingState: "processed",
        processedAt: new Date(),
      },
    });
    const transportKey = { attemptId_transportAttemptNo: { attemptId: attempt.id, transportAttemptNo: input.manifest.transportAttemptNo } };
    const existingTransport = await tx.generationTransportExecution.findUnique({ where: transportKey });
    if (existingTransport && !isGenerationTransportExecutionTransitionAllowed(existingTransport.status, "succeeded")) {
      throw Errors.conflict("Completion manifest cannot rewrite a terminal TransportExecution", { status: existingTransport.status });
    }
    const transport = await tx.generationTransportExecution.upsert({
      where: transportKey,
      create: {
        attemptId: attempt.id,
        transportAttemptNo: input.manifest.transportAttemptNo,
        providerRequestId: input.manifest.providerRequestId,
        idempotencyKey: input.manifest.providerIdempotencyKey ?? attempt.id,
        status: "succeeded",
        latencyMs: input.manifest.accounting?.latencyMs,
        costMicros: manifestCostMicros(input),
        pricingVersion: input.manifest.accounting?.pricingVersion,
        manifestRef: input.manifestRef,
        finishedAt: new Date(input.manifest.completedAt),
      },
      update: {
        status: "succeeded",
        providerRequestId: input.manifest.providerRequestId,
        latencyMs: input.manifest.accounting?.latencyMs,
        costMicros: manifestCostMicros(input),
        pricingVersion: input.manifest.accounting?.pricingVersion,
        manifestRef: input.manifestRef,
        finishedAt: new Date(input.manifest.completedAt),
      },
    });
    await recordGenerationInvocationUsageFact(tx, manifestUsageFactInput(input, transport.id));
    for (const asset of input.manifest.assets) {
      await tx.generationArtifact.upsert({
        where: { attemptId_ordinal: { attemptId: attempt.id, ordinal: asset.ordinal } },
        create: {
          attemptId: attempt.id,
          ordinal: asset.ordinal,
          providerRef: asset.providerKey,
          manifestChecksum: input.manifestChecksum,
          validationState: "produced",
        },
        update: {},
      });
    }
    const outboxId = `generation_manifest_${attempt.id}`;
    await tx.mainOutboxEvent.upsert({
      where: { id: outboxId },
      create: {
        id: outboxId,
        eventType: "generation.manifest.accepted.v1",
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
      "generation_completion_manifest_replay_total",
      "Persisted generation completion manifests replayed after durable ingest interruption",
      { outcome: "durable_duplicate" },
    );
  }
  return result;
}

function lateArtifactValidationState(status: string) {
  if (status === "cancelled") return "late_after_cancel" as const;
  if (status === "failed") return "late_after_failed" as const;
  if (status === "blocked") return "late_after_blocked" as const;
  if (status === "refunded") return "late_after_refunded" as const;
  return null;
}

function manifestCostMicros(input: GenerationManifestIngest): bigint | null {
  const costMicros = input.manifest.accounting?.costMicros;
  return costMicros === null || costMicros === undefined ? null : BigInt(costMicros);
}

function manifestUsageFactInput(
  input: GenerationManifestIngest,
  transportExecutionId: string,
) {
  return {
    attemptId: input.manifest.attemptId,
    generationJobId: input.manifest.generationJobId,
    transportAttemptNo: input.manifest.transportAttemptNo,
    transportExecutionId,
    provider: input.manifest.provider,
    model: input.manifest.model,
    usage: input.manifest.accounting?.usage ?? input.manifest.usage,
    latencyMs: input.manifest.accounting?.latencyMs ?? null,
    costMicros: input.manifest.accounting?.costMicros ?? null,
    pricingVersion: input.manifest.accounting?.pricingVersion ?? null,
    occurredAt: new Date(input.manifest.completedAt),
  };
}

function finalizePayload(input: GenerationManifestIngest) {
  return {
    version: 1,
    kind: "generation.completed",
    requestId: input.manifest.requestId,
    generationJobId: input.manifest.generationJobId,
    attemptId: input.manifest.attemptId,
    attemptNo: input.manifest.attemptNo,
    completionManifestRef: input.manifestRef,
    completionManifestChecksum: input.manifestChecksum,
    mode: input.manifest.mode,
    provider: input.manifest.provider,
    model: input.manifest.model,
    assets: input.manifest.assets.map((asset) => ({
      key: asset.key,
      contentType: asset.contentType,
      width: asset.width,
      height: asset.height,
      seconds: asset.seconds,
      providerKey: asset.providerKey,
    })),
    usage: input.manifest.usage,
  };
}

export async function dispatchPendingGenerationManifests(batch = 100): Promise<number> {
  const now = new Date();
  const pendingWhere: Prisma.MainOutboxEventWhereInput = {
    eventType: "generation.manifest.accepted.v1",
    status: { in: ["pending", "dispatched"] },
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
    { queue: "generation_manifest" },
    oldestPending ? Math.max(0, now.getTime() - oldestPending.createdAt.getTime()) / 1_000 : 0,
  );
  let dispatched = 0;
  for (const row of rows) {
    try {
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: { status: "dispatched", attempts: { increment: 1 }, nextRunAt: new Date(Date.now() + 30_000) },
      });
      await jobQueue.enqueue({
        queue: "app.ai.finalize",
        payload: row.payload as Prisma.InputJsonValue,
        dedupeKey: `generation-manifest-finalize:${row.aggregateId}`,
      });
      dispatched += 1;
    } catch (error) {
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "pending",
          nextRunAt: new Date(Date.now() + 30_000),
          lastError: toInputJson({ message: error instanceof Error ? error.message : "manifest dispatch failed" }),
        },
      });
    }
  }
  return dispatched;
}
