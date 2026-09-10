// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentProps<"a">) =>
    createElement(
      "a",
      { href: typeof href === "string" ? href : String(href), ...props },
      children,
    ),
}));
vi.mock("./AgeGateBoundary", () => ({
  useAgeGateAccess: () => ({ accepted: true }),
}));
vi.mock("./AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./chat/ChatSessionListDrawer", () => ({
  ChatSessionListDrawer: () => null,
}));
vi.mock("./chat/MemoryPanel", () => ({ MemoryPanel: () => null }));

import { ChatSessionClient } from "./ChatSessionClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opening = {
  id: "assistant-0",
  role: "assistant",
  content: "Hey there.",
  status: "sent",
};
const userTurn = { id: "user-1", role: "user", content: "hello there" };
const streamingReply = {
  id: "assistant-1",
  role: "assistant",
  content: "",
  status: "generating",
  replyToMessageId: "user-1",
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener() {}

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
}

describe("ChatSessionClient streaming composer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let sessionMessages: unknown[];
  let sessionReads: number;
  let releaseSend: ((response: Response) => void) | undefined;

  beforeEach(() => {
    // Use run-owned browser storage, never Node's ambient localStorage shim.
    // It survives component remounts in a test, just like a real browser tab.
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() { return stored.size; },
      key: (index: number) => [...stored.keys()][index] ?? null,
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
      clear: () => stored.clear(),
    });
    FakeEventSource.instances = [];
    sessionMessages = [opening];
    sessionReads = 0;
    const sendResponse = new Promise<Response>((resolve) => {
      releaseSend = resolve;
    });
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      let seed = 0;
      vi.stubGlobal("crypto", {
        ...globalThis.crypto,
        randomUUID: () => `test-uuid-${(seed += 1)}`,
      });
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // These existing playback/cache cases model an already accepted clip;
        // first-time price acceptance has its own explicit test below.
        if (url === "/api/v1/generation/voice/quote") return Response.json({ ok: true, data: { quote: {
          quoteToken: null, maxCostDreamcoins: 2, overflowCostDreamcoins: 2,
          allowanceMinutes: 30, remainingAllowanceMs: 60_000, balance: 100,
          accepted: true, alreadyDelivered: false,
        } } });
        if (url.endsWith("/messages") && init?.method === "POST") {
          return sendResponse;
        }
        if (url === "/api/v1/chat/sessions/session-1") {
          sessionReads += 1;
          return Response.json({
            ok: true,
            data: {
              session: {
                id: "session-1",
                ownerScope: "user:viewer-a",
                title: "Test chat",
                characterId: "character-1",
                memoryEnabled: true,
                messages: sessionMessages,
                character: { name: "Avery", canUpdateIdentity: false },
              },
            },
          });
        }
        return Response.json({ ok: true, data: {} });
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders the reader's own turn before the send round-trip resolves", async () => {
    await mountSession();

    await act(async () => {
      typeMessage("hello there");
    });
    await act(async () => {
      submitComposer();
    });

    // The POST is still in flight: only the optimistic bubble can be showing it.
    const optimistic = container.querySelector('[data-message-id^="local:"]');
    expect(optimistic?.textContent).toContain("hello there");
    expect(optimistic?.querySelector("[data-testid]")).toBeNull();

    await act(async () => {
      releaseSend?.(sendPayload());
    });
    await waitUntil(() => !container.querySelector('[data-message-id^="local:"]'));
    expect(container.querySelector('[data-message-id="user-1"]')?.textContent)
      .toContain("hello there");
  });

  it("keeps streamed text when a poll lands mid-stream", async () => {
    await startStreamingReply();
    expect(replyBubble()?.textContent).toContain("Once upon");

    // Chat only writes the assistant row at finalize, so a poll mid-stream
    // returns it empty. The bubble must not blank out.
    sessionMessages = [opening, userTurn, streamingReply];
    const readsBeforePoll = sessionReads;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitUntil(() => sessionReads > readsBeforePoll);

    expect(replyBubble()?.textContent).toContain("Once upon");
    expect(container.querySelector('[aria-label="Assistant is typing"]')).not.toBeNull();
  });

  it("stops a running reply and unlocks the composer and regenerate", async () => {
    await startStreamingReply();
    expect(container.querySelector('[data-testid="chat-stop-reply"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-stop-reply"]')
        ?.click();
    });

    expect(FakeEventSource.instances.at(-1)?.closed).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/messages/assistant-1/cancel",
      { method: "POST" },
    );
    expect(replyBubble()?.textContent).toContain("Once upon");
    expect(container.querySelector('[aria-label="Assistant is typing"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-stop-reply"]')).toBeNull();
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull();
    expect(replyBubble()?.querySelector('[data-testid="chat-regenerate"]')).not.toBeNull();
    expect(replyBubble()?.querySelector('[data-testid="chat-play-voice"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("Reply stopped.");
  });

  it.each(["user-1", "assistant-1"])(
    "deletes the complete latest exchange from the %s bubble",
    async (messageId) => {
      sessionMessages = [opening, userTurn, {
        ...streamingReply,
        content: "The final reply",
        status: "sent",
      }];
      await mountSession();
      const originalFetch = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === `/api/v1/messages/${messageId}` && init?.method === "DELETE") {
          sessionMessages = [opening];
          return Response.json({ ok: true });
        }
        return originalFetch(input, init);
      });
      const deleteButton = () => container.querySelector<HTMLButtonElement>(
        `[data-message-id="${messageId}"] [data-testid="chat-delete-message"]`,
      );
      await act(async () => deleteButton()?.click());
      await act(async () => deleteButton()?.click());

      expect(container.querySelector('[data-message-id="user-1"]')).toBeNull();
      expect(replyBubble()).toBeNull();
      expect(container.querySelector('[data-message-id="assistant-0"]')).not.toBeNull();
    },
  );

  it("keeps the committed reply when completion wins the stop race", async () => {
    await startStreamingReply();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/cancel")) {
        sessionMessages = [opening, userTurn, {
          ...streamingReply,
          content: "The complete canonical reply",
          status: "sent",
        }];
        return Response.json({ ok: true, cancelled: false, attempt: 1 });
      }
      return originalFetch(input, init);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-stop-reply"]')?.click();
    });

    expect(replyBubble()?.textContent).toContain("The complete canonical reply");
    expect(container.textContent).not.toContain("Reply stopped.");
  });

  it("keeps a stopped reply's new pending attempt alive until it can stream", async () => {
    await startStreamingReply();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-stop-reply"]')?.click();
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/regenerate")) {
        sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2, status: "pending" }];
        return Response.json({
          assistantMessageId: "assistant-1",
          attempt: 2,
          status: "pending",
          streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
        });
      }
      return originalFetch(input, init);
    });
    await act(async () => {
      replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-regenerate"]')?.click();
    });
    const readsBeforePoll = sessionReads;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => sessionReads > readsBeforePoll);

    expect(container.querySelector('[aria-label="Assistant is typing"]')).not.toBeNull();
    expect(replyBubble()?.textContent).not.toContain("Once upon");

    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2 }];
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => FakeEventSource.instances.length === 2);
    expect(FakeEventSource.instances.at(-1)?.url).toContain("attempt=2");
  });

  it("shows a recoverable error when changing memory loses its connection", async () => {
    await mountSession();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/memory")) throw new TypeError("Network connection lost");
      return originalFetch(input, init);
    });
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="memory-toggle"]');
    await act(async () => toggle()?.click());

    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("Couldn't update memory. Please try again.");
    expect(toggle()?.disabled).toBe(false);
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores the old attempt's delayed recovery after the reader regenerates", async () => {
    await startStreamingReply();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let releaseRecovery: ((response: Response) => void) | undefined;
    let delayNextRead = true;
    const recovery = new Promise<Response>((resolve) => { releaseRecovery = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/chat/sessions/session-1" && delayNextRead) {
        delayNextRead = false;
        return recovery;
      }
      if (url.endsWith("/regenerate")) {
        return Response.json({
          assistantMessageId: "assistant-1", attempt: 2, status: "generating",
          streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
        });
      }
      return originalFetch(input, init);
    });
    await act(async () => FakeEventSource.instances[0]?.emit("error", { code: "provider_error" }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-stop-reply"]')?.click());
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-regenerate"]')?.click());
    const currentStream = FakeEventSource.instances.at(-1);
    expect(currentStream?.url).toContain("attempt=2");
    await act(async () => releaseRecovery?.(Response.json({
      ok: true,
      data: { session: {
        id: "session-1", ownerScope: "user:viewer-a", title: "Test chat", characterId: "character-1",
        character: { name: "Avery" },
        messages: [opening, userTurn, { ...streamingReply, attempt: 1, status: "cancelled" }],
      } },
    })));

    expect(currentStream?.closed).toBe(false);
    expect(container.querySelector('[aria-label="Assistant is typing"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Reply failed to load");
  });

  it("retracts provisional tool-step prose before rendering the final step", async () => {
    await startStreamingReply();
    expect(replyBubble()?.textContent).toContain("Once upon");

    await act(async () => {
      FakeEventSource.instances.at(-1)?.emit("replace", { content: "" });
    });
    expect(replyBubble()?.textContent).not.toContain("Once upon");

    await act(async () => {
      FakeEventSource.instances.at(-1)?.emit("delta", { delta: "Final reply" });
    });
    expect(replyBubble()?.textContent).toContain("Final reply");
  });

  it("turns an insufficient-balance image failure into a recovery path", async () => {
    sessionMessages = [{
      ...opening,
      attachments: [{
        id: "attachment-payment",
        kind: "generated_image",
        status: "failed",
        errorCode: "payment_required",
        promptHint: "A portrait by the window",
      }],
    }];

    await mountSession();

    const card = container.querySelector('[data-testid="chat-image-attachment-card"]');
    expect(card?.textContent).toContain("Not enough dreamcoins");
    expect(card?.textContent).not.toContain("Retry image");
    expect(card?.querySelector('a[href="/upgrade?returnTo=%2Fchat%2Fsession-1"]')?.textContent)
      .toContain("Get more dreamcoins");
  });

  it("retries a failed image through its exact quote and preserves the key after an uncertain response", async () => {
    const attachment = { id: "failed-image", kind: "generated_image", status: "failed", generationJobId: "job-old", errorCode: "provider_error" };
    sessionMessages = [{ ...opening, attachments: [attachment] }];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const writes: RequestInit[] = [];
    let quotes = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/jobs/job-old/retry/quote") {
        quotes += 1;
        return Response.json({ ok: true, data: { quote: { mode: "image", generationJobId: "job-old", profileId: "image-profile", profileVersion: 2, routeFingerprint: "a".repeat(64), pricing: { ruleId: "price", ruleKey: "image", version: 1, effectiveFrom: null, fingerprint: "b".repeat(64) }, outputCount: 1, costDreamcoins: 5, balance: 10 } } });
      }
      if (String(input) === "/api/v1/generation/jobs/job-old/retry") {
        writes.push(init!);
        if (writes.length === 1) throw new TypeError("Network response lost");
        sessionMessages = [{ ...opening, attachments: [{ ...attachment, status: "completed", errorCode: null, generationJobId: "job-new", mediaAssetId: "new-image", mediaUrl: "/new-image.png" }] }];
        return Response.json({ ok: true, data: { job: { id: "job-new", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() }, assets: [] } }, { status: 202 });
      }
      return originalFetch(input, init);
    });
    await mountSession();
    const retry = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => /Retry image|Check image request/.test(button.textContent ?? ""));
    await act(async () => retry()!.click());
    expect(writes).toHaveLength(1);
    expect(retry()).toBeDefined();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mountSession();
    await waitUntil(() => Boolean(container.querySelector('[data-pending-request-key]')));
    const originalRequest = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Check original request");
    expect(originalRequest).toBeDefined();
    await act(async () => originalRequest!.click());
    expect(writes).toHaveLength(2);
    expect(quotes).toBe(1);
    expect(new Headers(writes[0]?.headers).get("idempotency-key")).toBeTruthy();
    expect(new Headers(writes[0]?.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
    expect(new Headers(writes[0]?.headers).get("idempotency-key")).toBe(new Headers(writes[1]?.headers).get("idempotency-key"));
    expect(JSON.parse(String(writes[0]?.body)).quoteAuthority).toMatchObject({ profileId: "image-profile", profileVersion: 2, costDreamcoins: 5 });
    await waitUntil(() => Boolean(container.querySelector('img[data-asset-id="new-image"]')));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/attachments/"))).toBe(false);
  });

  it("does not offer a dead retry for an image that never reserved a generation job", async () => {
    sessionMessages = [{ ...opening, attachments: [{ id: "no-job", kind: "generated_image", status: "failed", errorCode: "generation_unavailable" }] }];
    await mountSession();
    const card = container.querySelector('[data-testid="chat-image-attachment-card"]');
    expect(card?.textContent).toContain("Image unavailable");
    expect(card?.textContent).not.toContain("Retry image");
    expect(card?.textContent).toContain("new image request");
  });

  it("keeps internal generation prompts out of the waiting experience", async () => {
    sessionMessages = [{
      ...opening,
      attachments: [{
        id: "attachment-running",
        kind: "generated_image",
        status: "running",
        errorCode: null,
        promptHint: "Create an in-character photo of Melissa. User request: internal prompt",
      }],
    }];

    await mountSession();

    const card = container.querySelector('[data-testid="chat-image-attachment-card"]');
    expect(card?.textContent).toContain("Generating image");
    expect(card?.textContent).toContain("You can keep chatting while it finishes.");
    expect(card?.textContent).not.toContain("internal prompt");
    expect(card?.textContent).not.toContain("Create an in-character photo");
  });

  it("shows an unconfirmed image without a spinner or paid retry", async () => {
    sessionMessages = [{ ...opening, attachments: [{
      id: "attachment-unknown", kind: "generated_image", status: "accepted",
      generationJobId: "unknown-image", errorCode: "provider_outcome_unknown",
    }] }];
    await mountSession();
    const card = container.querySelector('[data-testid="chat-image-attachment-card"]');
    expect(card?.textContent).toContain("Image result needs review");
    expect(card?.textContent).not.toMatch(/Generating image|being prepared|Retry image|refunded/);
    expect(card?.querySelector(".animate-spin")).toBeNull();
    expect(card?.querySelector('a[href="/helpdesk"]')?.textContent).toContain("Contact support");
    const before = sessionReads;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(sessionReads).toBe(before);
  });

  it("keeps polling an accepted image until its completed preview arrives", async () => {
    sessionMessages = [{
      ...opening,
      attachments: [{
        id: "attachment-accepted",
        kind: "generated_image",
        status: "accepted",
        errorCode: null,
        promptHint: "private prompt",
      }],
    }];
    await mountSession();
    const readsBeforeCompletion = sessionReads;
    sessionMessages = [{
      ...opening,
      attachments: [{
        id: "attachment-accepted",
        kind: "generated_image",
        status: "completed",
        mediaAssetId: "media-accepted",
        mediaUrl: "/api/v1/media/media-accepted/content",
        thumbnailUrl: null,
        width: 512,
        height: 640,
      }],
    }];

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => sessionReads > readsBeforeCompletion);

    expect(container.querySelector<HTMLImageElement>(
      '[data-testid="chat-image-attachment"]',
    )?.src).toContain("/api/v1/media/media-accepted/content");
  });

  it("keeps internal generation prompts out of completed-image alt text", async () => {
    sessionMessages = [{
      ...opening,
      attachments: [{
        id: "attachment-completed",
        kind: "generated_image",
        status: "completed",
        mediaAssetId: "media-1",
        mediaUrl: "/api/v1/media/media-1/content",
        thumbnailUrl: null,
        width: 512,
        height: 640,
        promptHint: "Create an in-character photo of Melissa. User request: internal prompt",
      }],
    }];

    await mountSession();

    const image = container.querySelector<HTMLImageElement>(
      '[data-testid="chat-image-attachment"]',
    );
    expect(image?.alt).toBe("Generated character image from this chat");
    expect(image?.alt).not.toContain("internal prompt");
  });

  it("generates voice only after the reader presses Play", async () => {
    await mountSession();

    expect(voiceRequests()).toHaveLength(0);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')
        ?.click();
    });
    await waitUntil(() => voiceRequests().length === 1);

    const [, request] = voiceRequests()[0] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      characterId: "character-1",
      intent: "play",
      messageId: "assistant-0",
      sessionId: "session-1",
      text: "Hey there.",
    });
  });

  it("shows the accepted voice price ceiling and sends no synthesis before confirmation", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice/quote") return Response.json({ ok: true, data: { quote: {
        quoteToken: "signed-quote-for-this-reply", maxCostDreamcoins: 2, overflowCostDreamcoins: 2,
        allowanceMinutes: 30, remainingAllowanceMs: 45_000, balance: 100,
        accepted: false, alreadyDelivered: false,
      } } });
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    expect(voiceRequests()).toHaveLength(0);
    expect(container.textContent).toContain("up to 2 Dreamcoins");
    expect(container.textContent).toContain("Included minutes are used first");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-confirm-voice"]')!.click());
    expect(voiceRequests()).toHaveLength(1);
    const init = voiceRequests()[0]![1]!;
    expect(JSON.parse(String(init.body)).quoteToken).toBe("signed-quote-for-this-reply");
    expect(new Headers(init.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
    expect(container.querySelector('[data-testid="chat-confirm-voice"]')).toBeNull();
  });

  it("cancels a new voice quote without synthesizing or spending it", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice/quote") return Response.json({ ok: true, data: { quote: {
        quoteToken: "cancelled-quote", maxCostDreamcoins: 2, overflowCostDreamcoins: 2,
        allowanceMinutes: 0, remainingAllowanceMs: 0, balance: 100, accepted: false, alreadyDelivered: false,
      } } });
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    const confirm = container.querySelector('[data-testid="chat-confirm-voice"]')!;
    await act(async () => [...confirm.parentElement!.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
    expect(container.querySelector('[data-testid="chat-confirm-voice"]')).toBeNull();
    expect(voiceRequests()).toHaveLength(0);
  });

  it("drops a delayed accepted voice quote once focus revokes the session owner", async () => {
    let releaseQuote!: (response: Response) => void;
    const quote = new Promise<Response>(resolve => { releaseQuote = resolve; });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let switched = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice/quote") return quote;
      if (switched && String(input) === "/api/v1/chat/sessions/session-1") return Response.json({ ok: false }, { status: 403 });
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    switched = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => releaseQuote(Response.json({ ok: true, data: { quote: {
      quoteToken: null, maxCostDreamcoins: 2, overflowCostDreamcoins: 2,
      allowanceMinutes: 0, remainingAllowanceMs: 0, balance: 100, accepted: true, alreadyDelivered: false,
    } } })));
    expect(voiceRequests()).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-confirm-voice"]')).toBeNull();
  });

  it("reports an expired voice quote without silently accepting a new price", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice/quote") return Response.json({ ok: true, data: { quote: {
        quoteToken: "expired-quote", maxCostDreamcoins: 2, overflowCostDreamcoins: 2,
        allowanceMinutes: 0, remainingAllowanceMs: 0, balance: 100, accepted: false, alreadyDelivered: false,
      } } });
      if (String(input) === "/api/v1/generation/voice") return Response.json({ ok: false, error: { code: "conflict", message: "Voice quote expired; request another quote", details: { reason: "voice_quote_stale" } } }, { status: 409 });
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-confirm-voice"]')!.click());
    expect(voiceRequests()).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/voice/quote"))).toHaveLength(1);
    expect(container.textContent).toContain("voice quote expired");
  });

  it("requests a fresh voice clip when the same reply id is regenerated", async () => {
    const playedUrls: string[] = [];
    let endPlayback: (() => void) | undefined;
    vi.stubGlobal("Audio", class {
      src: string;
      onended?: () => void;
      constructor(src: string) { this.src = src; }
      pause() {}
      async play() {
        playedUrls.push(this.src);
        endPlayback = () => this.onended?.();
      }
    });
    sessionMessages = [opening, userTurn, {
      ...streamingReply,
      attempt: 1,
      content: "First answer",
      status: "sent",
    }];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let voiceAttempt = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice") {
        voiceAttempt += 1;
        return Response.json({ data: { contentUrl: `/voice/attempt-${voiceAttempt}.wav` } });
      }
      if (String(input).endsWith("/regenerate")) {
        sessionMessages = [opening, userTurn, {
          ...streamingReply,
          attempt: 2,
          content: "Regenerated answer",
          status: "sent",
        }];
        return Response.json({
          assistantMessageId: "assistant-1",
          attempt: 2,
          status: "pending",
          streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
        });
      }
      return originalFetch(input, init);
    });
    await mountSession();
    const play = () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')?.click();
    await act(async () => play());
    await act(async () => endPlayback?.());
    await act(async () => {
      replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-regenerate"]')?.click();
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => Boolean(replyBubble()?.textContent?.includes("Regenerated answer")));
    await act(async () => play());

    expect(voiceRequests()).toHaveLength(2);
    expect(playedUrls).toEqual(["/voice/attempt-1.wav", "/voice/attempt-2.wav"]);
  });

  it("requests a replacement only on the next Play after cached media fails, ignoring an old player error", async () => {
    const players: Array<{ src: string; onerror: (() => void) | null; onended: (() => void) | null }> = [];
    vi.stubGlobal("Audio", class {
      onerror: (() => void) | null = null;
      onended: (() => void) | null = null;
      constructor(public src: string) { players.push(this); }
      pause() {}
      async play() {}
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let deliveries = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice") return Response.json({ data: { contentUrl: `/voice/delivery-${++deliveries}.wav` } });
      return originalFetch(input, init);
    });
    await mountSession();
    const play = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')?.click();
    await act(async () => play());
    await act(async () => players[0]?.onerror?.());
    expect(voiceRequests()).toHaveLength(1);
    expect(container.textContent).toContain("Voice playback failed. Please try again.");
    await act(async () => play());
    expect(voiceRequests()).toHaveLength(2);
    expect(players[1]?.src).toBe("/voice/delivery-2.wav");
    await act(async () => players[0]?.onerror?.());
    expect(container.textContent).not.toContain("Voice playback failed. Please try again.");
    await act(async () => players[1]?.onended?.());
    await act(async () => play());
    expect(voiceRequests()).toHaveLength(2);
    expect(players[2]?.src).toBe("/voice/delivery-2.wav");
  });

  it("does not revive the old voice state when audio startup resolves after regeneration", async () => {
    let finishAudioStartup: (() => void) | undefined;
    const startup = new Promise<void>((resolve) => { finishAudioStartup = resolve; });
    vi.stubGlobal("Audio", class {
      src = "/voice/old.wav";
      pause() {}
      play() { return startup; }
    });
    sessionMessages = [opening, userTurn, {
      ...streamingReply, attempt: 1, content: "First answer", status: "sent",
    }];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice") {
        return Response.json({ data: { contentUrl: "/voice/old.wav" } });
      }
      if (String(input).endsWith("/regenerate")) {
        sessionMessages = [opening, userTurn, {
          ...streamingReply, attempt: 2, content: "Regenerated answer", status: "sent",
        }];
        return Response.json({
          assistantMessageId: "assistant-1", attempt: 2, status: "pending",
          streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
        });
      }
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')?.click());
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-regenerate"]')?.click());
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => Boolean(replyBubble()?.textContent?.includes("Regenerated answer")));
    await act(async () => finishAudioStartup?.());

    expect(replyBubble()?.querySelector('[data-testid="chat-play-voice"]')?.getAttribute("aria-pressed"))
      .toBe("false");
  });

  it("stops voice playback when its exchange is deleted", async () => {
    const pause = vi.fn();
    vi.stubGlobal("Audio", class {
      src = "/voice/reply.wav";
      pause = pause;
      async play() {}
    });
    sessionMessages = [opening, userTurn, {
      ...streamingReply, attempt: 1, content: "The answer", status: "sent",
    }];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === "/api/v1/generation/voice"
        ? Response.json({ data: { contentUrl: "/voice/reply.wav" } })
        : originalFetch(input, init),
    );
    await mountSession();
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')?.click());
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-delete-message"]')?.click());
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-delete-message"]')?.click());

    expect(replyBubble()).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
  });

  async function mountSession() {
    await act(async () => {
      root.render(createElement(ChatSessionClient, { id: "session-1" }));
    });
    await waitUntil(() => Boolean(messageInput()));
  }

  async function startStreamingReply() {
    await mountSession();
    await act(async () => {
      typeMessage("hello there");
    });
    await act(async () => {
      submitComposer();
    });
    await act(async () => {
      releaseSend?.(sendPayload());
    });
    await waitUntil(() => FakeEventSource.instances.length > 0);
    await act(async () => {
      FakeEventSource.instances.at(-1)?.emit("delta", { delta: "Once upon" });
    });
  }

  function sendPayload() {
    return Response.json({
      ok: true,
      data: {
        userMessage: userTurn,
        assistant: streamingReply,
        streamUrl: "/api/v1/chat/messages/assistant-1/stream",
      },
    });
  }

  function replyBubble() {
    return container.querySelector('[data-message-id="assistant-1"]');
  }

  function messageInput() {
    return container.querySelector<HTMLInputElement>('input[name="message"]');
  }

  function typeMessage(value: string) {
    const input = messageInput();
    // Bypass React's value tracker so the change is not swallowed as a no-op.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitComposer() {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  function voiceRequests() {
    return vi.mocked(fetch).mock.calls.filter(
      ([input]) => String(input) === "/api/v1/generation/voice",
    );
  }

  async function waitUntil(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for chat session: ${container.textContent}`);
      }
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
});
