import { Prisma } from "@prisma/client";
import {
  generationManifestChecksum,
  generationManifestIngestSchema,
  type GenerationManifestIngest,
} from "@idream/shared/contracts";
import { incrementCounter, setGauge } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";

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
    await tx.generationTransportExecution.upsert({
      where: { attemptId_transportAttemptNo: { attemptId: attempt.id, transportAttemptNo: 1 } },
      create: {
        attemptId: attempt.id,
        transportAttemptNo: 1,
        providerRequestId: input.manifest.providerRequestId,
        idempotencyKey: attempt.id,
        status: "succeeded",
        manifestRef: input.manifestRef,
        finishedAt: new Date(input.manifest.completedAt),
      },
      update: { status: "succeeded", manifestRef: input.manifestRef, finishedAt: new Date(input.manifest.completedAt) },
    });
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
  const pendingWhere = {
    eventType: "generation.manifest.accepted.v1",
    status: { in: ["pending", "dispatched"] },
  } as const;
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
