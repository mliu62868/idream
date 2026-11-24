import { createHash, randomInt } from "node:crypto";
import type { ChatTurnAttachment, Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA } from "@/server/lib/media-asset-authority";
import { generationCostFromAuthority, resolveGenerationPricingAuthority } from "@/server/lib/generation-pricing";
import {
  lockCharacterGenerationAuthorityShared,
  lockMediaAssetAuthorityShared,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { dreamcoinBalance, postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { assertLibraryEntryAvailable } from "@/server/modules/character-media-library/service";
import { mediaLibraryPosterViewUrl, mediaViewUrl } from "@/server/modules/ourdream/public-read-model";
import { assertToolEffectRequest, createToolEffectAttachment, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { assertChatSessionServingAuthority } from "./turn-ledger";
import { attachmentAttempt, lockChatScope } from "./turn-scope";

// Controlled server-side reveal windows: fast enough to delight (10x-30x faster
// than live GPU generation) while preserving authentic companion pacing.
export const CURATED_IMAGE_DELAY_RANGE_MS = [3_000, 6_000] as const;
export const CURATED_VIDEO_DELAY_RANGE_MS = [5_000, 12_000] as const;

export function computeCuratedMediaDeliverAt(
  kind: "image" | "video",
  now: Date = new Date(),
  overrideDelayMs?: number,
): Date {
  if (overrideDelayMs !== undefined) {
    return new Date(now.getTime() + Math.max(0, Math.floor(overrideDelayMs)));
  }
  const [minMs, maxMs] = kind === "video" ? CURATED_VIDEO_DELAY_RANGE_MS : CURATED_IMAGE_DELAY_RANGE_MS;
  const jitterMs = randomInt(minMs, maxMs + 1);
  return new Date(now.getTime() + jitterMs);
}

export type SchedulePaidCuratedMediaInput = {
  readonly userId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly attachmentId: string;
  readonly entryId: string;
  readonly kind: "image" | "video";
  readonly visualProfileId: string;
  readonly visualProfileVersion: number;
  readonly effectMetadata: Record<string, unknown>;
  readonly requestMetadata: Record<string, unknown>;
  readonly entryRevision?: number;
  readonly confirmedQuoteCost?: number;
  readonly now?: Date;
  readonly overrideDelayMs?: number;
};

// Only a change to the selected stock can authorize the image fallback.
export class CuratedMediaUnavailable extends AppError {
  constructor(message: string) { super("conflict", message); }
}

export type MediaFulfillmentReceipt = {
  readonly attachment: ChatTurnAttachment;
  readonly duplicate: boolean;
};

/**
 * Single atomic transaction for paid delayed curated-media fulfillment:
 * - Acquires per-user `lockChatScope` (exclusive) + shared Character/Library locks.
 * - Verifies official Character, active pricing rule (`image` = 5, `chat_curated_video` = 30),
 *   and explicit Dreamcoin balance inside `users FOR UPDATE`.
 * - Debits DreamCoins idempotently (`chat_media_spend:${attachmentId}`).
 * - Inserts lifetime deduplication receipt in `user_character_library_receipts`.
 * - Creates `ChatTurnAttachment(status="accepted", mediaAssetId=null, deliverAt)` so the
 *   real asset URL is physically non-existent until server clock reaches `deliverAt`.
 */
export async function schedulePaidCuratedMediaDelivery(
  input: SchedulePaidCuratedMediaInput,
): Promise<MediaFulfillmentReceipt> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, {
      userId: input.userId,
      at: input.confirmedQuoteCost === undefined ? { turn: input.turnId } : { attachment: input.attachmentId },
      expect: { attempt: input.attempt, ...(input.confirmedQuoteCost !== undefined ? { attachmentAttemptMatchesTurn: true } : {}) },
    });
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    const turn = scope.turn!;
    const existing = scope.attachment ?? await tx.chatTurnAttachment.findUnique({ where: { id: input.attachmentId } });
    if (existing) {
      if (existing.turnId !== turn.id || attachmentAttempt(existing.metadata) !== input.attempt ||
          existing.kind !== (input.kind === "video" ? "generated_video" : "generated_image")) {
        throw Errors.conflict("This Turn already has a different media action");
      }
      const existingMeta = record(existing.metadata);
      const digest = input.effectMetadata.requestDigest;
      if (typeof digest === "string") {
        assertToolEffectRequest(existing, String(input.effectMetadata.name), digest);
      }
      if (input.confirmedQuoteCost !== undefined) {
        const quote = record(existingMeta.paidMediaQuote);
        if (existingMeta.confirmationKind !== "paid_media_quote" || quote.matchedEntryId !== input.entryId ||
            quote.costDreamcoins !== input.confirmedQuoteCost ||
            (existing.status === "awaiting_confirmation" && paidCost(existing.metadata) !== input.confirmedQuoteCost)) {
          throw Errors.conflict("This Chat media action is no longer available");
        }
      }
      // A sibling request can have selected live generation or finished delivery.
      // Return the same locked action, including an unpaid requesting reservation.
      if (existing.status !== "awaiting_confirmation") return { attachment: existing, duplicate: true };
      if (input.confirmedQuoteCost === undefined) throw Errors.conflict("This Chat media action requires confirmation");
    } else if (input.confirmedQuoteCost !== undefined) {
      throw Errors.notFound("Media quote not found");
    }

    if (input.confirmedQuoteCost === undefined && !["pending", "generating"].includes(turn.assistantStatus)) {
      throw Errors.conflict("Media delivery does not belong to an active Chat attempt");
    }

    const characterId = scope.session.characterId;
    await lockCharacterGenerationAuthorityShared(tx, characterId);
    await assertChatSessionServingAuthority(tx, input.userId, scope.session);
    const character = await tx.character.findFirst({
      where: { id: characterId, deletedAt: null },
      select: { id: true, source: true, age: true, status: true },
    });
    if (!character || character.age < 18 || ["removed", "archived", "rejected"].includes(character.status)) {
      throw Errors.conflict("Character is not available for curated media delivery");
    }
    if (character.source !== "official") {
      throw Errors.forbidden("Curated pre-generated media delivery is only available for official Characters");
    }

    const source = await tx.characterMediaLibraryEntry.findUnique({
      where: { id: input.entryId }, select: { sourceAssetId: true },
    });
    if (source?.sourceAssetId) await lockMediaAssetAuthorityShared(tx, source.sourceAssetId);
    await tx.$queryRaw`SELECT id FROM "character_media_library_entries" WHERE id = ${input.entryId} FOR SHARE`;
    const entry = await tx.characterMediaLibraryEntry.findUnique({ where: { id: input.entryId } });
    if (
      !entry
      || entry.status !== "published"
      || entry.kind !== input.kind
      || entry.characterId !== characterId
      || entry.visualProfileId !== input.visualProfileId
      || entry.visualProfileVersion !== input.visualProfileVersion
      || entry.distributionScope !== "chat_library"
      || entry.sourceAssetId !== source?.sourceAssetId
      || (input.entryRevision !== undefined && entry.revision !== input.entryRevision)
      || turn.characterVisualProfileId !== input.visualProfileId
      || turn.characterVisualProfileVersion !== input.visualProfileVersion
    ) {
      throw new CuratedMediaUnavailable("Curated media entry is no longer published for this Character identity");
    }
    try {
      await assertLibraryEntryAvailable(tx, entry, { characterId, visualProfileId: input.visualProfileId, visualProfileVersion: input.visualProfileVersion });
    } catch (error) {
      if (error instanceof AppError && error.code === "conflict") throw new CuratedMediaUnavailable(error.message);
      throw error;
    }

    // Enforce lifetime non-repeating paid delivery (survives deleted chat history).
    const existingReceipt = await tx.userCharacterLibraryReceipt.findFirst({
      where: {
        userId: input.userId,
        characterId,
        OR: [
          { entryId: entry.id },
          { contentHash: entry.contentHash },
          ...(entry.nearDuplicateClusterId ? [{ nearDuplicateClusterId: entry.nearDuplicateClusterId }] : []),
        ],
      },
      select: { id: true },
    });
    if (existingReceipt) {
      throw new CuratedMediaUnavailable("This curated media asset has already been delivered to this user");
    }

    const mediaKind = entry.kind === "video" ? "video" : "image";
    const pricingMode = mediaKind === "video" ? "chat_curated_video" : "image";
    const pricing = await resolveGenerationPricingAuthority(pricingMode, tx);
    const costDreamcoins = generationCostFromAuthority(pricing, 1, 1);
    if (input.confirmedQuoteCost !== undefined && costDreamcoins !== input.confirmedQuoteCost) {
      throw Errors.conflict("The media price changed. Request a new quote before confirming.");
    }

    const balance = await dreamcoinBalance(input.userId, tx);
    if (balance < costDreamcoins) {
      throw Errors.paymentRequired("Insufficient DreamCoins balance", {
        balance,
        required: costDreamcoins,
      });
    }

    await postDreamcoinEntry(tx, {
      kind: "generation_spend",
      userId: input.userId,
      amount: costDreamcoins,
      sourceId: input.attachmentId,
      idempotencyKey: `chat_media_spend:${input.attachmentId}`,
    });

    await tx.userCharacterLibraryReceipt.create({
      data: {
        userId: input.userId,
        characterId,
        entryId: entry.id,
        contentHash: entry.contentHash,
        nearDuplicateClusterId: entry.nearDuplicateClusterId,
        photoSetId: entry.photoSetId,
        kind: mediaKind,
        firstAttachmentId: input.attachmentId,
        costDreamcoins,
      },
    });

    const deliverAt = computeCuratedMediaDeliverAt(mediaKind, now, input.overrideDelayMs);
    const attachmentKind = mediaKind === "video" ? "generated_video" : "generated_image";
    const metadata = {
      ...record(existing?.metadata),
      source: "library",
      paidCuratedDelivery: true,
      scheduledEntryId: entry.id,
      scheduledEntryRevision: entry.revision,
      pricingRuleId: pricing.id,
      pricingRuleVersion: pricing.version,
      costDreamcoins,
      effect: input.effectMetadata,
      request: input.requestMetadata,
    };
    const attachment = scope.attachment ?? await createToolEffectAttachment(tx, {
      id: input.attachmentId,
      turn,
      attempt: input.attempt,
      kind: attachmentKind,
      promptHint: null,
      metadata,
    });
    const scheduled = await transitionToolEffectAttachment(tx, attachment, {
      to: "accepted",
      generationJobId: null,
      mediaAssetId: null,
      deliverAt,
      metadata,
    });

    return { attachment: scheduled, duplicate: false };
  }, { timeout: 15_000 });
}

