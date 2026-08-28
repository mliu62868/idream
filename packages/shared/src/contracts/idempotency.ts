// SPEC: Idempotency / dedupe key builders (PLAN §3). Every cross-boundary effect
// carries a stable key so at-least-once delivery collapses to exactly-once.
// INTENT: Builders, not bare strings — the format lives here once, both sides import.
// INVARIANTS:
//   ToolEffects key image generation on the Main-owned attachment; generation
//   attempts and terminal relays key on immutable Attempt identity.

export const idempotencyKeys = {
  chatImage: (attachmentId: string) => `chat-image:${attachmentId}`,
  generationAttempt: (jobId: string, attemptNo: number) =>
    `generation:${jobId}:attempt:${attemptNo}`,
  generationTerminalRelay: (attemptId: string) =>
    `generation-terminal-relay:${attemptId}`,
} as const;

export type IdempotencyKeyBuilder = typeof idempotencyKeys;
