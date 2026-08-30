// SPEC: Chat has no product store. Durable Main→Chat events therefore carry
// only lifecycle intent for local execution state, never product Turns.
import { z } from "zod";

/** Chat local-file erasure → Main completion. */
export const CHAT_TO_MAIN_EVENTS = {
  // SPEC: This completion is request-bound and may only travel through the
  // dedicated synchronous capability route. Generic outbox dispatchers must
  // never select it during an application rollback.
  accountErasureCompletedV2: "chat.account_erasure.completed.v2",
} as const;

/** Main deletion request → Chat local files/DSH. */
export const MAIN_TO_CHAT_EVENTS = {
  // SPEC: Account deletion uses a dedicated v2 transport route. An older Chat
  // binary must not persist-and-ignore this request through its generic inbox.
  accountDeletionRequestedV2: "user.account_deletion.requested.v2",
  // User cancellation is authoritative in Main. Chat durably fences the exact
  // local attempt so restart recovery cannot execute work the user stopped.
  agentRunCancelRequestedV1: "chat.agent_run.cancel_requested.v1",
  // A destructive Turn/Session correction makes Main's remaining committed
  // transcript the only legal source for the relationship workspace.
  companionMemoryRebuildRequestedV1: "chat.companion_memory.rebuild_requested.v1",
  // Every accepted Main Turn advances the relationship memory projection.
  // This lag-tolerant event never blocks a new Chat Turn.
  companionMemoryProjectRequestedV1: "chat.companion_memory.project_requested.v1",
  // Clearing memory is a durable lifecycle command. Archiving product state
  // and physically purging the relationship workspace converge independently.
  companionMemoryPurgeRequestedV1: "chat.companion_memory.purge_requested.v1",
} as const;

/**
 * Migration-only vocabulary for pre-cutover outbox evidence. Admin repair and
 * launch readiness retain it until production cutover; the runtime dispatcher
 * must never select these events again.
 */
export const LEGACY_MAIN_TO_CHAT_EVENTS = {
  userSuspended: "user.suspended",
  userDeleted: "user.deleted",
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

// INVARIANT: v2 account deletion is delivered only through this capability
// route, so a rolled-back Chat binary returns 404 instead of ACKing a no-op.
export const ACCOUNT_DELETION_V2_INGEST_PATH =
  "/internal/events/account-deletion-v2/ingest";

export const COMPANION_MEMORY_PURGE_PATH =
  "/internal/companion-memory/purge";
export const COMPANION_MEMORY_REBUILD_PREPARE_PATH =
  "/internal/companion-memory/rebuild/prepare";
export const COMPANION_MEMORY_REBUILD_PROMOTE_PATH =
  "/internal/companion-memory/rebuild/promote";

// INVARIANT: Main applies this completion synchronously before Chat ACKs the
// matching request. An older Main binary has no such route and therefore
// cannot durably ACK-and-ignore the terminal deletion evidence.
export const ACCOUNT_ERASURE_COMPLETION_V2_INGEST_PATH =
  "/api/internal/events/account-erasure-completion-v2/ingest";

export const chatToMainEventType = z.enum(
  Object.values(CHAT_TO_MAIN_EVENTS) as [string, ...string[]],
);
export const mainToChatEventType = z.enum(
  [
    ...Object.values(MAIN_TO_CHAT_EVENTS),
    ...Object.values(LEGACY_MAIN_TO_CHAT_EVENTS),
  ] as [string, ...string[]],
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
export type MainToChatEvent =
  | (typeof MAIN_TO_CHAT_EVENTS)[keyof typeof MAIN_TO_CHAT_EVENTS]
  | (typeof LEGACY_MAIN_TO_CHAT_EVENTS)[keyof typeof LEGACY_MAIN_TO_CHAT_EVENTS];
