// SPEC: Inbox (main → chat, design §4/§6). main writes its outbox → main.outbox
// delivers to the `chat.inbound` queue → chat.inbox.consume records + applies.
// These are cache-invalidation / blocking / compensation; the AUTHORITY is still
// the read-only views (re-checked every turn). Consumers are idempotent on eventId.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { deleteAccount } from "./privacy.js";
import {
  durableEventEnvelopeSchema,
  type DurableEventEnvelope,
  MAIN_TO_CHAT_EVENTS,
  chatImageAcceptedPayloadSchema,
  chatImageCompletedPayloadSchema,
  chatImageFailedPayloadSchema,
  chatSessionReleaseMigrationRequestedPayloadSchema,
} from "@idream/shared/contracts";
import { createHash } from "node:crypto";

export interface InboundEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export async function persistInboundEvent(
  rawEvent: unknown,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ acknowledged: boolean; status: "persisted" | "duplicate" | "quarantined"; receiptId: string | null }> {
  const event = durableEventEnvelopeSchema.parse(rawEvent);
  const payloadHash = hashEvent(event);
  const existing = await prisma.chatInboxEvent.findUnique({ where: { id: event.sourceEventId } });
  if (existing) {
    const metadata = durableMetadata(existing.payload);
    if (metadata?.payloadHash === payloadHash) {
      return { acknowledged: true, status: "duplicate", receiptId: existing.id };
    }
    await prisma.chatInboxEvent.update({
      where: { id: existing.id },
      data: { status: "quarantined", attempts: { increment: 1 } },
    });
    return { acknowledged: false, status: "quarantined", receiptId: existing.id };
  }
  await prisma.chatInboxEvent.create({
    data: {
      id: event.sourceEventId,
      eventType: event.eventType,
      payload: {
        ...event.payload,
        __durable: {
          sourceService: event.sourceService,
          payloadHash,
          occurredAt: event.occurredAt,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
        },
      } as never,
    },
  });
  return { acknowledged: true, status: "persisted", receiptId: event.sourceEventId };
}

function hashEvent(event: DurableEventEnvelope): string {
  return createHash("sha256")
    .update(canonicalJson({
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function durableMetadata(payload: unknown): { payloadHash?: string } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const metadata = (payload as Record<string, unknown>).__durable;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as { payloadHash?: string }
    : null;
}

/**
 * Consume one inbound event. Idempotent: the inbox row keyed by eventId is the
 * dedupe gate — if already consumed, no-op.
 */
export async function consumeInbound(
  event: InboundEvent,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ applied: boolean }> {
  // Idempotency gate: insert pending row; if it exists & consumed, skip.
  const existing = await prisma.chatInboxEvent.findUnique({ where: { id: event.eventId } });
  if (existing?.status === "consumed") return { applied: false };
  if (!existing) {
    await prisma.chatInboxEvent.create({
      data: { id: event.eventId, eventType: event.eventType, payload: event.payload as never },
    });
  }

  try {
    await applyEffect(event, prisma);
    await prisma.chatInboxEvent.update({
      where: { id: event.eventId },
      data: { status: "consumed", consumedAt: new Date() },
    });
    return { applied: true };
  } catch (error) {
    await prisma.chatInboxEvent.update({
      where: { id: event.eventId },
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
  const pending = await prisma.chatInboxEvent.findMany({
    where: { status: { in: ["pending", "failed"] } },
    orderBy: { createdAt: "asc" },
    take: batch,
  });
  let applied = 0;
  for (const row of pending) {
    try {
      await applyEffect(
        { eventId: row.id, eventType: row.eventType, payload: (row.payload ?? {}) as Record<string, unknown> },
        prisma,
      );
      await prisma.chatInboxEvent.update({
        where: { id: row.id },
        data: { status: "consumed", consumedAt: new Date() },
      });
      applied += 1;
    } catch {
      await prisma.chatInboxEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    }
  }
  return applied;
}