/**
 * Cancels an unrevealed (`status = 'accepted' AND mediaAssetId IS NULL`) paid
 * delayed curated attachment and issues an idempotent full refund. Once revealed
 * (`completed`), cancellation is rejected with 409 so a user can never view an
 * asset and refund it.
 */
export async function cancelPendingDelayedChatMedia(input: {
  readonly userId: string;
  readonly attachmentId: string;
  readonly reason?: string;
}): Promise<{ cancelled: true; refundedDreamcoins: number }> {
  return prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, {
      userId: input.userId,
      at: { attachment: input.attachmentId },
    });
    const current = scope.attachment!;
    if (current.status === "cancelled" || current.status === "refunded") {
      const cost = paidCost(current.metadata);
      return { cancelled: true, refundedDreamcoins: cost };
    }
    if (current.status !== "accepted" || current.mediaAssetId !== null || current.generationJobId !== null || !current.deliverAt) {
      throw Errors.conflict("This media delivery has already completed and can no longer be cancelled");
    }
    const cost = paidCost(current.metadata);
    await transitionToolEffectAttachment(tx, current, {
      to: "cancelled",
      errorCode: input.reason ?? "cancelled_before_delivery",
    });
    await tx.userCharacterLibraryReceipt.deleteMany({
      where: { userId: input.userId, firstAttachmentId: current.id },
    });
    if (cost > 0) {
      await postDreamcoinEntry(tx, {
        kind: "refund",
        userId: input.userId,
        amount: cost,
        sourceId: current.id,
        idempotencyKey: `chat_media_refund:${current.id}`,
      });
    }
    return { cancelled: true, refundedDreamcoins: cost };
  }, { timeout: 15_000 });
}

