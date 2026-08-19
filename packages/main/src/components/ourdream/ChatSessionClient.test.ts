import { describe, expect, it } from "vitest";
import {
  applyLocalStreamState,
  chatUpgradeLinkLabel,
  chatViewIsPinnedToBottom,
  voicePaymentRequiredReason,
} from "./ChatSessionClient";

const streamingReply = {
  id: "assistant-1",
  role: "assistant",
  content: "",
  status: "generating",
};

describe("chat upgrade reason", () => {
  it("keeps the upgrade action aligned with the blocked capability", () => {
    expect(chatUpgradeLinkLabel("messages")).toBe(
      "Upgrade for unlimited messages",
    );
    expect(chatUpgradeLinkLabel("voice")).toBe("Upgrade for voice access");
    expect(chatUpgradeLinkLabel("dreamcoins")).toBe("Get more dreamcoins");
  });

  it("distinguishes a missing voice plan from exhausted paid usage", () => {
    expect(
      voicePaymentRequiredReason({
        error: { details: { entitlement: "voice_enabled" } },
      }),
    ).toBe("not_entitled");
    expect(
      voicePaymentRequiredReason({
        error: { details: { cost: 12, required: 12 } },
      }),
    ).toBe("insufficient_balance");
  });
});

describe("local stream state over polled session rows", () => {
  it("keeps streamed text when the polled row is still empty", () => {
    const [reply] = applyLocalStreamState(
      [streamingReply],
      new Map([["assistant-1", { content: "Once upon", stopped: false }]]),
    );
    expect(reply?.content).toBe("Once upon");
    expect(reply?.status).toBe("generating");
  });

  it("yields to a terminal row, including a shorter moderated rewrite", () => {
    const finalized = {
      ...streamingReply,
      content: "Once upon a time.",
      status: "sent",
    };
    expect(
      applyLocalStreamState(
        [finalized],
        new Map([["assistant-1", { content: "Once upon", stopped: false }]]),
      )[0]?.content,
    ).toBe("Once upon a time.");

    const moderated = { ...streamingReply, content: "Blocked.", status: "blocked" };
    expect(
      applyLocalStreamState(
        [moderated],
        new Map([
          ["assistant-1", { content: "the raw streamed reply", stopped: false }],
        ]),
      )[0]?.content,
    ).toBe("Blocked.");
  });

  it("freezes a stopped reply at the text that arrived", () => {
    const [reply] = applyLocalStreamState(
      [streamingReply],
      new Map([["assistant-1", { content: "Once upon", stopped: true }]]),
    );
    expect(reply?.content).toBe("Once upon");
    expect(reply?.status).toBe("stopped");
  });

  it("leaves untracked messages untouched", () => {
    const messages = [streamingReply];
    expect(applyLocalStreamState(messages, new Map())).toBe(messages);
    expect(applyLocalStreamState(messages, new Map([["other", { content: "x", stopped: false }]]))[0])
      .toBe(streamingReply);
  });
});

describe("chat auto-scroll anchoring", () => {
  it("follows new tokens only while the reader is parked at the bottom", () => {
    const page = { innerHeight: 800, scrollHeight: 2_000 };
    expect(chatViewIsPinnedToBottom({ ...page, scrollY: 1_200 })).toBe(true);
    expect(chatViewIsPinnedToBottom({ ...page, scrollY: 1_100 })).toBe(true);
    expect(chatViewIsPinnedToBottom({ ...page, scrollY: 1_000 })).toBe(false);
    expect(chatViewIsPinnedToBottom({ ...page, scrollY: 0 })).toBe(false);
  });
});
