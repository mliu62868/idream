// SPEC: Inbox (main → chat). HTTP ingest persists this receipt before ACK;
// the receiver-local queue and reconciler only wake application of the receipt.
// These are cache-invalidation / blocking / compensation; the AUTHORITY is still
// the read-only views (re-checked every turn). Consumers are idempotent on eventId.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { deleteAccount } from "./privacy.js";
import {
  durableEventEnvelopeSchema,
  durableEnvelopeHash,
  type DurableAck,
  type DurableEventEnvelope,
  MAIN_TO_CHAT_EVENTS,
  chatImageAcceptedPayloadSchema,
  chatImageCompletedPayloadSchema,
  chatImageFailedPayloadSchema,
  chatSessionReleaseMigrationRequestedPayloadSchema,
} from "@idream/shared/contracts";

export interface InboundEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sourceService?: string;
  schemaVersion?: number;
  occurredAt?: string;
  aggregateType?: string;
  aggregateId?: string;
}

export async function persistInboundEvent(
  rawEvent: unknown,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<DurableAck> {
  const event = durableEventEnvelopeSchema.parse(rawEvent);
  const payloadHash = durableEnvelopeHash(event);
  const existing = await prisma.chatInboxEvent.findUnique({
    where: {
      sourceService_sourceEventId: {
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
      },
    },
  });
  if (existing) {
    // INVARIANT: a hash conflict is sticky until explicit reconciliation.
    // A later replay of the originally accepted payload must not let either
    // sender interpret a quarantined identity as durably accepted again.
    if (existing.status === "quarantined") {
      return { acknowledged: false, status: "quarantined", receiptId: existing.id };
    }
    if (existing.payloadHash === payloadHash) {
      return { acknowledged: true, status: "duplicate", receiptId: existing.id };
    }
    await prisma.chatInboxEvent.update({
      where: { id: existing.id },
      data: { status: "quarantined", processedAt: new Date(), attempts: { increment: 1 } },
    });
    return { acknowledged: false, status: "quarantined", receiptId: existing.id };
  }
  try {
    await prisma.chatInboxEvent.create({
      data: {
        id: receiptId(event.sourceService, event.sourceEventId),
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        payloadHash,
        eventType: event.eventType,
        payload: event.payload as never,
      },
    });
  } catch (error) {
    // Concurrent at-least-once deliveries can both observe no receipt. Let the
    // unique source key choose the winner, then classify the loser as an exact
    // replay or a payload conflict through the same public path.
    if (isUniqueConstraintError(error)) return persistInboundEvent(rawEvent, prisma);
    throw error;
  }
  return { acknowledged: true, status: "persisted", receiptId: receiptId(event.sourceService, event.sourceEventId) };
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function receiptId(sourceService: string, sourceEventId: string): string {
  return `${sourceService}:${sourceEventId}`;
}

/**
 * Consume one inbound event. Idempotent: the inbox row keyed by eventId is the
 * dedupe gate — if already consumed, no-op.
 */
export async function consumeInbound(
  event: InboundEvent,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ applied: boolean }> {
  const sourceService = event.sourceService ?? "main";
  const ack = await persistInboundEvent({
    sourceService,
    sourceEventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion ?? 1,
    occurredAt: event.occurredAt ?? "1970-01-01T00:00:00.000Z",
    aggregateType: event.aggregateType ?? "chat_effect",
    aggregateId: event.aggregateId ?? event.eventId,
    payload: event.payload,
  }, prisma);
  if (!ack.acknowledged || !ack.receiptId) {
    throw new Error(`inbound event ${sourceService}:${event.eventId} is quarantined`);
  }
  return consumeDurableInbox(ack.receiptId, prisma);
}

export async function consumeDurableInbox(
  id: string,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ applied: boolean }> {

  const claimStartedAt = new Date();
  const staleBefore = new Date(claimStartedAt.getTime() - 5 * 60_000);
  const claim = await prisma.chatInboxEvent.updateMany({
    where: {
      id,
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "processing", processedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "processing", processedAt: claimStartedAt },
  });
  if (claim.count === 0) return { applied: false };

  const claimed = await prisma.chatInboxEvent.findUniqueOrThrow({ where: { id } });
  const eventToApply: InboundEvent = {
    eventId: claimed.sourceEventId,
    sourceService: claimed.sourceService,
    eventType: claimed.eventType,
    payload: (claimed.payload ?? {}) as Record<string, unknown>,
  };

  try {
    await applyEffect(eventToApply, prisma);
    await prisma.chatInboxEvent.updateMany({
      where: { id, status: "processing", processedAt: claimStartedAt },
      data: { status: "consumed", processedAt: new Date(), consumedAt: new Date() },
    });
    return { applied: true };
  } catch (error) {
    await prisma.chatInboxEvent.updateMany({
      where: { id, status: "processing", processedAt: claimStartedAt },
      data: { status: "failed", attempts: { increment: 1 } },
    });
    throw error;
  }
}

async function applyEffect(event: InboundEvent, prisma: ChatPrismaClient): Promise<void> {
  switch (event.eventType) {
    case MAIN_TO_CHAT_EVENTS.userSuspended: {
      // Reversible: stop active sessions. New messages were already blocked by the
      // eligibility view; this just reflects suspension in chat state.
      const userId = String(event.payload.userId ?? "");
      if (userId) {
        await prisma.chatSession.updateMany({
          where: { userId, status: "active" },
          data: { status: "archived" },
        });
      }
      return;
    }
    case MAIN_TO_CHAT_EVENTS.userDeleted: {
      // Account deletion: erase the chat domain (PG rows + sessions/{u}/ + mem/{u}/)
      // and emit chat.account_erasure.completed (design P0-F). deleteAccount is
      // idempotent, so a redelivered user.deleted is safe.
      const userId = String(event.payload.userId ?? "");
      if (userId) await deleteAccount({ userId }, prisma);
      return;
    }
    case MAIN_TO_CHAT_EVENTS.characterRemoved: {
      const characterId = String(event.payload.characterId ?? "");
      if (characterId) {
        await prisma.chatSession.updateMany({
          where: { characterId, status: "active" },
          data: { status: "archived" },
        });
      }
      return;
    }
    case MAIN_TO_CHAT_EVENTS.chatImageAccepted: {
      const payload = chatImageAcceptedPayloadSchema.parse(event.payload);
      await prisma.messageAttachment.updateMany({
        where: {
          id: payload.attachmentId,
          status: { in: ["requesting", "proposed", "failed", "refunded"] },
        },
        data: {
          status: "queued",
          generationJobId: payload.generationJobId,
          costDreamcoins: payload.costDreamcoins,
          errorCode: null,
        },
      });
      return;
    }
    case MAIN_TO_CHAT_EVENTS.chatImageCompleted: {
      const payload = chatImageCompletedPayloadSchema.parse(event.payload);
      const attachment = await prisma.messageAttachment.findUnique({
        where: { id: payload.attachmentId },
        select: { metadata: true },
      });
      const metadata = (attachment?.metadata ?? {}) as Record<string, unknown>;
      await prisma.messageAttachment.updateMany({
        where: { id: payload.attachmentId, status: { notIn: ["completed", "canceled"] } },
        data: {
          status: "completed",
          generationJobId: payload.generationJobId,
          mediaAssetId: payload.mediaAssetId,
          width: payload.width ?? null,
          height: payload.height ?? null,
          errorCode: null,
          // P4 Task 5: agent's recollection of "what photo it sent" (generate.ts
          // buildModelMessages reads this back for the photo-awareness context line).
          ...(payload.summary ? { metadata: { ...metadata, summary: payload.summary } } : {}),
        },
      });
      return;
    }
    case MAIN_TO_CHAT_EVENTS.chatImageFailed: {
      const payload = chatImageFailedPayloadSchema.parse(event.payload);
      await prisma.messageAttachment.updateMany({
        where: { id: payload.attachmentId, status: { notIn: ["completed", "canceled"] } },
        data: {
          status: payload.status,
          generationJobId: payload.generationJobId ?? undefined,
          errorCode: payload.errorCode ?? null,
        },
      });
      return;
    }
    case MAIN_TO_CHAT_EVENTS.sessionReleaseMigrationRequested: {
      const payload = chatSessionReleaseMigrationRequestedPayloadSchema.parse(event.payload);
      const existingMigration = await prisma.chatSessionReleaseMigration.findUnique({
        where: { commandId: payload.commandId },
      });
      if (existingMigration) {
        if (
          existingMigration.sessionId !== payload.sessionId ||
          existingMigration.toCharacterContentVersionId !== payload.toCharacterContentVersionId ||
          existingMigration.toCharacterReleaseId !== payload.toCharacterReleaseId
        ) {
          throw new Error("session release migration command payload changed on redelivery");
        }
        return;
      }
      const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
      if (!session || session.characterId !== payload.characterId) {
        throw new Error("session release migration target does not exist");
      }
      if (
        session.characterContentVersionId !== payload.fromCharacterContentVersionId ||
        session.characterReleaseId !== payload.fromCharacterReleaseId
      ) {
        throw new Error("session release migration source pin is stale");
      }
      const content = await prisma.chatCharacterContentVersionView.findUnique({
        where: { contentVersionId: payload.toCharacterContentVersionId },
      });
      if (!content || content.characterId !== payload.characterId) {
        throw new Error("session release migration content version is invalid");
      }
      if (payload.toCharacterReleaseId) {
        const release = await prisma.chatCharacterReleaseView.findUnique({
          where: { releaseId: payload.toCharacterReleaseId },
        });
        if (
          !release ||
          release.characterId !== payload.characterId ||
          release.characterContentVersionId !== payload.toCharacterContentVersionId
        ) {
          throw new Error("session release migration Release does not match immutable content");
        }
      }
      await prisma.chatSessionReleaseMigration.create({
        data: {
          id: event.eventId,
          commandId: payload.commandId,
          sessionId: payload.sessionId,
          characterId: payload.characterId,
          fromCharacterContentVersionId: payload.fromCharacterContentVersionId,
          fromCharacterReleaseId: payload.fromCharacterReleaseId,
          toCharacterContentVersionId: payload.toCharacterContentVersionId,
          toCharacterReleaseId: payload.toCharacterReleaseId,
          reason: payload.reason,
          compatibilityQa: payload.compatibilityQa as never,
          requestedById: payload.requestedById,
        },
      });
      return;
    }
    // entitlement/policy/visibility/age updates: views are authority, nothing to
    // persist on the chat side — recording the event (above) is the audit trail.
    default:
      return;
  }
}

/** Re-process inbox rows stuck in pending/failed (reconciler). */
export async function reprocessPendingInbox(
  prisma: ChatPrismaClient = chatPrisma,
  batch = 100,
): Promise<number> {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const pending = await prisma.chatInboxEvent.findMany({
    where: {
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "processing", processedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: batch,
  });
  let applied = 0;
  for (const row of pending) {
    try {
      const result = await consumeDurableInbox(row.id, prisma);
      if (result.applied) applied += 1;
    } catch {
      // consumeInbound records the failed attempt while retaining the event.
    }
  }
  return applied;
}