export type RevealDueDelayedChatMediaSummary = {
  readonly scanned: number;
  readonly revealed: number;
  readonly refunded: number;
  readonly skipped: number;
};

/**
 * Periodic sweeper executed inside `gen-finalizer` (1s lane). Reveals every
 * due delayed curated attachment (`deliverAt <= now`) with zero-byte blob I/O
 * and shared read locks. If the curated entry was withdrawn or removed during
 * the delay window, automatically transitions to `refunded` and returns full
 * DreamCoins idempotently.
 */
export async function revealDueDelayedChatMedia(
  limit = 10,
  now: Date = new Date(),
): Promise<RevealDueDelayedChatMediaSummary> {
  const due = await prisma.chatTurnAttachment.findMany({
    where: {
      status: "accepted",
      mediaAssetId: null,
      generationJobId: null,
      deliverAt: { lte: now },
    },
    select: {
      id: true,
      turn: { select: { session: { select: { userId: true } } } },
    },
    orderBy: [{ deliverAt: "asc" }, { id: "asc" }],
    take: limit,
  });

  let revealed = 0;
  let refunded = 0;
  let skipped = 0;

  for (const row of due) {
    try {
      const outcome = await revealSingleDelayedAttachment(row.turn.session.userId, row.id, now);
      if (outcome === "revealed") revealed += 1;
      else if (outcome === "refunded") refunded += 1;
      else skipped += 1;
    } catch (error) {
      logger.error({ err: error, attachmentId: row.id }, "delayed curated chat media reveal failed");
      skipped += 1;
    }
  }
  return { scanned: due.length, revealed, refunded, skipped };
}

