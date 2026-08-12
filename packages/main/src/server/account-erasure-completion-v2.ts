import { z } from "zod";
import {
  CHAT_TO_MAIN_EVENTS,
  chatAccountErasureCompletedV2PayloadSchema,
  durableAckSchema,
  durableEventEnvelopeSchema,
  type DurableAck,
} from "@idream/shared/contracts";
import {
  ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
  applyChatEvent,
} from "@/processes/event-consumer";

export const accountErasureCompletionV2EnvelopeSchema =
  durableEventEnvelopeSchema.extend({
    sourceService: z.literal("chat"),
    eventType: z.literal(CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2),
    schemaVersion: z.literal(2),
    aggregateType: z.literal("user"),
    payload: chatAccountErasureCompletedV2PayloadSchema,
  }).superRefine((event, context) => {
    if (event.aggregateId !== event.payload.userId) {
      context.addIssue({
        code: "custom",
        path: ["aggregateId"],
        message: "aggregateId must match the account erasure payload userId",
      });
    }
  });

type ApplyCompletion = (
  event: Parameters<typeof applyChatEvent>[0],
) => ReturnType<typeof applyChatEvent>;

/**
 * Strict synchronous ingress for request-bound Chat account erasure evidence.
 * The dedicated source namespace cannot collide with an older generic no-op
 * receipt, so a forward deploy can apply the same source event correctly.
 */
export async function ingestAccountErasureCompletionV2(
  raw: unknown,
  apply: ApplyCompletion = applyChatEvent,
): Promise<DurableAck> {
  const event = accountErasureCompletionV2EnvelopeSchema.parse(raw);
  const result = await apply({
    eventId: event.sourceEventId,
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    // This is an internal receipt namespace, not a wire identity. The schema
    // above first proved that the authenticated sender named itself `chat`.
    sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
  });
  if (result.status === "quarantined") {
    return durableAckSchema.parse({
      acknowledged: false,
      status: "quarantined",
      receiptId: event.sourceEventId,
    });
  }
  return durableAckSchema.parse({
    acknowledged: true,
    status: result.status === "duplicate" ? "duplicate" : "persisted",
    receiptId: event.sourceEventId,
  });
}
