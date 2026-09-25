import { describe, expect, it } from "vitest";
import {
  canRegenerateChatMessage,
  canSubmitChatMessage,
  isImmutableOpeningMessage,
  isLocalChatMessageId,
  latestTurnUserMessageId,
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

  it("treats a proactive reply as the latest Turn, not the older user message", () => {
    const opening = { id: "opening:s", role: "assistant", replyToMessageId: null };
    const exchange = [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant", replyToMessageId: "user-1" },
    ];
    expect(latestTurnUserMessageId([opening, ...exchange])).toBe("user-1");
    // The proactive Turn's user side is hidden; its reply still names it.
    const proactive = { id: "assistant-2", role: "assistant", replyToMessageId: "hidden-directive" };
    expect(latestTurnUserMessageId([opening, ...exchange, proactive])).toBe("hidden-directive");
    // An optimistic send is the latest Turn before any reply exists.
    expect(latestTurnUserMessageId([...exchange, proactive, { id: "local:x", role: "user" }])).toBe("local:x");
    expect(latestTurnUserMessageId([opening])).toBeNull();
  });
});