async function revealSingleDelayedAttachment(
  userId: string,
  attachmentId: string,
  now: Date,
): Promise<"revealed" | "refunded" | "skipped"> {
  return prisma.$transaction(async (tx) => {
    const exists = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId }, select: { id: true } });
    if (!exists) return "skipped";

    const scope = await lockChatScope(tx, {
      userId,
      at: { attachment: attachmentId },
      allowDeletedSession: true,
    });
    const current = scope.attachment!;
    if (
      current.status !== "accepted"
      || current.mediaAssetId !== null
      || current.generationJobId !== null
      || !current.deliverAt
      || current.deliverAt > now
    ) {
      return "skipped";
    }

    const meta = record(current.metadata);
    const entryId = typeof meta.scheduledEntryId === "string" ? meta.scheduledEntryId : null;
    const costDreamcoins = paidCost(current.metadata);
    const characterId = scope.session.characterId;

    if (!entryId || scope.session.status !== "active") {
      await refundInLockedTx(tx, userId, current, costDreamcoins, !entryId ? "missing_scheduled_entry" : "session_inactive");
      return "refunded";
    }

    await lockCharacterGenerationAuthorityShared(tx, characterId);
    await tx.$queryRaw`SELECT id FROM "character_media_library_entries" WHERE id = ${entryId} FOR KEY SHARE`;
    const entry = await tx.characterMediaLibraryEntry.findUnique({ where: { id: entryId } });
    const character = await tx.character.findFirst({
      where: { id: characterId, deletedAt: null },
      select: { age: true, status: true },
    });

    if (
      !entry
      || entry.status !== "published"
      || entry.characterId !== characterId
      || entry.distributionScope !== "chat_library"
      || entry.revision !== meta.scheduledEntryRevision
      || entry.visualProfileId !== scope.turn!.characterVisualProfileId
      || entry.visualProfileVersion !== scope.turn!.characterVisualProfileVersion
      || (entry.kind === "video") !== (current.kind === "generated_video")
      || attachmentAttempt(current.metadata) !== scope.turn!.attempt
      || !character
      || character.age < 18
      || ["removed", "archived", "rejected"].includes(character.status)
    ) {
      await refundInLockedTx(tx, userId, current, costDreamcoins, "library_entry_withdrawn");
      return "refunded";
    }

    const sourceAssetId = entry.sourceAssetId ?? record(entry.sourceSnapshot).assetId;
    if (typeof sourceAssetId !== "string" || !sourceAssetId) {
      await refundInLockedTx(tx, userId, current, costDreamcoins, "missing_source_identity");
      return "refunded";
    }

    // Zero-byte blob I/O: library objects are immutable write-once copies
    // verified at ingestion and guarded by write-path takedown cascades.
    const mediaAssetId = `chatmedia_${hash(current.id).slice(0, 40)}`;
    const url = mediaViewUrl({ id: mediaAssetId, type: entry.kind, contentType: entry.contentType, storageKey: null, url: "" });
    const posterKey = entry.kind === "video" ? entry.thumbnailKey : null;
    await tx.mediaAsset.create({
      data: {
        id: mediaAssetId,
        ownerId: userId,
        characterId,
        type: entry.kind,
        url,
        thumbnailUrl: posterKey ? mediaLibraryPosterViewUrl({ id: mediaAssetId }) : entry.kind === "image" ? url : null,
        storageKey: null,
        contentType: entry.contentType,
        width: entry.width,
        height: entry.height,
        sourceJobId: null,
        prompt: null,
        visibility: "private",
        safetyStatus: "passed",
        metadata: toJson({
          source: "character_media_library",
          synthetic: false,
          sha256: entry.contentHash,
          blobLocator: {
            schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
            kind: "shared_immutable",
            key: entry.storageKey,
            sourceAssetId,
          },
          duplicateLineage: { schemaVersion: 1, sourceAssetId, sourceCharacterId: characterId },
          libraryDelivery: {
            schemaVersion: 1,
            entryId: entry.id,
            revision: entry.revision,
            contentHash: entry.contentHash,
            description: entry.description,
            facts: entry.facts,
            absentFacts: entry.absentFacts,
            nudity: entry.nudity,
            visualProfileId: entry.visualProfileId,
            visualProfileVersion: entry.visualProfileVersion,
            durationSeconds: entry.durationSeconds,
            hasAudio: entry.hasAudio,
            ...(posterKey ? { posterKey } : {}),
          },
        }),
      },
    });

    await transitionToolEffectAttachment(tx, current, {
      to: "completed",
      generationJobId: null,
      mediaAssetId,
      width: entry.width,
      height: entry.height,
      metadata: {
        ...meta,
        description: entry.description,
        revealedAt: now.toISOString(),
      },
    });
    await tx.characterMediaLibraryEntry.update({
      where: { id: entry.id },
      data: { paidDeliveryCount: { increment: 1 } },
    });
    return "revealed";
  }, { timeout: 15_000 });
}

async function refundInLockedTx(
  tx: Prisma.TransactionClient,
  userId: string,
  attachment: Parameters<typeof transitionToolEffectAttachment>[1],
  costDreamcoins: number,
  errorCode: string,
) {
  await transitionToolEffectAttachment(tx, attachment, {
    to: "refunded",
    errorCode,
  });
  await tx.userCharacterLibraryReceipt.deleteMany({
    where: { userId, firstAttachmentId: attachment.id },
  });
  if (costDreamcoins > 0) {
    await postDreamcoinEntry(tx, {
      kind: "refund",
      userId,
      amount: costDreamcoins,
      sourceId: attachment.id,
      idempotencyKey: `chat_media_refund:${attachment.id}`,
    });
  }
}

function paidCost(metadata: ChatTurnAttachment["metadata"]): number {
  const value = record(metadata).costDreamcoins;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
