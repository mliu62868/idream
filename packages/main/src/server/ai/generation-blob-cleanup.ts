// Failed generated objects are not deliverable assets. Their immutable cleanup
// intent commits with terminal ingest and is retried independently of finalize.
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { GenerationTerminalRecordIngest } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { BlobStore } from "@/server/providers/types";
import { generationAttemptOutputPrefix } from "@/server/modules/generation/attempt-dispatch";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export const GENERATION_BLOB_CLEANUP_EVENT = "generation.blob_cleanup.requested.v1";
const LEASE_MS = 60_000;
const cleanupPayloadSchema = z.object({
  version: z.literal(1), userId: z.string().min(1), requestId: z.string().min(1),
  attemptId: z.string().min(1), mode: z.enum(["image", "video"]),
  maxOutputs: z.number().int().min(1).max(4),
  cleanupKeys: z.array(z.string().min(1)).min(1).max(4),
  terminalRecordRef: z.string().min(1), terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function generationCleanupKeysMatchDispatch(input: {
  requestId: string; attemptId: string; mode: "image" | "video";
  outputPrefix: unknown; maxOutputs: unknown; cleanupKeys: readonly string[];
}): boolean {
  const prefix = generationAttemptOutputPrefix(input.requestId, input.attemptId);
  const maxOutputs = input.maxOutputs;
  if (input.outputPrefix !== prefix || typeof maxOutputs !== "number" ||
      !Number.isSafeInteger(maxOutputs) || maxOutputs < 1 || maxOutputs > 4 ||
      !input.cleanupKeys.length || input.cleanupKeys.length > maxOutputs ||
      new Set(input.cleanupKeys).size !== input.cleanupKeys.length) return false;
  return input.cleanupKeys.every((key) => {
    if (!key.startsWith(prefix)) return false;
    const name = key.slice(prefix.length);
    if (input.mode === "video") return maxOutputs === 1 && name === "video.mp4";
    const match = /^image-([1-4])\.(png|jpg|webp)$/.exec(name);
    return match !== null && Number(match[1]) <= maxOutputs;
  });
}

export async function recordGenerationBlobCleanup(
  tx: Prisma.TransactionClient,
  input: GenerationTerminalRecordIngest,
  maxOutputs: number,
): Promise<void> {
  const record = input.terminalRecord;
  if (record.outcome !== "failed" || !record.cleanupKeys?.length) return;
  const request = await tx.generationJob.findUniqueOrThrow({
    where: { id: record.generationJobId }, select: { userId: true },
  });
  const payload = cleanupPayloadSchema.parse({
    version: 1, userId: request.userId, requestId: record.generationJobId,
    attemptId: record.attemptId, mode: record.mode, maxOutputs,
    cleanupKeys: record.cleanupKeys, terminalRecordRef: input.terminalRecordRef,
    terminalRecordChecksum: input.terminalRecordChecksum,
  });
  await tx.mainOutboxEvent.upsert({
    where: { id: `generation_blob_cleanup_${record.attemptId}` },
    create: {
      id: `generation_blob_cleanup_${record.attemptId}`, eventType: GENERATION_BLOB_CLEANUP_EVENT,
      aggregateType: "generation_attempt", aggregateId: record.attemptId, payload: toInputJson(payload),
    }, update: {},
  });
}

export async function dispatchPendingGenerationBlobCleanup(input: {
  db?: Pick<PrismaClient, "mainOutboxEvent">; blob?: Pick<BlobStore, "delete">;
  batch?: number; outboxIds?: readonly string[]; signal?: AbortSignal;
  now?: Date;
} = {}): Promise<{ delivered: number; failed: number }> {
  const counts = { delivered: 0, failed: 0 };
  if (input.signal?.aborted) return counts;
  const db = input.db ?? prisma;
  const blob = input.blob ?? providers.blob;
  const now = input.now ?? new Date();
  const eligible = {
    OR: [
      { status: "pending", nextRunAt: { lte: now } },
      { status: "processing", leaseExpiresAt: { lte: now } },
    ],
  };
  const rows = await db.mainOutboxEvent.findMany({
    where: { eventType: GENERATION_BLOB_CLEANUP_EVENT, ...eligible,
      ...(input.outboxIds ? { id: { in: [...input.outboxIds] } } : {}), },
    orderBy: [{ nextRunAt: "asc" }, { id: "asc" }], take: Math.max(1, Math.min(input.batch ?? 25, 100)),
  });
  for (const row of rows) {
    if (input.signal?.aborted) break;
    const leaseToken = randomUUID();
    const attempts = row.attempts + 1;
    const claimed = await db.mainOutboxEvent.updateMany({
      where: { id: row.id, attempts: row.attempts, ...eligible },
      data: { status: "processing", attempts, leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
    if (claimed.count !== 1) continue;
    const owned = { id: row.id, status: "processing", leaseToken, attempts };
    let lostLease = false;
    let heartbeatPending: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatPending = heartbeatPending.then(async () => {
        const renewed = await db.mainOutboxEvent.updateMany({ where: owned,
          data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) }, });
        if (renewed.count !== 1) lostLease = true;
      }).catch(() => { lostLease = true; });
    }, 10_000);
    try {
      const parsed = cleanupPayloadSchema.safeParse(row.payload);
      if (!parsed.success || row.aggregateType !== "generation_attempt" || row.aggregateId !== parsed.data.attemptId ||
          !generationCleanupKeysMatchDispatch({ ...parsed.data, outputPrefix: generationAttemptOutputPrefix(parsed.data.requestId, parsed.data.attemptId) })) {
        throw new Error("Invalid generation Blob cleanup authority");
      }
      for (const key of parsed.data.cleanupKeys) {
        if (lostLease) throw new Error("Generation Blob cleanup lease lost");
        const result = await blob.delete({ key });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      const completed = await db.mainOutboxEvent.updateMany({ where: owned,
        data: { status: "delivered", deliveredAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: Prisma.DbNull }, });
      counts.delivered += completed.count;
    } catch (error) {
      const retried = await db.mainOutboxEvent.updateMany({ where: owned,
        data: { status: "pending", leaseToken: null, leaseExpiresAt: null,
          nextRunAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))),
          lastError: toInputJson({ code: "generation_blob_cleanup_failed", message: error instanceof Error ? error.message : String(error) }), }, });
      counts.failed += retried.count;
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
    }
  }
  return counts;
}
