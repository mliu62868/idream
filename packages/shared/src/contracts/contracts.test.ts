import { describe, expect, it } from "vitest";
import { idempotencyKeys } from "./idempotency";
import {
  ALL_QUEUE_NAMES,
  MAIN_QUEUES,
  bullMqJobIdForDedupeKey,
} from "./queues";
import {
  generationDispatchRequestId,
  generationRunnerPromptId,
  generationProviderIdempotencyKey,
  generationProviderInvocationRef,
  generationTerminalFinalizeDedupeKey,
  generationTerminalRecordRef,
} from "./generation-identity";
import { signBffContext, verifyBffContext } from "../bff/signing";

describe("idempotency keys", () => {
  it("generation terminal relay keys on immutable Attempt identity", () => {
    expect(idempotencyKeys.generationTerminalRelay("attempt-1")).toBe(
      "generation-terminal-relay:attempt-1",
    );
  });
  it("generation source keys on immutable Attempt identity", () => {
    expect(idempotencyKeys.generationAttempt("job-1", 2)).toBe(
      "generation:job-1:attempt:2",
    );
  });
  it("chat image requests key on attachment id", () => {
    expect(idempotencyKeys.chatImage("att1")).toBe("chat-image:att1");
    expect(idempotencyKeys).not.toHaveProperty("chatSessionAppend");
  });
});

// INTENT: these formats are the contract between two separately deployed
// processes, so pin the exact bytes. A drift here does not fail to compile —
// it fails in production as unrecognized evidence or a lost dedupe collision.
describe("cross-service generation identity", () => {
  it("pins the provider invocation and dispatch identifiers", () => {
    expect(generationProviderIdempotencyKey("attempt-1")).toBe(
      "generation:attempt-1:provider",
    );
    expect(generationDispatchRequestId("attempt-1")).toBe(
      "generation_dispatch_attempt-1",
    );
  });

  // The expected values come from Python's uuid.uuid5, the same stack as ComfyUI's
  // validate_job_id. A retry derives these ids to find a crashed worker's prompt, so
  // a change here reports every in-flight prompt as gone and refunds it.
  it("derives the runner prompt id as a canonical RFC 4122 UUIDv5", () => {
    expect(generationRunnerPromptId("attempt-abc", 0)).toBe("8cb36a7b-6a8a-5379-beb3-aeb4aab3f063");
    expect(generationRunnerPromptId("attempt-abc", 1)).toBe("37b76a0c-5001-5181-a3b0-77fd28016c73");
    expect(generationRunnerPromptId("a".repeat(120), 3)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generationRunnerPromptId("attempt-abc", 0)).toBe(generationRunnerPromptId("attempt-abc", 0));
    expect(generationRunnerPromptId("attempt-abd", 0)).not.toBe(generationRunnerPromptId("attempt-abc", 0));
    expect(() => generationRunnerPromptId("attempt-abc", -1)).toThrow();
    expect(() => generationRunnerPromptId("", 0)).toThrow();
  });

  it("pins the terminal record storage layout Gen writes and Main reads", () => {
    expect(generationTerminalRecordRef("attempt-1")).toBe(
      "gen/terminal-records/attempt-1/terminal.json",
    );
    expect(generationProviderInvocationRef("attempt-1")).toBe(
      "gen/terminal-records/attempt-1/provider-invocation.json",
    );
  });

  it("pins the finalize dedupe key that is actually enqueued", () => {
    expect(generationTerminalFinalizeDedupeKey("attempt-1")).toBe(
      "generation-terminal-record-finalize:attempt-1",
    );
  });

  // INVARIANT: one implementation, both packages. Two copies that drift stop
  // colliding, and the same Attempt gets dispatched to the provider twice.
  it("derives a stable BullMQ job id so at-least-once enqueues collapse", () => {
    const key = generationTerminalFinalizeDedupeKey("attempt-1");
    expect(bullMqJobIdForDedupeKey(key)).toBe(
      `dedupe_${Buffer.from(key, "utf8").toString("base64url")}`,
    );
    expect(bullMqJobIdForDedupeKey(key)).toBe(bullMqJobIdForDedupeKey(key));
    expect(bullMqJobIdForDedupeKey("a/b+c")).not.toContain("/");
    expect(bullMqJobIdForDedupeKey("a/b+c")).not.toContain("+");
  });
});

describe("queue names", () => {
  it("are unique and include the cross-service terminal relay queue", () => {
    expect(new Set(ALL_QUEUE_NAMES).size).toBe(ALL_QUEUE_NAMES.length);
    expect(ALL_QUEUE_NAMES).toContain(MAIN_QUEUES.generationTerminalIngest);
  });
});

describe("BFF signing", () => {
  const secret = "s3cret-0123456789abcdef0123456789";
  const base = { secret, userId: "u1", method: "POST", path: "/api/v1/chat/sessions", body: '{"a":1}' };

  it("round-trips a valid signature", () => {
    const { signature, context } = signBffContext({ ...base, authTime: 1000 });
    const verdict = verifyBffContext({ ...base, signature, context, now: 1000 });
    expect(verdict.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { signature, context } = signBffContext({ ...base, authTime: 1000 });
    const verdict = verifyBffContext({ ...base, body: '{"a":2}', signature, context, now: 1000 });
    expect(verdict.ok).toBe(false);
  });

  it("rejects an expired signature", () => {
    const { signature, context } = signBffContext({ ...base, authTime: 1000 });
    const verdict = verifyBffContext({ ...base, signature, context, now: 1_000_000, ttlMs: 30_000 });
    expect(verdict).toEqual({ ok: false, reason: "expired" });
  });
});
