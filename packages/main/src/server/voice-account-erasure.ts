import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { VoiceClipPort, VoiceProviderKey } from "@/server/providers/types";
import { createVoiceClipPortForKey } from "@/server/providers/voice/factory";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { voiceProviderIdempotencyKey } from "@/server/providers/voice/idempotency";

const receiptSchema = z.object({ version: z.literal(1), providers: z.array(z.object({
  providerKey: z.enum(["pocket_tts", "fish_audio"]), requestKeys: z.array(z.string()),
  voiceIds: z.array(z.string()), completedAt: z.string().nullable(),
})) });
export type VoiceErasureReceipt = z.infer<typeof receiptSchema>;

function providerKey(value: unknown): "pocket_tts" | "fish_audio" | null {
  if (value === "mock") return null;
  if (value !== "pocket_tts" && value !== "fish_audio") throw new Error("Cannot erase an unknown pinned voice provider");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Re-enumerate under AccountDeletion→User locks before ownership is removed. */
export async function materializeVoiceErasure(tx: Prisma.TransactionClient, deletion: { id: string; userId: string | null; voiceErasure: Prisma.JsonValue | null }) {
  const previous = deletion.voiceErasure === null ? { version: 1 as const, providers: [] } : receiptSchema.parse(deletion.voiceErasure);
  if (!deletion.userId) return previous;
  const providers = new Map(previous.providers.map(row => [row.providerKey, { ...row, requestKeys: new Set(row.requestKeys), voiceIds: new Set(row.voiceIds) }]));
  const owned = (value: unknown) => {
    const key = providerKey(value);
    if (!key) return null;
    let row = providers.get(key);
    if (!row) { row = { providerKey: key, requestKeys: new Set(), voiceIds: new Set(), completedAt: null }; providers.set(key, row); }
    return row;
  };
  const clips = await tx.voiceClipRequest.findMany({ where: { userId: deletion.userId }, select: { id: true, providerPayload: true } });
  for (const clip of clips) owned(record(clip.providerPayload).providerKey)?.requestKeys.add(voiceProviderIdempotencyKey(clip.id));
  const sequences = await tx.videoSequence.findMany({ where: { userId: deletion.userId, voicePin: { not: Prisma.DbNull } }, select: { id: true, voicePin: true, scenes: { select: { ordinal: true } } } });
  for (const sequence of sequences) {
    const row = owned(record(sequence.voicePin).provider);
    for (const scene of sequence.scenes) row?.requestKeys.add(`video-narration:${sequence.id}:${scene.ordinal}`);
  }
  const profiles = await tx.characterVoiceProfile.findMany({ where: { OR: [
    { character: { creatorId: deletion.userId } }, { referenceAsset: { ownerId: deletion.userId } }, { previewAsset: { ownerId: deletion.userId } },
  ] }, select: { provider: true, providerVoiceId: true } });
  for (const profile of profiles) owned(profile.provider)?.voiceIds.add(profile.providerVoiceId);
  const receipt: VoiceErasureReceipt = { version: 1, providers: [...providers.values()].sort((a, b) => a.providerKey.localeCompare(b.providerKey)).map(row => {
    const requestKeys = [...row.requestKeys].sort(), voiceIds = [...row.voiceIds].sort();
    const before = previous.providers.find(item => item.providerKey === row.providerKey);
    const unchanged = before && JSON.stringify(before.requestKeys) === JSON.stringify(requestKeys) && JSON.stringify(before.voiceIds) === JSON.stringify(voiceIds);
    return { providerKey: row.providerKey, requestKeys, voiceIds, completedAt: unchanged ? row.completedAt : null };
  }) };
  if (JSON.stringify(receipt) !== JSON.stringify(previous) || deletion.voiceErasure === null) {
    await tx.accountDeletion.update({ where: { id: deletion.id }, data: { voiceErasure: toInputJson(receipt), version: { increment: 1 } } });
  }
  return receipt;
}

/** External deletion is idempotent; each provider gets its own durable ACK. */
export async function eraseAccountVoiceStores(input: { db: PrismaClient; deletionId: string; subjectHash: string; receipt: VoiceErasureReceipt; now: Date; voice?: (key: VoiceProviderKey) => VoiceClipPort; signal?: AbortSignal }) {
  for (const row of input.receipt.providers) {
    if (input.signal?.aborted) return;
    if (row.completedAt) continue;
    let failure: unknown = null;
    try {
      const voice = (input.voice ?? createVoiceClipPortForKey)(row.providerKey);
      const result = voice.eraseAccount ? await voice.eraseAccount({ subjectHash: input.subjectHash, requestKeys: row.requestKeys, voiceIds: row.voiceIds }) : { ok: false as const, error: { code: "voice_erasure_unavailable", message: "Pinned voice provider has no erasure contract", retryable: true } };
      if (!result.ok) failure = result.error;
    } catch (error) { failure = { code: "voice_erasure_failed", message: error instanceof Error ? error.message : String(error), retryable: true }; }
    await input.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM account_deletions WHERE id = ${input.deletionId} FOR UPDATE`;
      const deletion = await tx.accountDeletion.findUniqueOrThrow({ where: { id: input.deletionId } });
      if (deletion.status === "completed" || !deletion.userId || !deletion.voiceErasure) return;
      const current = receiptSchema.parse(deletion.voiceErasure);
      const pending = current.providers.find(item => item.providerKey === row.providerKey);
      if (!pending || pending.completedAt || JSON.stringify(pending.requestKeys) !== JSON.stringify(row.requestKeys) || JSON.stringify(pending.voiceIds) !== JSON.stringify(row.voiceIds)) return;
      if (!failure) pending.completedAt = input.now.toISOString();
      await tx.accountDeletion.update({ where: { id: deletion.id }, data: {
        voiceErasure: toInputJson(current), lastError: failure ? toInputJson({ code: "account_deletion_voice_pending", providerKey: row.providerKey, cause: failure }) : Prisma.DbNull,
        version: { increment: 1 },
      } });
    });
  }
}

export function erasedVoiceReceipt(value: Prisma.JsonValue | null): Prisma.InputJsonValue {
  const receipt = value === null ? { version: 1 as const, providers: [] } : receiptSchema.parse(value);
  // Keep provider completion evidence; remove raw request/alias identifiers.
  return toInputJson({ ...receipt, providers: receipt.providers.map(row => ({ ...row, requestKeys: [], voiceIds: [] })) });
}
