// SPEC: Inbox (main → chat, design §4/§6). main writes its outbox → main.outbox
// delivers to the `chat.inbound` queue → chat.inbox.consume records + applies.
// These are cache-invalidation / blocking / compensation; the AUTHORITY is still
// the read-only views (re-checked every turn). Consumers are idempotent on eventId.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

export interface InboundEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
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
    case MAIN_TO_CHAT_EVENTS.userSuspended:
    case MAIN_TO_CHAT_EVENTS.userDeleted: {
      // Stop active sessions for the user; new messages were already blocked by
      // the eligibility view, this just reflects it in chat state.
      const userId = String(event.payload.userId ?? "");
      if (userId) {
        await prisma.chatSession.updateMany({
          where: { userId, status: "active" },
          data: { status: "archived" },
        });
      }
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
