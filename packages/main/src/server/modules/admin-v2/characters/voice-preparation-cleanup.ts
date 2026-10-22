import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { BlobStore, VoiceIdentityPort } from "@/server/providers/types";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { toInputJson } from "../shared/prisma-json";

export const VOICE_PREPARATION_CLEANUP_EVENT = "voice.preparation_cleanup.requested.v1";
const LEASE_MS = 60_000;
const cleanupPayloadSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["fish_audio", "pocket_tts"]),
  ownerId: z.string().min(1),
  characterId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  voiceId: z.string().regex(/^idream-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  previewKey: z.string().nullable(),
  referenceKey: z.string().nullable(),
}).strict().refine((value) => {
  const prefix = `voice-references/${value.characterId}/${value.voiceId}`;
  return (value.previewKey === null || value.previewKey === `voice-previews/${value.characterId}/${value.voiceId}.wav`) &&
    (value.referenceKey === null || [".wav", ".mp3", ".flac", ".ogg", ".json"].some((extension) => value.referenceKey === `${prefix}${extension}`));
}, "Voice cleanup keys must belong to the failed preparation");

type CleanupPayload = z.infer<typeof cleanupPayloadSchema>;

// Only call after the local preparation attempt has ended. A gateway DELETE
// fences a late clone completion; elapsed time alone never abandons an attempt
// still owned by an active Main request.
export async function recordVoicePreparationCleanup(
  input: Omit<CleanupPayload, "version">,
): Promise<string | null> {
  const payload = cleanupPayloadSchema.parse({ version: 1, ...input });
  return prisma.$transaction(async (tx) => {
    // A COMMIT acknowledgement can be lost while its transaction still runs.
    // All profile writes take this same lock; wait before deciding ownership.
    await tx.$queryRaw`SELECT "id" FROM "characters" WHERE "id" = ${payload.characterId} FOR UPDATE`;
    if (await tx.characterVoiceProfile.findUnique({
      where: { providerVoiceId: payload.voiceId }, select: { id: true },
    })) return null;
    const id = `voice_preparation_cleanup_${payload.voiceId}`;
    await tx.mainOutboxEvent.upsert({
      where: { id },
      create: { id, eventType: VOICE_PREPARATION_CLEANUP_EVENT,
        aggregateType: "character_voice_preparation", aggregateId: payload.voiceId,
        payload: toInputJson(payload) },
      update: {},
    });
    return id;
  }, { isolationLevel: "ReadCommitted" });
}

export async function dispatchPendingVoicePreparationCleanup(input: {
  blob?: Pick<BlobStore, "delete">;
  identityForProvider?: (provider: CleanupPayload["provider"]) => Pick<VoiceIdentityPort, "providerKey" | "deleteVoice"> | null;
  batch?: number;
  outboxIds?: readonly string[];
  signal?: AbortSignal;
  now?: Date;
} = {}): Promise<{ delivered: number; failed: number; cancelled: number }> {
  const counts = { delivered: 0, failed: 0, cancelled: 0 };
  if (input.signal?.aborted) return counts;
  const now = input.now ?? new Date();
  const eligible = { OR: [
    { status: "pending", nextRunAt: { lte: now } },
    { status: "processing", leaseExpiresAt: { lte: now } },
  ] };
  const rows = await prisma.mainOutboxEvent.findMany({
    where: { eventType: VOICE_PREPARATION_CLEANUP_EVENT, ...eligible,
      ...(input.outboxIds ? { id: { in: [...input.outboxIds] } } : {}) },
    orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(input.batch ?? 25, 100)),
  });
  for (const row of rows) {
    if (input.signal?.aborted) break;
    const leaseToken = randomUUID();
    const attempts = row.attempts + 1;
    const claimed = await prisma.mainOutboxEvent.updateMany({
      where: { id: row.id, attempts: row.attempts, ...eligible },
      data: { status: "processing", attempts, leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
    if (claimed.count !== 1) continue;
    const owned = { id: row.id, status: "processing", leaseToken, attempts };
    let lostLease = false;
    let heartbeatPending: Promise<void> = Promise.resolve();
    const renew = async () => {
      if (lostLease) throw new Error("Voice preparation cleanup lease lost");
      const renewed = await prisma.mainOutboxEvent.updateMany({ where: owned,
        data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } });
      if (renewed.count !== 1) {
        lostLease = true;
        throw new Error("Voice preparation cleanup lease lost");
      }
    };
    const heartbeat = setInterval(() => {
      heartbeatPending = heartbeatPending.then(renew).catch(() => { lostLease = true; });
    }, 10_000);
    try {
      const payload = cleanupPayloadSchema.parse(row.payload);
      if (row.id !== `voice_preparation_cleanup_${payload.voiceId}` ||
          row.aggregateType !== "character_voice_preparation" || row.aggregateId !== payload.voiceId) {
        throw new Error("Invalid voice preparation cleanup authority");
      }
      const committed = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "characters" WHERE "id" = ${payload.characterId} FOR UPDATE`;
        return tx.characterVoiceProfile.findUnique({
          where: { providerVoiceId: payload.voiceId }, select: { id: true },
        });
      }, { isolationLevel: "ReadCommitted" });
      if (committed) {
        const cancelled = await prisma.mainOutboxEvent.updateMany({ where: owned,
          data: { status: "cancelled", leaseToken: null, leaseExpiresAt: null,
            lastError: { code: "voice_profile_committed", profileId: committed.id } } });
        counts.cancelled += cancelled.count;
        continue;
      }
      // No transaction or row lock spans external deletion. The durable intent
      // owns this failed attempt's unique alias; gateways fence late clone
      // commits and every retry uses the preparation's pinned provider.
      const identity = input.identityForProvider
        ? input.identityForProvider(payload.provider)
        : createVoicePortsForKey(payload.provider).identity;
      if (!identity || identity.providerKey !== payload.provider) {
        throw new Error("Voice cleanup provider does not match its preparation");
      }
      await renew();
      const voiceResult = await identity.deleteVoice({ voiceId: payload.voiceId });
      if (!voiceResult.ok) throw new Error(`${voiceResult.error.code}: ${voiceResult.error.message}`);
      const blob = input.blob ?? providers.blob;
      for (const key of [payload.previewKey, payload.referenceKey]) {
        if (key === null) continue;
        await renew();
        const result = await blob.delete({ key });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      const completed = await prisma.mainOutboxEvent.updateMany({ where: owned,
        data: { status: "delivered", deliveredAt: new Date(), leaseToken: null,
          leaseExpiresAt: null, lastError: Prisma.DbNull } });
      counts.delivered += completed.count;
    } catch (error) {
      const retried = await prisma.mainOutboxEvent.updateMany({ where: owned,
        data: { status: "pending", leaseToken: null, leaseExpiresAt: null,
          nextRunAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))),
          lastError: toInputJson({ code: "voice_preparation_cleanup_failed",
            message: error instanceof Error ? error.message : String(error) }) } });
      counts.failed += retried.count;
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
    }
  }
  return counts;
}
