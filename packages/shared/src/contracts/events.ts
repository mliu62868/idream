// SPEC: Cross-service event-type names (PRD §11, design §6). Two outboxes:
// chat→main and main→chat. Consumers are idempotent on eventId.
// INTENT: Name SSoT so producer/consumer never drift. Payload shapes in payloads.ts.
import { z } from "zod";

/** chat → main (Chat outbox, at-least-once). */
export const CHAT_TO_MAIN_EVENTS = {
  sessionCreated: "chat.session.created",
  messageCompleted: "chat.message.completed",
  messageBlocked: "chat.message.blocked",
  sessionDeleted: "chat.session.deleted",
  memoryUpdated: "chat.memory.updated",
  relationshipUpdated: "chat.relationship.updated",
  usageIncremented: "chat.usage.incremented",
  safetyFlagged: "chat.safety.flagged",
  accountErasureCompleted: "chat.account_erasure.completed",
} as const;

/** main → chat (Main outbox → chat inbox). Cache-invalidation / block / compensate. */
export const MAIN_TO_CHAT_EVENTS = {
  userSuspended: "user.suspended",
  userDeleted: "user.deleted",
  characterUpdated: "character.updated",
  characterRemoved: "character.removed",
  characterVisibilityChanged: "character.visibility_changed",
  entitlementUpdated: "entitlement.updated",
  ageEligibilityUpdated: "age_eligibility.updated",
  policyUpdated: "policy.updated",
} as const;

export const chatToMainEventType = z.enum(
  Object.values(CHAT_TO_MAIN_EVENTS) as [string, ...string[]],
);
export const mainToChatEventType = z.enum(
  Object.values(MAIN_TO_CHAT_EVENTS) as [string, ...string[]],
);

/** Envelope every outbox row serializes to before delivery. */
export const eventEnvelopeSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  occurredAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type ChatToMainEvent = (typeof CHAT_TO_MAIN_EVENTS)[keyof typeof CHAT_TO_MAIN_EVENTS];
export type MainToChatEvent = (typeof MAIN_TO_CHAT_EVENTS)[keyof typeof MAIN_TO_CHAT_EVENTS];
