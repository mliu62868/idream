import { describe, expect, it, vi } from "vitest";
import {
  chatStreamErrorDisposition,
  chatStreamLatestReplyFailed,
  chatStreamMessageIsInProgress,
  chatStreamMessageIsTerminal,
  chatStreamMessagesNeedReconciliation,
  chatStreamTerminalErrorMessage,
  reconcileChatStreamAuthority,
} from "./chat-stream-recovery";

describe("chat stream recovery", () => {
  it("keeps EventSource alive for transport loss and retryable provider errors", () => {
    expect(chatStreamErrorDisposition({})).toBe("reconnect");
    expect(
      chatStreamErrorDisposition({ code: "provider_failed", retryable: true }),
    ).toBe("reconnect");
  });

  it("closes only for an explicit non-retryable stream error", () => {
    expect(
      chatStreamErrorDisposition({ code: "blocked", retryable: false }),
    ).toBe("terminal");
    expect(
      chatStreamTerminalErrorMessage({ code: "provider_output_limit" }),
    ).toBe("Reply was cut short. Regenerate to try again.");
  });

  it("closes a recovered stream once session authority is terminal", () => {
    expect(
      chatStreamMessageIsTerminal({
        role: "assistant",
        status: "sent",
        content: "Recovered reply",
      }),
    ).toBe(true);
    expect(
      chatStreamMessageIsTerminal({
        role: "assistant",
        status: "generating",
        content: "",
      }),
    ).toBe(false);
  });

  it("keeps a stream open when a generating reply already has partial text", () => {
    const partial = {
      role: "assistant",
      status: "generating",
      content: "So, are we just going to stare at the ocean, or",
    };
    expect(chatStreamMessageIsTerminal(partial)).toBe(false);
    expect(chatStreamMessageIsInProgress(partial)).toBe(true);
    expect(chatStreamMessagesNeedReconciliation([partial])).toBe(true);
  });

  it("retries a transient canonical read and waits for terminal authority", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce({
        messages: [{ id: "assistant-1", role: "assistant", status: "generating", content: "Partial" }],
      })
      .mockResolvedValueOnce({
        messages: [{ id: "assistant-1", role: "assistant", status: "sent", content: "Canonical reply" }],
      });
    const apply = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileChatStreamAuthority({
      apply,
      assistantId: "assistant-1",
      messages: (session) => session.messages,
      read,
      wait,
    })).resolves.toBe("terminal_content");
    expect(read).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

describe("chatStreamLatestReplyFailed", () => {
  it("flags the current turn when its reply came back empty", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "failed" },
      ]),
    ).toBe(true);
  });

  it("does not keep flagging a healthy session because an older turn failed", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "failed" },
        { role: "user", content: "again" },
        { role: "assistant", content: "Here I am.", status: "sent" },
      ]),
    ).toBe(false);
  });

  it("stays quiet while the reply is still generating", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "generating" },
      ]),
    ).toBe(false);
  });

  it("does not report an intentionally cancelled reply as a failure", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "cancelled" },
      ]),
    ).toBe(false);
  });
});
