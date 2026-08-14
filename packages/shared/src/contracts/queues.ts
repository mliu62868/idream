// SPEC: Canonical BullMQ queue names, shared by every service (SSoT).
// INTENT: One place to name queues so producer/consumer never drift across the
// physical split. Cross-service queues name their consumer-side authority.
// INVARIANTS: A queue name is a stable wire identifier — renaming is a migration.

/** Generation workers (gen/image, gen/video) — payload self-contained, no DB authority. */
export const GEN_QUEUES = {
  imageGenerate: "ai.image.generate",
  videoGenerate: "ai.video.generate",
} as const;

/** Main-side authority write-back (gen-finalizer, main-event-consumer). */
export const MAIN_QUEUES = {
  /** gen/* -> gen-finalizer: relay one immutable terminal record into Main. */
  generationTerminalIngest: "app.generation.terminal.ingest",
  /** gen/* → gen-finalizer: settle assets + dreamcoins + output moderation. */
  aiFinalize: "app.ai.finalize",
} as const;

// INVARIANT: queue pause/drain, cutover inspection, recovery receipts and their
// verifier cover this one exact set.
export const GENERATION_CUTOVER_QUEUES = [
  GEN_QUEUES.imageGenerate,
  GEN_QUEUES.videoGenerate,
  MAIN_QUEUES.generationTerminalIngest,
  MAIN_QUEUES.aiFinalize,
] as const;

/** Chat service internal queues (chat/web → chat/worker, and chat maintenance). */
export const CHAT_QUEUES = {
  /** chat/web enqueues; chat/worker consumes — produce the assistant reply. */
  generate: "chat.generate",
  /** Derive long-term memory/relationship from the exact authoritative PG turn. */
  memoryExtract: "chat.memory.extract",
  /** Deliver chat.chat_outbox_events through Main's HTTP durable ingest. */
  outboxDeliver: "chat.outbox.deliver",
  /** Consume main → chat commands from chat.chat_inbox_events. */
  inboxConsume: "chat.inbox.consume",
  /** Periodic: scan stuck `generating` + pending outbox/inbox; converge. */
  reconcile: "chat.reconcile",
  /** Periodic: session.jsonl rolling/compaction/TTL + expired Redis streams. */
  maintain: "chat.maintain",
} as const;

/**
 * Legacy in-monolith queue names. Retained so the single-process pipeline keeps
 * working during the strangler migration; new code should use the grouped maps.
 */
export const LEGACY_QUEUES = {
  chatGenerate: "ai.chat.generate",
  memorySync: "ai.memory.sync",
  memoryForget: "ai.memory.forget",
  memoryRebuild: "ai.memory.rebuild",
} as const;

export const ALL_QUEUE_NAMES = [
  ...Object.values(GEN_QUEUES),
  ...Object.values(MAIN_QUEUES),
  ...Object.values(CHAT_QUEUES),
  ...Object.values(LEGACY_QUEUES),
] as const;

export type QueueName = (typeof ALL_QUEUE_NAMES)[number];

// SPEC: derive the BullMQ job id that makes a dedupe key collide with itself.
// INTENT: BullMQ dedupes on job id, so this mapping is what turns at-least-once
// enqueues into one provider invocation. Main and Gen both enqueue onto the same
// queues, so they must derive the id identically — two copies that drift stop
// colliding and let the same Attempt be dispatched, and billed, twice.
// INVARIANT: base64url of the UTF-8 key — stable across processes and restarts.
export function bullMqJobIdForDedupeKey(dedupeKey: string): string {
  return `dedupe_${Buffer.from(dedupeKey, "utf8").toString("base64url")}`;
}
