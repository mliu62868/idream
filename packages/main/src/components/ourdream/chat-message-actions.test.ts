import { describe, expect, it } from "vitest";
import { CHAT_SEND_PROTOCOL_VERSION } from "@idream/shared/contracts";
import {
  canRegenerateChatMessage,
  canSubmitChatMessage,
  isImmutableOpeningMessage,
  isLocalChatMessageId,
  latestTurnUserMessageId,
  prepareChatSendIntent,
} from "./chat-message-actions";

describe("chat message action authority", () => {
  it("keeps an unconfirmed current send's protocol and key while refusing to upgrade an old intent", () => {
    const draft = { sessionId: "session", content: "Generate one photo.", characterId: "character", allowPaidImage: true };
    const prepared = prepareChatSendIntent(null, draft, false);
    if (prepared.kind !== "ready") throw new Error("New send was refused");
    expect(prepared.intent.sendProtocolVersion).toBe(CHAT_SEND_PROTOCOL_VERSION);
    expect(prepareChatSendIntent(prepared.intent, draft, true)).toEqual(prepared);
    expect(prepareChatSendIntent({ ...prepared.intent, sendProtocolVersion: undefined }, draft, true)).toEqual({ kind: "protocol_expired" });
    expect(prepareChatSendIntent({ ...prepared.intent, sendProtocolVersion: "chat-send-1" }, draft, false)).toEqual({ kind: "protocol_expired" });
    const fresh = prepareChatSendIntent(null, draft, false);
    if (fresh.kind !== "ready") throw new Error("Explicit new send was refused");
    expect(fresh.intent.idempotencyKey).not.toBe(prepared.intent.idempotencyKey);
  });

  it("cannot change the paid option on an unconfirmed send but can create a different explicit draft", () => {
    const draft = { sessionId: "session", content: "One photo.", characterId: "character", allowPaidImage: false };
    const previous = prepareChatSendIntent(null, draft, false);
    if (previous.kind !== "ready") throw new Error("New send was refused");
    expect(prepareChatSendIntent(previous.intent, { ...draft, allowPaidImage: true }, true)).toEqual({ kind: "option_mismatch" });
    const fresh = prepareChatSendIntent(previous.intent, { ...draft, content: "A new request.", allowPaidImage: true }, true);
    expect(fresh.kind).toBe("ready");
    if (fresh.kind === "ready") expect(fresh.intent.idempotencyKey).not.toBe(previous.intent.idempotencyKey);
  });

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
