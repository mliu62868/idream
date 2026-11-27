import { describe, expect, it } from "vitest";
import type { RuntimeChatMessage as ChatMessage } from "@/lib/public-api-contracts";
import {
  chatSessionPageFromPayload,
  COMPLETE_CHAT_SESSION_PAGE,
  effectiveChatSessionPage,
  mergeChatSessionSnapshot,
  parseChatSessionPage,
  prependEarlierMessages,
} from "./chat-session-page";
import { chatReconcilePollDelay } from "./useChatSessionSync";

const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "user", content: id, ...extra });

describe("chat session pages", () => {
  it("treats a read without page metadata as the complete conversation", () => {
    expect(parseChatSessionPage(undefined)).toEqual(COMPLETE_CHAT_SESSION_PAGE);
    expect(parseChatSessionPage({ hasEarlier: true })).toEqual({ hasEarlier: false, earliestTurnId: null });
    expect(parseChatSessionPage({ hasEarlier: true, earliestTurnId: "turn-5" })).toEqual({ hasEarlier: true, earliestTurnId: "turn-5" });
  });

  it("reads page metadata beside or inside the session", () => {
    const page = { hasEarlier: true, earliestTurnId: "turn-9" };
    expect(chatSessionPageFromPayload({ ok: true, data: { session: {}, page } })).toEqual(page);
    expect(chatSessionPageFromPayload({ ok: true, data: { session: { page } } })).toEqual(page);
    expect(chatSessionPageFromPayload(null)).toEqual(COMPLETE_CHAT_SESSION_PAGE);
  });

  it("keeps earlier messages above a partial latest page", () => {
    const current = [message("a"), message("b"), message("c"), message("d")];
    const merged = mergeChatSessionSnapshot(current, [message("c"), message("d"), message("e")], { hasEarlier: true, earliestTurnId: "turn-c" });
    expect(merged.map(({ id }) => id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("drops messages a complete snapshot no longer lists", () => {
    const current = [message("a"), message("b"), message("c")];
    expect(mergeChatSessionSnapshot(current, [message("b"), message("c")], COMPLETE_CHAT_SESSION_PAGE).map(({ id }) => id))
      .toEqual(["b", "c"]);
  });

  it("keeps an optimistic turn until the snapshot carries its request key", () => {
    const local = message("local:1", { requestKey: "key-1" });
    const placeholder = message("local:1:reply", { role: "assistant", status: "pending", requestKey: "key-1" });
    const current = [message("a"), local, placeholder];
    expect(mergeChatSessionSnapshot(current, [message("a")], COMPLETE_CHAT_SESSION_PAGE).map(({ id }) => id))
      .toEqual(["a", "local:1", "local:1:reply"]);
    expect(mergeChatSessionSnapshot(current, [message("a"), message("b", { requestKey: "key-1" })], COMPLETE_CHAT_SESSION_PAGE).map(({ id }) => id))
      .toEqual(["a", "b"]);
  });

  it("prepends an older page without duplicating ids", () => {
    expect(prependEarlierMessages([message("c"), message("d")], [message("a"), message("b"), message("c")]).map(({ id }) => id))
      .toEqual(["a", "b", "c", "d"]);
  });
});

describe("chat reconciliation poll", () => {
  it("only heartbeats while the generating reply's stream is live", () => {
    expect(chatReconcilePollDelay({ streamHealthy: true, failureCount: 0 })).toBe(10_000);
    expect(chatReconcilePollDelay({ streamHealthy: false, failureCount: 0 })).toBe(1_500);
    expect(chatReconcilePollDelay({ streamHealthy: false, failureCount: 2 })).toBe(6_000);
    expect(chatReconcilePollDelay({ streamHealthy: true, failureCount: 1 })).toBe(3_000);
    expect(chatReconcilePollDelay({ streamHealthy: false, failureCount: 9 })).toBe(12_000);
  });
});

describe("effectiveChatSessionPage", () => {
  const latest = { hasEarlier: true, earliestTurnId: "turn-60" };
  const older = { hasEarlier: true, earliestTurnId: "turn-10" };
  it("continues from the older page while its Turn is still shown", () => {
    expect(effectiveChatSessionPage(latest, older, [{ turnId: "turn-10" }, { turnId: "turn-60" }])).toBe(older);
  });
  it("falls back to the latest page when the merge dropped the older messages", () => {
    // A latest page with no overlap replaced the transcript; the stale cursor would skip turns 11-59.
    expect(effectiveChatSessionPage(latest, older, [{ turnId: "turn-60" }, { turnId: "turn-61" }])).toBe(latest);
  });
  it("uses the complete latest page when nothing is earlier", () => {
    const complete = { hasEarlier: false, earliestTurnId: "turn-1" };
    expect(effectiveChatSessionPage(complete, older, [{ turnId: "turn-10" }])).toBe(complete);
  });
});
