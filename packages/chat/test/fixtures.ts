import type { Pool } from "pg";
import { chatPrisma, type ChatPrismaClient } from "../src/db.js";
import { consumeDurableInbox, persistInboundEvent } from "../src/inbox.js";

/** Explicitly satisfy the product's age-gate precondition for chat integration fixtures. */
export async function acceptAgeGate(pool: Pool, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pool.query(
    `INSERT INTO public.age_gate_acceptances (id, "userId", "acceptedAt")
     SELECT 'age_test_' || md5(user_id), user_id, now()
     FROM unnest($1::text[]) AS user_id
     ON CONFLICT (id) DO NOTHING`,
    [userIds],
  );
}

/** Exactly what main's recordMainToChatEvent puts on the wire, minus its two constants. */
export interface MainToChatEnvelope {
  sourceEventId: string;
  eventType: string;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
}

/**
 * Deliver one main→chat event through the real ingest path: main POSTs a complete
 * durable envelope to /internal/events/ingest (persistInboundEvent), and the
 * receiver-local queue then wakes application (consumeDurableInbox).
 *
 * Tests must supply the WHOLE envelope rather than let a helper stub the fields
 * they don't care about. durableEnvelopeHash covers occurredAt, aggregateType and
 * aggregateId, and main redelivers its stored envelope byte-for-byte — so a
 * redelivery must reuse the same object here too. Stubbing those fields to
 * constants would make every replay hash-identical by construction and quietly
 * test the quarantine path against values no real sender can produce.
 */
export async function ingestMainEvent(
  envelope: MainToChatEnvelope,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ applied: boolean }> {
  const ack = await persistInboundEvent(
    { sourceService: "main", schemaVersion: 1, ...envelope },
    prisma,
  );
  if (!ack.acknowledged || !ack.receiptId) {
    throw new Error(
      `inbound event main:${envelope.sourceEventId} is ${ack.status}`,
    );
  }
  return consumeDurableInbox(ack.receiptId, prisma);
}

/**
 * The chat.image.* callbacks all reach chat via main's recordChatCallback, which
 * labels them aggregateType "chat_effect" with aggregateId = the event id. Named
 * here so the image tests state which emitter they are standing in for.
 */
export async function ingestChatImageCallback(
  sourceEventId: string,
  eventType: string,
  payload: Record<string, unknown>,
  prisma?: ChatPrismaClient,
): Promise<{ applied: boolean }> {
  return ingestMainEvent(
    {
      sourceEventId,
      eventType,
      occurredAt: new Date().toISOString(),
      aggregateType: "chat_effect",
      aggregateId: sourceEventId,
      payload,
    },
    prisma,
  );
}
