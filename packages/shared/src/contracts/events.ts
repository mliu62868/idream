// SPEC: Cross-service event-type names (PRD §11, design §6). Two outboxes:
// chat→main and main→chat. Consumers are idempotent on eventId.
// INTENT: Name SSoT so producer/consumer never drift. Payload shapes in payloads.ts.
import { z } from "zod";

/** chat → main (Chat outbox, at-least-once). */
export const CHAT_TO_MAIN_EVENTS = {
  sessionCreated: "chat.session.created",
  messageCompleted: "chat.message.completed",
  exchangeCompletedV2: "chat.exchange.completed.v2",
  exchangeCorrectedV2: "chat.exchange.corrected.v2",
  messageBlocked: "chat.message.blocked",
  imageRequested: "chat.image.requested",
  sessionDeleted: "chat.session.deleted",
  memoryUpdated: "chat.memory.updated",
  relationshipUpdated: "chat.relationship.updated",
  usageIncremented: "chat.usage.incremented",
  safetyFlagged: "chat.safety.flagged",
  accountErasureCompleted: "chat.account_erasure.completed",
  // SPEC: This completion is request-bound and may only travel through the
  // dedicated synchronous capability route. Generic outbox dispatchers must
  // never select it during an application rollback.
  accountErasureCompletedV2: "chat.account_erasure.completed.v2",
  sessionReleaseMigrationApplied: "chat.session_release_migration.applied.v2",
} as const;

/** main → chat (Main outbox → chat inbox). Cache-invalidation / block / compensate. */
export const MAIN_TO_CHAT_EVENTS = {
  userSuspended: "user.suspended",
  userDeleted: "user.deleted",
  // SPEC: Account deletion uses a dedicated v2 transport route. An older Chat
  // binary must not persist-and-ignore this request through its generic inbox.
  accountDeletionRequestedV2: "user.account_deletion.requested.v2",
  characterUpdated: "character.updated",
  characterRemoved: "character.removed",
  characterModerationRestorationRequested:
    "character.moderation_restoration.requested.v1",
  characterVisibilityChanged: "character.visibility_changed",
  entitlementUpdated: "entitlement.updated",
  ageEligibilityUpdated: "age_eligibility.updated",
  policyUpdated: "policy.updated",
  chatImageAccepted: "chat.image.accepted",
  chatImageCompleted: "chat.image.completed",
  chatImageFailed: "chat.image.failed",
  sessionReleaseMigrationRequested: "chat.session_release_migration.requested.v2",
} as const;

// INVARIANT: moderation removal/restoration identities are derived from the
// authority row that caused them, so retries cannot create a second causal set.
export function characterModerationRemovalEventId(
  moderationDecisionId: string,
) {
  return `moderation_character_removed_${moderationDecisionId}`;
}

export function characterModerationRestorationEventId(appealId: string) {
  return `moderation_character_restoration_${appealId}`;
}

// INVARIANT: v2 account deletion is delivered only through this capability
// route, so a rolled-back Chat binary returns 404 instead of ACKing a no-op.
export const ACCOUNT_DELETION_V2_INGEST_PATH =
  "/internal/events/account-deletion-v2/ingest";

// INVARIANT: Main applies this completion synchronously before Chat ACKs the
// matching request. An older Main binary has no such route and therefore
// cannot durably ACK-and-ignore the terminal deletion evidence.
export const ACCOUNT_ERASURE_COMPLETION_V2_INGEST_PATH =
  "/api/internal/events/account-erasure-completion-v2/ingest";

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
