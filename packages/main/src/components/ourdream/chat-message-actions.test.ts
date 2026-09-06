import { describe, expect, it } from "vitest";
import {
  canRegenerateChatMessage,
  canSubmitChatMessage,
  isImmutableOpeningMessage,
  isLocalChatMessageId,
} from "./chat-message-actions";

describe("chat message action authority", () => {
  it("recognizes the immutable opening from public reply linkage", () => {
    expect(isImmutableOpeningMessage({
      role: "assistant",
      replyToMessageId: null,
    })).toBe(true);

    expect(isImmutableOpeningMessage({
      role: "assistant",
      replyToMessageId: "user-1",
    })).toBe(false);
    expect(isImmutableOpeningMessage({
      role: "user",
      replyToMessageId: null,
    })).toBe(false);
  });

  it("hides commands that Chat authority will reject while a reply is active", () => {
    const reply = {
      role: "assistant",
      replyToMessageId: "user-1",
      status: "sent",
    };
    expect(canSubmitChatMessage("another turn", false, true)).toBe(false);
    expect(canSubmitChatMessage("another turn", false, false)).toBe(true);
    expect(canRegenerateChatMessage(reply, true)).toBe(false);
    expect(canRegenerateChatMessage(reply, false)).toBe(true);
    expect(canRegenerateChatMessage({ ...reply, status: "blocked" }, false)).toBe(false);
    expect(canRegenerateChatMessage({ ...reply, replyToMessageId: null }, false)).toBe(false);
  });

  it("separates optimistic turns from ids Chat can act on", () => {
    expect(isLocalChatMessageId("local:0f1e2d3c")).toBe(true);
    expect(isLocalChatMessageId("cmsg_0f1e2d3c")).toBe(false);
  });
});
