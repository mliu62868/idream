import { describe, expect, it } from "vitest";
import {
  canRegenerateChatMessage,
  canSubmitChatMessage,
  chatMessageActionPaddingClass,
  isImmutableOpeningMessage,
  isLocalChatMessageId,
} from "./chat-message-actions";

const openingTrace = {
  schemaVersion: 1,
  attempt: 1,
  messageKind: "opening",
  outputAuthority: "immutable_opening",
};

describe("chat message action authority", () => {
  it("recognizes only the exact immutable opening authority", () => {
    expect(isImmutableOpeningMessage({
      role: "assistant",
      replyToMessageId: null,
      runtimeTrace: openingTrace,
    })).toBe(true);

    expect(isImmutableOpeningMessage({
      role: "assistant",
      replyToMessageId: "user-1",
      runtimeTrace: openingTrace,
    })).toBe(false);
    expect(isImmutableOpeningMessage({
      role: "assistant",
      replyToMessageId: null,
      runtimeTrace: { ...openingTrace, outputAuthority: "model" },
    })).toBe(false);
    expect(isImmutableOpeningMessage({
      role: "assistant",
      replyToMessageId: null,
      runtimeTrace: null,
    })).toBe(false);
    expect(isImmutableOpeningMessage({
      role: "user",
      replyToMessageId: null,
      runtimeTrace: openingTrace,
    })).toBe(false);
  });

  it("reserves space for the exact visible action count and confirmation width", () => {
    expect(chatMessageActionPaddingClass(0, false)).toBe("pr-4");
    expect(chatMessageActionPaddingClass(2, false)).toBe("pr-[76px]");
    expect(chatMessageActionPaddingClass(3, false)).toBe("pr-[108px]");
    expect(chatMessageActionPaddingClass(4, false)).toBe("pr-[140px]");
    expect(chatMessageActionPaddingClass(2, true)).toBe("pr-[112px]");
    expect(chatMessageActionPaddingClass(3, true)).toBe("pr-[144px]");
    expect(chatMessageActionPaddingClass(4, true)).toBe("pr-[176px]");
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
