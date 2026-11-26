// Turn media facts: revision rebind, privacy redaction and delayed-media refunds.
import type { RecoveredMediaAction } from "@idream/shared/contracts";
import { recoveredMediaActionSchema } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { updateGenerationRequestSourceMeta } from "@/server/ai/generation-request-transition";
import { attachmentAttempt, lockChatScope } from "./turn-scope";
import { legacyTurnActionAttachmentId, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { isReadableChatMedia, readableDeliveredChatMediaWhere } from "./chat-media-history";
import { lockCharacterGenerationAuthority, lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { attachmentCost, jsonRecord, sha256, toJson } from "./turn-ledger-support";

/** Rebind existing product facts before the new immutable execution snapshot. */
export async function rebindDurableTurnMedia(
  tx: Prisma.TransactionClient,
  userId: string,
  turn: { id: string; attempt: number; userContent: string },
  previousAttempt: number,
): Promise<RecoveredMediaAction | undefined> {
  const contentDigest = sha256(turn.userContent);
  const candidates = await tx.chatTurnAttachment.findMany({ where: { turnId: turn.id, kind: { in: ["generated_image", "generated_video"] } }, orderBy: { createdAt: "desc" } });
  for (const candidate of candidates) {
    if (attachmentAttempt(candidate.metadata) !== previousAttempt) continue;
    const scope = await lockChatScope(tx, { userId, at: { attachment: candidate.id }, expect: { attempt: turn.attempt } });
    const attachment = scope.attachment!;
    const metadata = jsonRecord(attachment.metadata);
    const effect = jsonRecord(metadata.effect ?? null);
    if (metadata.turnActionInvalidatedByEdit === true || effect.effectScope !== "turn_action") continue;
    if (attachment.status === "completed" && ["library", "previous_media"].includes(String(metadata.source))) {
      await lockCharacterGenerationAuthority(tx, scope.session.characterId);
      if (attachment.mediaAssetId) await lockMediaAssetAuthority(tx, attachment.mediaAssetId);
      const media = attachment.mediaAssetId ? await tx.mediaAsset.findFirst({ where: {
        id: attachment.mediaAssetId, ...readableDeliveredChatMediaWhere(userId, scope.session.characterId),
      } }) : null;
      if (!media || !isReadableChatMedia(media)) continue;
    }
    // A reservation failure with no Job is intentionally left to the Agent's
    // existing retry authority after a user tops up. It is not an executed action.
    const draft = jsonRecord(metadata.editDraft ?? null);
    const draftSource = draft.version === 1 && draft.userContentDigest === contentDigest && typeof draft.sourceSnapshotId === "string" && typeof draft.sourceMediaAssetId === "string"
      ? draft.sourceMediaAssetId : undefined;
    const job = attachment.generationJobId ? await tx.generationJob.findUnique({
      where: { id: attachment.generationJobId }, select: { sourceMeta: true, userId: true, mode: true },
    }) : null;
    if (jsonRecord(jsonRecord(job?.sourceMeta ?? null).privacyRedaction ?? null).reason === "logical_turn_edited") continue;
    let name: unknown = effect.name;
    if (name == null && attachment.kind === "generated_image") {
      // Old image receipts can predate effect.name. Recover only a persisted
      // action whose frozen request or former deterministic identity names it.
      const requestName = jsonRecord(metadata.request ?? null).name;
      name = (["generate_image_async", "edit_last_image"] as const).find(candidateName => requestName === candidateName || (
        requestName == null && [
          legacyTurnActionAttachmentId(turn.id, candidateName),
          legacyTurnActionAttachmentId(turn.id, candidateName, contentDigest),
        ].includes(attachment.id)
      ));
      if (!name) continue;
      if (attachment.status === "completed" && attachment.mediaAssetId) {
        const media = await tx.mediaAsset.findFirst({ where: {
          id: attachment.mediaAssetId, ...readableDeliveredChatMediaWhere(userId, scope.session.characterId), type: "image",
        }, select: { id: true } });
        if (!media) continue;
      } else if (job?.userId !== userId || job.mode !== "image") {
        continue;
      }
    }
    const parsed = recoveredMediaActionSchema.safeParse({
      name, attachmentId: attachment.id, status: attachment.status,
      costDreamcoins: attachmentCost(attachment.metadata) ?? 0,
      generationJobId: attachment.generationJobId, mediaAssetId: attachment.mediaAssetId,
      ...(draftSource ? { sourceMediaAssetId: draftSource } : {}),
      ...(attachment.promptHint ? { instruction: attachment.promptHint.slice(0, 1200) } : {}),
      ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
      ...(metadata.confirmationKind === "paid_media_quote" ? { confirmationKind: "paid_media_quote" } : {}),
    });
    if (!parsed.success) continue;
    await tx.chatTurnAttachment.update({ where: { id: attachment.id }, data: {
      metadata: toJson({ ...metadata, attempt: turn.attempt, effect: { ...effect, name: parsed.data.name, attempt: turn.attempt } }),
    } });
    return parsed.data;
  }
  return undefined;
}

/**
 * Atomically cancels and refunds any paid delayed curated-media attachment that
 * has not yet been revealed (`mediaAssetId IS NULL`) before its parent Turn or
 * Session is cascade-deleted. Callers must already hold `users FOR UPDATE`.
 */
export async function refundPendingDelayedAttachments(
  tx: Prisma.TransactionClient,
  userId: string,
  turnIds: readonly string[],
) {
  if (turnIds.length === 0) return;
  const candidates = await tx.chatTurnAttachment.findMany({
    where: {
      turnId: { in: [...turnIds] },
      status: "accepted",
      mediaAssetId: null,
      generationJobId: null,
      deliverAt: { not: null },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const { id } of candidates) {
    const scope = await lockChatScope(tx, {
      userId,
      at: { attachment: id },
      allowDeletedSession: true,
    });
    const current = scope.attachment!;
    if (current.status !== "accepted" || current.mediaAssetId !== null || current.generationJobId !== null) {
      continue;
    }
    const meta = current.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
      ? current.metadata as Record<string, unknown>
      : {};
    const costDreamcoins = typeof meta.costDreamcoins === "number" && Number.isSafeInteger(meta.costDreamcoins) && meta.costDreamcoins > 0
      ? meta.costDreamcoins
      : 0;
    await transitionToolEffectAttachment(tx, current, {
      to: "cancelled",
      errorCode: "deleted_before_delivery",
    });
    await tx.userCharacterLibraryReceipt.deleteMany({
      where: { userId, firstAttachmentId: current.id },
    });
    if (costDreamcoins > 0) {
      await postDreamcoinEntry(tx, {
        kind: "refund",
        userId,
        amount: costDreamcoins,
        sourceId: current.id,
        idempotencyKey: `chat_media_refund:${current.id}`,
      });
    }
  }
}

type ChatImagePrivacyRedactionReason =
  | "logical_turn_edited"
  | "logical_turn_deleted"
  | "session_deleted";

export async function redactChatImageSourceText(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    reason: ChatImagePrivacyRedactionReason;
    redactedAt: Date;
    sessionId?: string;
    exchangeIds?: readonly string[];
    messageIds?: readonly string[];
  },
) {
  const selectors: Prisma.GenerationJobWhereInput[] = [
    ...(input.sessionId
      ? [{ sourceMeta: { path: ["sessionId"], equals: input.sessionId } }]
      : []),
    ...[...new Set(input.exchangeIds ?? [])].map((exchangeId) => ({
      sourceMeta: { path: ["exchangeId"], equals: exchangeId },
    })),
    ...[...new Set(input.messageIds ?? [])].map((messageId) => ({
      sourceMeta: { path: ["messageId"], equals: messageId },
    })),
  ];
  if (selectors.length === 0) return;
  const jobs = await tx.generationJob.findMany({
    where: { userId: input.userId, sourceType: { in: ["chat_image", "chat_handoff", "chat_video"] }, OR: selectors },
    select: { id: true, sourceMeta: true },
  });
  for (const job of jobs) {
    await updateGenerationRequestSourceMeta(tx, {
      requestId: job.id,
      // MomentSpec also contains the Turn's private scene text. Remove that
      // projection with its source; generated media remains available.
      redactMomentSpec: true,
      sourceMeta: toJson({
        ...jsonRecord(job.sourceMeta),
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          authority: "main_turn_ledger",
          reason: input.reason,
          redactedAt: input.redactedAt.toISOString(),
        },
      }),
    });
  }
  // The attachment repeats the private prompt text (for Chat video, the user's
  // own motion request); it follows the same redaction as its source request.
  if (jobs.length > 0) {
    await tx.chatTurnAttachment.updateMany({
      where: { generationJobId: { in: jobs.map((job) => job.id) }, promptHint: { not: null } },
      data: { promptHint: null },
    });
  }
}
