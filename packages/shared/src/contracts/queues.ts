// SPEC: Canonical BullMQ queue names, shared by every service (SSoT).
// INTENT: One place to name queues so producer/consumer never drift across the
// physical split. Grouped by owning service.
// INVARIANTS: A queue name is a stable wire identifier — renaming is a migration.

/** Generation workers (gen/image, gen/video) — payload self-contained, no DB authority. */
export const GEN_QUEUES = {
  imageGenerate: "ai.image.generate",
  videoGenerate: "ai.video.generate",
} as const;

/** Main-side authority write-back (gen-finalizer, main-event-consumer). */
export const MAIN_QUEUES = {
  /** gen/* → gen-finalizer: settle assets + dreamcoins + output moderation. */
  aiFinalize: "app.ai.finalize",
  /** chat outbox → main-event-consumer (chat → main events). */
  mainInbound: "main.inbound",
} as const;

/** Chat service internal queues (chat/web → chat/worker, and chat maintenance). */
export const CHAT_QUEUES = {
  /** chat/web enqueues; chat/worker consumes — produce the assistant reply. */
  generate: "chat.generate",
  /** Derive long-term memory/relationship from session.jsonl (async, off hot path). */
  memoryExtract: "chat.memory.extract",
  /** Deliver chat.chat_outbox_events → main.inbound (transactional outbox). */
  outboxDeliver: "chat.outbox.deliver",
  /** Consume main → chat commands from chat.chat_inbox_events. */
  inboxConsume: "chat.inbox.consume",
  /** Periodic: scan stuck `generating` + pending outbox/inbox; converge. */
  reconcile: "chat.reconcile",
  /** Periodic: session.jsonl rolling/compaction/TTL + expired Redis streams. */
  maintain: "chat.maintain",
} as const;

/** main → chat command queue (main outbox → chat inbox). */
export const MAIN_TO_CHAT_QUEUE = "chat.inbound" as const;

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
  MAIN_TO_CHAT_QUEUE,
  ...Object.values(LEGACY_QUEUES),
] as const;

export type QueueName = (typeof ALL_QUEUE_NAMES)[number];
