import { describe, expect, it } from "vitest";
import { chatFailureCode, chatFailureCopy } from "./chat-failure-copy";

const FALLBACK = "Message failed to send. Please try again.";

describe("chatFailureCopy", () => {
  it("reads chat's own error envelope shape", () => {
    expect(chatFailureCode({ error: "rate_limited", message: "slow down" }))
      .toBe("rate_limited");
    // main 的信封是嵌套的，同一个读取器要能吃下两种
    expect(chatFailureCode({ error: { code: "forbidden" } })).toBe("forbidden");
    expect(chatFailureCode({ error: "" })).toBeNull();
    expect(chatFailureCode(null)).toBeNull();
  });

  it("stops telling the reader to retry when retrying cannot work", () => {
    for (const code of [
      "character_not_found",
      "character_unavailable",
      "user_inactive",
      "restricted",
      "message_not_editable",
      "session_not_found",
    ]) {
      const copy = chatFailureCopy({ error: code }, FALLBACK);
      expect(copy).not.toBe(FALLBACK);
      expect(copy.toLowerCase()).not.toContain("try again");
    }
  });

  it("keeps a wait-and-retry hint where waiting is the right move", () => {
    for (const code of ["rate_limited", "reply_in_progress", "service_not_ready"]) {
      expect(chatFailureCopy({ error: code }, FALLBACK).toLowerCase()).toMatch(/wait|moment|few seconds/);
    }
  });

  it("does not offer endless retries for Main-owned archived or missing chats", () => {
    expect(chatFailureCopy({ error: { code: "gone", message: "Chat session is archived" } }, FALLBACK))
      .toBe("This chat is no longer active. Start a new chat to continue.");
    expect(chatFailureCopy({ error: { code: "not_found", message: "Chat message not found" } }, FALLBACK))
      .toBe("This chat or message no longer exists. Reload your chats.");
  });

  it("falls back to the caller's sentence instead of leaking an internal code", () => {
    expect(chatFailureCopy({ error: "runtime_trace_invalid" }, FALLBACK)).toBe(FALLBACK);
    expect(chatFailureCopy({ error: "some_code_we_never_registered" }, FALLBACK)).toBe(FALLBACK);
    expect(chatFailureCopy({}, FALLBACK)).toBe(FALLBACK);
  });

  it("explains Main conflicts by their reason code, never by their message text", () => {
    expect(chatFailureCopy({ error: { code: "conflict", message: "anything", details: { reason: "reply_in_progress" } } }, FALLBACK))
      .toBe("Wait for the current reply to finish, then send again.");
    expect(chatFailureCode({ error: { code: "conflict", details: { reason: "voice_quote_stale" } } })).toBe("voice_quote_stale");
    expect(chatFailureCopy({ error: { code: "conflict", details: { reason: "edit_attempt_changed", blocker: "version_mismatch" } } }, FALLBACK))
      .toBe("This reply changed elsewhere. Reopen the editor to use the latest message.");
    expect(chatFailureCopy({ error: { code: "conflict", details: { blocker: "version_mismatch" } } }, FALLBACK))
      .toBe("This changed elsewhere. Reload and try again.");
    // The chat façade's flat envelope carries the same reasons.
    expect(chatFailureCopy({ error: "conflict", details: { reason: "chat_send_deleted" } }, FALLBACK))
      .toBe("That message was deleted. Send again to make a new request.");
    // Reader-sounding text without a reason is still not a contract.
    expect(chatFailureCopy({ error: { code: "conflict", message: "Cancel the active reply before deleting this chat" } }, FALLBACK)).toBe(FALLBACK);
    expect(chatFailureCopy({ error: { code: "conflict", message: "Terminal commit lost the active attempt CAS", details: { reason: "terminal_cas_lost" } } }, FALLBACK)).toBe(FALLBACK);
  });

  it("keeps a pending reply that Chat never started", () => {
    const copy = chatFailureCopy({ error: "admission_expired" }, FALLBACK);
    expect(copy).toContain("Your message is saved");
    expect(copy.toLowerCase()).toContain("regenerate");
  });
});
