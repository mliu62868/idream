// SPEC: Idempotency / dedupe key builders (PLAN §3). Every cross-boundary effect
// carries a stable key so at-least-once delivery collapses to exactly-once.
// INTENT: Builders, not bare strings — the format lives here once, both sides import.
// INVARIANTS:
//   chat.generate carries :attempt so regenerate is NOT swallowed by dedupe.
//   outbox/inbox key on eventId; finalize keys on terminal state.
// EXAMPLE: chatGenerateKey("m_123", 2) → "chat-generate:m_123:2"

export const idempotencyKeys = {
  chatGenerate: (assistantMessageId: string, attempt: number) =>
    `chat-generate:${assistantMessageId}:${attempt}`,
  chatOutbox: (eventId: string) => `chat-outbox:${eventId}`,
  chatInbox: (eventId: string) => `chat-inbox:${eventId}`,
  chatMemoryExtract: (assistantMessageId: string, attempt: number) =>
    `chat-memory-extract:${assistantMessageId}:${attempt}`,
  chatSessionAppend: (assistantMessageId: string, attempt: number) =>
    `chat-session-append:${assistantMessageId}:${attempt}`,
  generation: (jobId: string) => `generation:${jobId}`,
  generationFinalize: (jobId: string, state: "completed" | "failed" | "blocked") =>
    `generation-finalize:${jobId}:${state}`,
} as const;

export type IdempotencyKeyBuilder = typeof idempotencyKeys;
