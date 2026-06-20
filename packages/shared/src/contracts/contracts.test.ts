import { describe, expect, it } from "vitest";
import { idempotencyKeys } from "./idempotency";
import { ALL_QUEUE_NAMES, CHAT_QUEUES } from "./queues";
import { signBffContext, verifyBffContext } from "../bff/signing";

describe("idempotency keys", () => {
  it("chat.generate carries :attempt so regenerate is not deduped", () => {
    expect(idempotencyKeys.chatGenerate("m1", 1)).toBe("chat-generate:m1:1");
    expect(idempotencyKeys.chatGenerate("m1", 2)).toBe("chat-generate:m1:2");
    expect(idempotencyKeys.chatGenerate("m1", 1)).not.toBe(idempotencyKeys.chatGenerate("m1", 2));
  });
  it("generation-finalize keys on terminal state", () => {
    expect(idempotencyKeys.generationFinalize("j1", "completed")).toBe("generation-finalize:j1:completed");
    expect(idempotencyKeys.generationFinalize("j1", "failed")).toBe("generation-finalize:j1:failed");
  });
});

describe("queue names", () => {
  it("are unique and include the chat generate queue", () => {
    expect(new Set(ALL_QUEUE_NAMES).size).toBe(ALL_QUEUE_NAMES.length);
    expect(ALL_QUEUE_NAMES).toContain(CHAT_QUEUES.generate);
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
