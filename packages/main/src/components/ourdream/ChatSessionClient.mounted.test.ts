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
vi.mock("./chat/ChatHeaderControls", () => ({ ChatHeaderControls: () => null }));
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
    expect(replyBubble()?.textContent).toContain("Once upon");
    expect(container.querySelector('[aria-label="Assistant is typing"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-stop-reply"]')).toBeNull();
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull();
    expect(replyBubble()?.querySelector('[data-testid="chat-regenerate"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("Reply stopped.");
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
