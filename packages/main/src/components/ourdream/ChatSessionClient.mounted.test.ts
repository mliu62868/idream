// @vitest-environment happy-dom

import { act, createElement, Fragment, StrictMode, useLayoutEffect, type ComponentProps } from "react";
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

import { ChatSessionClient } from "./ChatSessionClient";
import { invalidateViewerAuthority } from "./viewer-auth";
import { useViewerGate, type ViewerGate } from "@/hooks/useViewerGate";

let sharedViewer: ViewerGate;
function ViewerProbe() {
  const viewer = useViewerGate({ require: "any" });
  useLayoutEffect(() => { sharedViewer = viewer; });
  return null;
}

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
  attempt: 1,
  replyToMessageId: "user-1",
};

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  readyState = FakeEventSource.OPEN;
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
    this.readyState = FakeEventSource.CLOSED;
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
  let sessionProactiveEnabled: boolean;
  let sessionContinuation: "available" | "character_unavailable" | "character_release_changed";
  let sessionReads: number;
  let viewerId: string | null;
  let releaseSend: ((response: Response) => void) | undefined;

  it("keeps drawer reads and row mutations bound to its displayed owner before a cookie-change broadcast", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    const reads: Array<string | null> = [], mutations: string[] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const path = String(input), expected = new Headers(init?.headers).get("x-idream-viewer-scope");
      if (path === "/api/v1/chat/sessions/session-1/experience") return Promise.resolve(Response.json({
        settings: {responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "follow", version: 0}, editable: true,
        catalog: {version: 1, items: [{id: "natural", version: 1, replyStyle: "natural", answerMaxOutputTokens: 512, messageUnits: 1, costDreamcoins: 0, label: "Natural", description: "Natural conversation", preferences: {responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "follow"}}]},
      }));
      if (path === "/api/v1/chat/sessions") {
        reads.push(expected);
        if (expected !== null && expected !== `user:${viewerId}`) return Promise.resolve(Response.json({error: "conflict", message: "Your account changed. Reload to continue."}, {status: 409}));
        return Promise.resolve(Response.json([{id: "b-owned-session", title: "B confidential session", characterId: "b-character", status: "active", memoryEnabled: true, lastMessageAt: null}]));
      }
      if (path === "/api/v1/chat/sessions/b-owned-session" && init?.method === "PATCH") {
        if (expected !== null && expected !== `user:${viewerId}`) return Promise.resolve(Response.json({error: "conflict", message: "Your account changed. Reload to continue."}, {status: 409}));
        mutations.push(viewerId!);
        return Promise.resolve(Response.json({title: "B row changed from stale A drawer"}));
      }
      return base(input, init);
    });
    await mountSession();
    viewerId = "viewer-b";
    // No focus or storage event: the browser cookie has changed before the
    // existing A owner gate hears the delayed auth broadcast.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => container.querySelectorAll('[data-testid="session-list-item"]').length > 0 || Boolean(container.querySelector('[data-testid="chat-drawer-status"][role="alert"]')));
    expect.soft(container.textContent).not.toContain("B confidential session");
    expect.soft(reads).toEqual(["user:viewer-a"]);
    const row = container.querySelector('[data-testid="session-list-item"]');
    if (row?.querySelector('a[href="/chat/b-owned-session"]')) {
      await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-rename"]')!.click());
      const input = container.querySelector<HTMLInputElement>('[aria-label="Rename chat"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "B row changed from stale A drawer");
        input.dispatchEvent(new Event("input", {bubbles: true}));
      });
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true})));
    }
    expect(mutations).toEqual([]);
  });

  it("keeps normal drawer reads, rename, archive and delete on their original signed-in owner", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    const requests: Array<{method: string; scope: string | null; body?: unknown}> = [];
    const rows = ["session-1", "session-2"].map(id => ({id, title: id, characterId: "character-1", status: "active", memoryEnabled: true, lastMessageAt: null}));
    vi.mocked(fetch).mockImplementation((input, init) => {
      const path = String(input);
      if (path === "/api/v1/chat/sessions" || (path.startsWith("/api/v1/chat/sessions/session-2") && init?.method)) {
        requests.push({method: init?.method ?? "GET", scope: new Headers(init?.headers).get("x-idream-viewer-scope"), ...(init?.body ? {body: JSON.parse(String(init.body))} : {})});
        return Promise.resolve(path === "/api/v1/chat/sessions" ? Response.json(rows)
          : init?.method === "PATCH" ? Response.json({title: "Renamed owned chat"})
          : init?.method === "POST" ? Response.json({id: "session-2", status: "archived"}) : Response.json({ok: true}));
      }
      return base(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => container.querySelectorAll('[data-testid="session-list-item"]').length === 2);
    const row = [...container.querySelectorAll('[data-testid="session-list-item"]')].find(item => item.querySelector('a[href="/chat/session-2"]'))!;
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-rename"]')!.click());
    const input = row.querySelector<HTMLInputElement>('[aria-label="Rename chat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed owned chat");
      input.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true})));
    expect(row.textContent).toContain("Renamed owned chat");
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!.click());
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!.click());
    expect(row.textContent).toContain("Archived");
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-delete"]')!.click());
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-delete"]')!.click());
    expect(container.querySelector('a[href="/chat/session-2"]')).toBeNull();
    expect(messageInput()?.disabled).toBe(false);
    expect(requests).toEqual([
      {method: "GET", scope: "user:viewer-a"},
      {method: "PATCH", scope: "user:viewer-a", body: {title: "Renamed owned chat"}},
      {method: "POST", scope: "user:viewer-a"},
      {method: "DELETE", scope: "user:viewer-a"},
    ]);
  });

  it("does not revive an old drawer's delayed response body after its confirmed owner changes", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    let finishBody!: (rows: unknown) => void, readingBody = false;
    const body = new Promise(resolve => { finishBody = resolve; });
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/api/v1/chat/sessions") {
        const response = Response.json([]);
        response.json = () => { readingBody = true; return body; };
        return Promise.resolve(response);
      }
      return base(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => readingBody);
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    expect(container.querySelector('dialog[aria-label="Your chats"]')).toBeNull();
    await act(async () => finishBody([{id: "a-private-session", title: "A delayed confidential title", characterId: "character-1", status: "active", memoryEnabled: true, lastMessageAt: null}]));
    expect(container.textContent).not.toContain("A delayed confidential title");
    expect(container.querySelector('dialog[aria-label="Your chats"]')).toBeNull();
    const read = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/chat/sessions");
    expect(new Headers(read?.[1]?.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
  });

  it("makes the current chat read-only as soon as archive succeeds inside its actual drawer", async () => {
    let archived = false;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const session = { id: "session-1", title: "Test chat", characterId: "character-1", status: archived ? "archived" : "active", memoryEnabled: true, lastMessageAt: null };
      if (url === "/api/v1/chat/sessions") return Response.json([session]);
      if (url === "/api/v1/chat/sessions/session-1/archive" && init?.method === "POST") {
        archived = true; return Response.json({ ...session, status: "archived" });
      }
      const result = await base(input, init);
      if (url === "/api/v1/chat/sessions/session-1") {
        const data = await result.json(); data.data.session.status = archived ? "archived" : "active";
        return Response.json(data);
      }
      return result;
    });
    await mountSession(); await act(async () => typeMessage("Keep my unsent note."));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => Boolean(container.querySelector('[aria-label="Archive chat"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Archive chat"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Confirm archive chat"]')!.click());
    await waitUntil(() => archived && Boolean(container.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')?.disabled));
    expect(messageInput()?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("This conversation is archived");
    expect(messageInput()?.value).toBe("Keep my unsent note.");
  });

  it("keeps the current chat and its unsent draft active when archive confirmation is cancelled", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/chat/sessions"
      ? Promise.resolve(Response.json([{ id: "session-1", title: "Test chat", characterId: "character-1", status: "active", memoryEnabled: true, lastMessageAt: null }])) : base(input, init));
    await mountSession(); await act(async () => typeMessage("Keep my unsent note."));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => Boolean(container.querySelector('[aria-label="Archive chat"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Archive chat"]')!.click());
    expect(container.querySelector('[aria-label="Confirm archive chat"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close your chats"]')!.click());
    expect(messageInput()?.disabled).toBe(false); expect(messageInput()?.value).toBe("Keep my unsent note.");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/archive") && init?.method === "POST")).toHaveLength(0);
    expect(container.textContent).not.toContain("This conversation is archived");
  });

  it.each(["rejected-current", "successful-other"])("does not archive the current composer after a %s archive request", async outcome => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    const targetId = outcome === "rejected-current" ? "session-1" : "session-2";
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/v1/chat/sessions") return Promise.resolve(Response.json(["session-1", "session-2"].map(id => ({ id, title: id, characterId: "character-1", status: "active", memoryEnabled: true, lastMessageAt: null }))));
      if (url.endsWith("/archive") && init?.method === "POST") return Promise.resolve(outcome === "rejected-current"
        ? Response.json({ error: "conflict", message: "Cancel the active reply before archiving this chat" }, { status: 409 })
        : Response.json({ id: targetId, status: "archived" }));
      return base(input, init);
    });
    await mountSession(); await act(async () => typeMessage("Keep my unsent note."));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => container.querySelectorAll('[data-testid="session-list-item"]').length === 2);
    const row = [...container.querySelectorAll('[data-testid="session-list-item"]')].find(row => row.querySelector(`a[href="/chat/${targetId}"]`))!;
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!.click());
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!.click());
    await waitUntil(() => outcome === "rejected-current" ? Boolean(container.textContent?.includes("Cancel the active reply before archiving this chat")) : Boolean(row.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')?.disabled));
    expect(messageInput()?.disabled).toBe(false); expect(messageInput()?.value).toBe("Keep my unsent note.");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);
    expect(container.textContent).not.toContain("This conversation is archived");
  });

  it("shows the Main-owned private-turn receipt on history regardless of the current session mode", async () => {
    sessionMessages = [
      opening,
      { ...userTurn, memoryEnabled: false },
      { ...streamingReply, content: "Temporary marker logged.", status: "sent", memoryEnabled: false },
      { ...streamingReply, id: "normal-reply", content: "Normal reply.", status: "sent", memoryEnabled: true },
    ];
    await mountSession();
    expect(container.querySelector('[data-message-id="assistant-1"] [data-testid="chat-private-turn"]')?.textContent)
      .toContain("Not saved to long-term memory");
    expect(container.querySelector('[data-message-id="normal-reply"] [data-testid="chat-private-turn"]')).toBeNull();
    expect(container.querySelector('[data-message-id="assistant-0"] [data-testid="chat-private-turn"]')).toBeNull();
    expect(container.querySelector('[data-message-id="user-1"] [data-testid="chat-private-turn"]')).toBeNull();
  });

  it("explains a Main-confirmed length limit on history and after remount without marking normal, legacy or cancelled replies", async () => {
    sessionMessages = [opening, userTurn,
      { ...streamingReply, content: "The unfinished story", status: "sent", replyLimitReached: true },
      { ...streamingReply, id: "normal-reply", content: "A complete reply.", status: "sent", replyLimitReached: false },
      { ...streamingReply, id: "legacy-reply", content: "Legacy ending without punctuation", status: "sent" },
      { ...streamingReply, id: "cancelled-reply", content: "", status: "cancelled", replyLimitReached: true },
    ];
    await mountSession();
    const notice = "Reply reached the length limit. Ask the character to continue.";
    expect(replyBubble()?.textContent).toContain(notice);
    expect(container.querySelectorAll('[data-testid="chat-reply-limit"]')).toHaveLength(1);
    expect(container.querySelector('[data-message-id="legacy-reply"]')?.textContent).toContain("Legacy ending without punctuation");
    await act(async () => root.render(null));
    await mountSession();
    expect(replyBubble()?.textContent).toContain(notice);
    expect(container.querySelectorAll('[data-testid="chat-reply-limit"]')).toHaveLength(1);
  });

  it.each([true, false])("uses the canonical length-limit flag after SSE completes (%s), without trusting streamed prose", async replyLimitReached => {
    await startStreamingReply();
    const stream = FakeEventSource.instances.at(-1)!;
    await act(async () => stream.emit("delta", { delta: " unfinished", finishReason: "length" }));
    expect(container.querySelector('[data-testid="chat-reply-limit"]')).toBeNull();
    sessionMessages = [opening, userTurn, { ...streamingReply, content: "Canonical final text", status: "sent", replyLimitReached }];
    await act(async () => stream.emit("done", { finishReason: "length" }));
    await waitUntil(() => stream.closed);
    expect(replyBubble()?.textContent).toContain("Canonical final text");
    expect(Boolean(replyBubble()?.querySelector('[data-testid="chat-reply-limit"]'))).toBe(replyLimitReached);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST")).toHaveLength(1);
  });

  it("removes the earlier attempt's length notice while the next attempt streams and after a normal completion", async () => {
    sessionMessages = [opening, userTurn, { ...streamingReply, content: "Limited old answer", status: "sent", replyLimitReached: true }];
    await mountSession();
    expect(replyBubble()?.querySelector('[data-testid="chat-reply-limit"]')).not.toBeNull();
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2 }];
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => FakeEventSource.instances.length === 1);
    expect(replyBubble()?.querySelector('[data-testid="chat-reply-limit"]')).toBeNull();
    const stream = FakeEventSource.instances[0]!;
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2, content: "New complete answer.", status: "sent" }];
    await act(async () => stream.emit("done", {}));
    await waitUntil(() => stream.closed);
    expect(replyBubble()?.textContent).toContain("New complete answer.");
    expect(replyBubble()?.querySelector('[data-testid="chat-reply-limit"]')).toBeNull();
  });

  it("keeps a committed current archive authoritative after Escape closes its pending drawer", async () => {
    let finishArchive!: (response: Response) => void;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/v1/chat/sessions") return Promise.resolve(Response.json([{ id: "session-1", title: "Test chat", characterId: "character-1", status: "active", memoryEnabled: true, lastMessageAt: null }]));
      if (url.endsWith("/archive") && init?.method === "POST") return new Promise<Response>(resolve => { finishArchive = resolve; });
      return base(input, init);
    });
    await mountSession(); await act(async () => typeMessage("Keep my unsent note."));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-list-open"]')!.click());
    await waitUntil(() => Boolean(container.querySelector('[aria-label="Archive chat"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Archive chat"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Confirm archive chat"]')!.click());
    await act(async () => container.querySelector('dialog[aria-label="Your chats"]')!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(container.querySelector('[aria-label="Your chats"]')).toBeNull();
    await act(async () => finishArchive(Response.json({ id: "session-1", status: "archived" })));
    expect(messageInput()?.disabled).toBe(true);
    expect(container.textContent).toContain("This conversation is archived");
    expect(messageInput()?.value).toBe("Keep my unsent note.");
  });

  it("binds a memory clear to the owner who reviewed its impact even before cookie-change broadcast", async () => {
    const clearOwners: string[] = [];
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/v1/chat/groups") return Promise.resolve(Response.json({ ownerScope: `user:${viewerId}`, groups: [] }));
      if (url === "/api/v1/chat/memory/character-1" && init?.method === "DELETE") {
        const expected = new Headers(init.headers).get("x-idream-viewer-scope");
        if (expected !== null && expected !== `user:${viewerId}`) return Promise.resolve(Response.json({ error: "conflict", message: "Your account changed. Reload to continue." }, { status: 409 }));
        clearOwners.push(viewerId!);
        return Promise.resolve(Response.json({}, { status: 503 }));
      }
      return base(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="memory-panel-open"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="memory-clear"]')!.click());
    expect(container.textContent).toContain("No active group chats with this character were found");
    viewerId = "viewer-b";
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="memory-clear"]')!.click());
    expect(clearOwners).not.toContain("viewer-b");
    const requests = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes("/memory/") && init?.method === "DELETE");
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0][1]?.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
  });

  it("binds the memory impact read to the displayed owner before a cookie-change broadcast", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/api/v1/chat/groups") {
        const expected = new Headers(init?.headers).get("x-idream-viewer-scope");
        return Promise.resolve(expected !== null && expected !== `user:${viewerId}`
          ? Response.json({ error: "conflict", message: "Your account changed. Reload to continue." }, { status: 409 })
          : Response.json({ ownerScope: `user:${viewerId}`, groups: [{ title: "B private group", status: "active", members: [{ characterId: "character-1" }] }] }));
      }
      return base(input, init);
    });
    await mountSession(); viewerId = "viewer-b";
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="memory-panel-open"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="memory-clear"]')!.click());
    expect(container.textContent).not.toContain("B private group");
    expect(container.textContent).toContain("Nothing has been cleared");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="memory-clear"]')?.disabled).toBe(true);
    const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/chat/groups");
    expect(new Headers(request?.[1]?.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
  });

  beforeEach(() => {
    invalidateViewerAuthority();
    viewerId = "viewer-a";
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
    sessionProactiveEnabled = false;
    sessionContinuation = "available";
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
        if (url === "/api/v1/me") return Response.json({ ok: true, data: { user: viewerId ? { id: viewerId } : null } });
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
        if (url.endsWith("/cancel") && init?.method === "POST") {
          return Response.json({ cancelled: true, attempt: 1 });
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
                proactiveEnabled: sessionProactiveEnabled,
                continuation: sessionContinuation,
                messages: sessionMessages,
                character: { name: "Avery", canUpdateIdentity: false, image: "/media/avery-thumb.png" },
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
    invalidateViewerAuthority();
    vi.unstubAllGlobals();
  });

  it("keeps the companion's portrait beside the conversation and links it to their profile", async () => {
    await mountSession();
    const portrait = container.querySelector<HTMLElement>('[data-testid="chat-companion-portrait"]');
    expect(portrait?.className).toContain("xl:block");
    expect(portrait?.querySelector("img")?.getAttribute("src")).toBe("/media/avery-thumb.png");
    expect(portrait?.querySelector("a")?.getAttribute("href")).toBe("/characters/character-1");
    // The wide layout shows the face once; the header avatar is for narrow screens.
    expect(container.querySelector('[data-testid="chat-header-avatars"]')?.className).toContain("xl:hidden");
  });

  it("keeps paused Character history readable while refusing new messages and calls", async () => {
    sessionContinuation = "character_unavailable";
    await mountSession();
    expect(container.textContent).toContain("Hey there.");
    expect(container.textContent).toContain("This Character is currently unavailable. Your conversation stays readable.");
    expect(messageInput()?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="chat-generate-link"]')).toBeNull();
    expect(container.querySelector('[aria-label="Generate is loading"]')).toBeNull();
    await act(async () => {
      typeMessage("Please continue.");
      submitComposer();
    });
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST")).toHaveLength(0);
  });

  it("preserves an unsent draft across a pause and enables it after authority is restored", async () => {
    await mountSession();
    await act(async () => typeMessage("Keep this draft."));
    sessionContinuation = "character_unavailable";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => messageInput()?.disabled === true);
    expect(messageInput()?.value).toBe("Keep this draft.");
    sessionContinuation = "available";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => messageInput()?.disabled === false);
    expect(messageInput()?.value).toBe("Keep this draft.");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST")).toHaveLength(0);
  });

  it("offers the current Character chat before sending and carries its unsent draft", async () => {
    const handoff = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => handoff.get(key) ?? null,
      setItem: (key: string, value: string) => { handoff.set(key, value); },
      removeItem: (key: string) => { handoff.delete(key); },
    });
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await mountSession();
    await act(async () => typeMessage("Bring this draft to the new chat."));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === "/api/v1/chat/sessions" && init?.method === "POST"
      ? Response.json({ ok: true, data: { session: { id: "current-session" } } }) : originalFetch(input, init));
    sessionContinuation = "character_release_changed";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => messageInput()?.disabled === true);
    const continueButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Continue in a new chat");
    expect(continueButton).toBeDefined();
    await act(async () => continueButton!.click());
    expect(assign).toHaveBeenCalledWith("/chat/current-session");
    expect(handoff.get("idream:chat-release-handoff:current-session")).toBe("Bring this draft to the new chat.");
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST")).toHaveLength(0);
    assign.mockRestore();
  });

  it("keeps Shift+Enter and IME composition editable and sends multiline text once on plain Enter", async () => {
    await mountSession();
    await act(async () => typeMessage("First line"));
    const textarea = messageInput()!;
    expect(textarea.tagName).toBe("TEXTAREA");
    for (const flags of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...flags });
      await act(async () => textarea.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST")).toHaveLength(0);
      expect(messageInput()!.value).toBe("First line");
    }
    await act(async () => typeMessage("First line\nSecond line"));
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    const messages = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST");
    expect(messages).toHaveLength(1);
    expect(JSON.parse(String(messages[0][1]!.body)).content).toBe("First line\nSecond line");
    await act(async () => releaseSend?.(sendPayload()));
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

  it("protects the submitted draft during admission and allows the next draft while the reply streams", async () => {
    await mountSession();
    await act(async () => typeMessage("hello there"));
    await act(async () => submitComposer());
    expect(messageInput()?.readOnly).toBe(true);
    await act(async () => releaseSend?.(sendPayload()));
    await waitUntil(() => FakeEventSource.instances.length > 0);

    expect(messageInput()?.readOnly).toBe(false);
    await act(async () => typeMessage("My next draft"));
    await act(async () => FakeEventSource.instances.at(-1)?.emit("delta", { delta: "Current reply" }));
    expect(messageInput()?.value).toBe("My next draft");
    await act(async () => submitComposer());
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")).toHaveLength(1);
  });

  it.each<number | "network">([402, 503, "network"])("restores the protected draft and releases the composer after admission fails with %s", async failure => {
    const send = Promise.withResolvers<Response>();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).endsWith("/messages") && init?.method === "POST"
      ? send.promise : originalFetch(input, init));
    await mountSession();
    await act(async () => typeMessage("Keep my submitted draft"));
    await act(async () => submitComposer());
    expect(messageInput()?.readOnly).toBe(true);
    await act(async () => {
      if (failure === "network") send.reject(new TypeError("Network connection lost"));
      else send.resolve(Response.json({ error: "unavailable" }, { status: failure }));
    });

    expect(messageInput()?.readOnly).toBe(false);
    expect(messageInput()?.value).toBe("Keep my submitted draft");
    expect(container.querySelector('[data-message-id^="local:"]')).toBeNull();
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
    const cancel = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/messages/assistant-1/cancel");
    expect(cancel?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ attempt: 1 }) });
    expect(new Headers(cancel?.[1]?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(cancel?.[1]?.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
    expect(replyBubble()?.textContent).toContain("Once upon");
    expect(container.querySelector('[aria-label="Assistant is typing"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-stop-reply"]')).toBeNull();
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull();
    expect(replyBubble()?.querySelector('[data-testid="chat-regenerate"]')).not.toBeNull();
    expect(replyBubble()?.querySelector('[data-testid="chat-play-voice"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("Reply stopped.");
  });

  it.each([200, 409])("keeps the newer reply when an old Stop returns HTTP %s", async (status) => {
    await startStreamingReply();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const cancelResponse = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).endsWith("/cancel") ? cancelResponse.promise : originalFetch(input, init),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-stop-reply"]')?.click());
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2 }];
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => FakeEventSource.instances.length === 2);
    const currentStream = FakeEventSource.instances[1]!;
    await act(async () => currentStream.emit("delta", { attempt: 2, delta: "New partial reply" }));
    await act(async () => cancelResponse.resolve(Response.json({ cancelled: status === 200, attempt: 1 }, { status })));

    expect(replyBubble()?.textContent).toContain("New partial reply");
    expect(currentStream.closed).toBe(false);
    expect(container.querySelector('[aria-label="Assistant is typing"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-stop-reply"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent ?? "").not.toContain("Reply stopped");
    const cancel = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/messages/assistant-1/cancel");
    expect(cancel?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ attempt: 1 }) });
    expect(new Headers(cancel?.[1]?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(cancel?.[1]?.headers).get("x-idream-viewer-scope")).toBe("user:viewer-a");
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

  it("drops a stopped attempt's cache when another page regenerates to pending", async () => {
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 1 }];
    await mountSession();
    await waitUntil(() => FakeEventSource.instances.length === 1);
    await act(async () => FakeEventSource.instances[0]?.emit("delta", { attempt: 1, delta: "Old partial reply" }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-stop-reply"]')?.click());
    expect(replyBubble()?.textContent).toContain("Old partial reply");

    // An independent browser page advances Main's attempt; this page did not
    // execute regenerate(), so its old stopped cache still exists.
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2, status: "pending" }];
    const readsBefore = sessionReads;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => sessionReads > readsBefore);
    expect(replyBubble()?.textContent).not.toContain("Old partial reply");
    expect(container.querySelector('[aria-label="Assistant is typing"]')).not.toBeNull();

    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2 }];
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => FakeEventSource.instances.length === 2);
    expect(FakeEventSource.instances.at(-1)?.url).toContain("attempt=2");
  });

  it("replaces an older attempt's live stream after another page regenerates", async () => {
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 1 }];
    await mountSession();
    await waitUntil(() => FakeEventSource.instances.length === 1);
    const previous = FakeEventSource.instances[0]!;
    await act(async () => previous.emit("delta", { attempt: 1, delta: "Old partial reply" }));
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2 }];
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitUntil(() => FakeEventSource.instances.length === 2);
    expect(previous.closed).toBe(true);
    await act(async () => previous.emit("delta", { attempt: 1, delta: "Late old text" }));
    expect(replyBubble()?.textContent).not.toContain("Late old text");
    await act(async () => FakeEventSource.instances.at(-1)?.emit("delta", { attempt: 2, delta: "New reply" }));
    expect(replyBubble()?.textContent).toContain("New reply");
    expect(replyBubble()?.textContent).not.toContain("Old partial reply");
  });

  it.each(["regenerate", "edit"])("discards a delayed focus snapshot started during %s", async (mutation) => {
    sessionMessages = [opening, userTurn, { ...streamingReply, status: "sent", content: "Old answer" }];
    await mountSession();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const staleSnapshot = await originalFetch("/api/v1/chat/sessions/session-1");
    const mutationResponse = Promise.withResolvers<Response>();
    const focusResponse = Promise.withResolvers<Response>();
    let deferFocusRead = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/regenerate") || (url.endsWith("/user-1") && init?.method === "PATCH")) {
        return mutationResponse.promise;
      }
      if (url === "/api/v1/chat/sessions/session-1" && deferFocusRead) {
        deferFocusRead = false;
        return focusResponse.promise;
      }
      return originalFetch(input, init);
    });
    if (mutation === "regenerate") {
      await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-regenerate"]')?.click());
    } else {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-edit-message"]')?.click());
      await act(async () => {
        const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-edit-input"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, "Changed user request");
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => container.querySelector('[data-testid="chat-save-edit"]')?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ));
    }
    deferFocusRead = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2 }];
    await act(async () => mutationResponse.resolve(Response.json({
      assistantMessageId: "assistant-1", attempt: 2, status: "generating",
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
    })));
    await waitUntil(() => FakeEventSource.instances.length === 1);
    const currentStream = FakeEventSource.instances[0]!;
    expect(currentStream.url).toContain("attempt=2");
    await act(async () => focusResponse.resolve(staleSnapshot));

    expect(currentStream.closed).toBe(false);
    expect(container.querySelector('[aria-label="Assistant is typing"]')).not.toBeNull();
    expect(replyBubble()?.textContent).not.toContain("Old answer");
  });

  it("reopens a CLOSED transport while allowing CONNECTING to reconnect itself", async () => {
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 1 }];
    await mountSession();
    await waitUntil(() => FakeEventSource.instances.length === 1);
    const previous = FakeEventSource.instances[0]!;
    previous.readyState = FakeEventSource.CONNECTING;
    await act(async () => previous.emit("error", {}));
    expect(previous.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    previous.readyState = FakeEventSource.CLOSED;
    await act(async () => previous.emit("error", {}));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => FakeEventSource.instances.length === 2);
    expect(FakeEventSource.instances.at(-1)?.url).toContain("attempt=1");
    expect(fetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/regenerate$/u), expect.anything());
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

  // SPEC: 角色发布新版本后，旧会话里发消息 → 打开角色当前会话并带上没发出去的那句话。
  // INTENT: 以前这里只显示「This chat is no longer active」，用户看到的是聊天突然坏了。
  it("moves an unsent message to the Character's current chat when the Character was updated", async () => {
    const handoff = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => handoff.get(key) ?? null,
      setItem: (key: string, value: string) => { handoff.set(key, value); },
      removeItem: (key: string) => { handoff.delete(key); },
    });
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await mountSession();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/messages") && init?.method === "POST") {
        return Response.json({
          error: "gone",
          message: "Character has no active Serving Release",
          details: { reason: "character_release_changed", characterId: "character-1" },
        }, { status: 410 });
      }
      if (url === "/api/v1/chat/sessions" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ characterId: "character-1" });
        return Response.json({ ok: true, data: { session: { id: "session-2" } } });
      }
      return originalFetch(input, init);
    });

    await act(async () => typeMessage("are you still there?"));
    await act(async () => submitComposer());
    await waitUntil(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("/chat/session-2");
    expect([...handoff.values()]).toEqual(["are you still there?"]);

    // Arriving in the new chat: the message waits in the box, sent by nobody yet.
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      originalFetch(String(input) === "/api/v1/chat/sessions/session-2" ? "/api/v1/chat/sessions/session-1" : input, init),
    );
    handoff.set("idream:chat-release-handoff:session-1", "are you still there?");
    await mountSession();
    await waitUntil(() => messageInput()?.value === "are you still there?");
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("This Character was updated, so we opened a new chat.");
    expect(handoff.size).toBe(1);
    expect(handoff.has("idream:chat-release-handoff:session-1")).toBe(false);
    assign.mockRestore();
  });

  it("keeps the message in place when the Character's current chat cannot be opened", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await mountSession();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/messages") && init?.method === "POST") {
        return Response.json({ error: "gone", details: { reason: "character_release_changed", characterId: "character-1" } }, { status: 410 });
      }
      if (url === "/api/v1/chat/sessions" && init?.method === "POST") {
        return Response.json({ ok: false, error: { code: "gone" } }, { status: 410 });
      }
      return originalFetch(input, init);
    });

    await act(async () => typeMessage("are you still there?"));
    await act(async () => submitComposer());
    await waitUntil(() => Boolean(container.querySelector('[data-testid="chat-session-status"]')));
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("This Character was updated, so this chat is now read-only.");
    expect(messageInput()?.value).toBe("are you still there?");
    expect(assign).not.toHaveBeenCalled();
    assign.mockRestore();
  });

  // SPEC: 状态提示和输入框同属一个 sticky 容器。
  // INTENT: 状态段落曾经跟在 sticky 输入框后面的普通流里，长会话时被顶到文档底部、
  //   永远在视口外，点了按钮看起来像没反应。
  it("keeps a chat status pinned with the composer instead of below the transcript", async () => {
    await mountSession();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/memory")) throw new TypeError("Network connection lost");
      return originalFetch(input, init);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="memory-toggle"]')?.click());

    const status = container.querySelector('[data-testid="chat-session-status"]');
    expect(status).not.toBeNull();
    const pinned = status!.closest(".sticky");
    expect(pinned).not.toBeNull();
    expect(pinned!.querySelector("form")).not.toBeNull();
  });

  it("re-follows the latest reply when the composer dock grows after entry, until the reader scrolls up", async () => {
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      targets: Element[] = [];
      constructor(public callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    // The dock (sticky) covers the viewport from y=500; the latest message ends far below it.
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return (this.classList.contains("sticky") ? { top: 500, bottom: 800 } : { top: 0, bottom: 3_000 }) as DOMRect;
    });
    try {
      await mountSession();
      const dockObserver = observers.find(observer => observer.targets.some(target => target.querySelector("form")));
      expect(dockObserver).toBeDefined();
      // A late block (voice controls) mounting in the dock: follow to the page end,
      // where the dock sits in flow below the list and cannot cover the latest reply.
      scrollTo.mockClear();
      await act(async () => dockObserver!.callback([], dockObserver as unknown as ResizeObserver));
      expect(scrollTo).toHaveBeenCalledWith({ top: document.documentElement.scrollHeight, behavior: "auto" });

      // The reader scrolls up with the latest message hidden under the dock: released.
      for (const y of [400, 300]) {
        Object.defineProperty(window, "scrollY", { configurable: true, value: y });
        await act(async () => window.dispatchEvent(new Event("scroll")));
      }
      scrollTo.mockClear();
      await act(async () => dockObserver!.callback([], dockObserver as unknown as ResizeObserver));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
      scrollTo.mockRestore();
      Reflect.deleteProperty(window, "scrollY");
    }
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

  it("explains the active-image cap on a failed image turn instead of an unavailable reply", async () => {
    sessionMessages = [{
      ...opening,
      content: "",
      attachments: [{ id: "attachment-busy", kind: "generated_image", status: "failed", errorCode: "rate_limited" }],
    }];

    await mountSession();

    const card = container.querySelector('[data-testid="chat-image-attachment-card"]');
    expect(card?.textContent).toContain("Too many images in progress");
    expect(card?.textContent).toContain("No coins used");
    expect(container.textContent).not.toContain("Reply unavailable.");
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

  it("clears another tab's generation warning once that original request is accepted", async () => {
    await mountSession();
    const requestKey = "other-tab-generation-key";
    const ownerScope = "user:viewer-a";
    const storageKey = `idream:generation-receipt:v1:${encodeURIComponent(ownerScope)}:${requestKey}`;
    const record = JSON.stringify({
      kind: "generation", url: "/api/v1/generation/jobs", requestKey,
      body: { mode: "image", outputCount: 1, quoteAuthority: {
        profileId: "image", profileVersion: 1, routeFingerprint: "a".repeat(64),
        pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 8,
      } },
    });
    const saved = JSON.stringify({ version: 1, ownerScope, record, idempotencyKey: requestKey });
    window.localStorage.setItem(storageKey, saved);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", {
      key: storageKey, oldValue: null, newValue: saved, storageArea: window.localStorage,
    })));
    expect(container.querySelector(`[data-pending-request-key="${requestKey}"]`)).not.toBeNull();

    window.localStorage.removeItem(storageKey);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", {
      key: storageKey, oldValue: saved, newValue: null, storageArea: window.localStorage,
    })));

    expect(container.querySelector('[aria-label="Unconfirmed generation requests"]')).toBeNull();
    expect(container.textContent).not.toContain("A response was interrupted");
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
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
    expect(card?.textContent).toContain("Image result not confirmed yet");
    expect(card?.textContent).not.toMatch(/Generating image|being prepared|Retry image|were returned/);
    expect(card?.querySelector(".animate-spin")).toBeNull();
    expect(card?.textContent).toContain("marked failed automatically within about 30 minutes");
    expect(card?.querySelector('a[href="/helpdesk"]')).toBeNull();
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

  it.each([false, true])("keeps scene images free of character identity actions (preview failed: %s)", async previewFailed => {
    sessionMessages = [{ ...opening, turnId: "turn-scene", attempt: 1, attachments: [{
      id: "attachment-scene", kind: "generated_image", imageSubject: "scene", status: "completed",
      mediaAssetId: "media-scene", mediaUrl: "/api/v1/media/media-scene/content", width: 512, height: 640,
    }] }];
    await mountSession();
    const image = container.querySelector<HTMLImageElement>('[data-testid="chat-image-attachment"]');
    expect(image?.alt).toBe("Generated scene image from this chat");
    if (previewFailed) await act(async () => image?.dispatchEvent(new Event("error")));
    expect(container.querySelector('[aria-label="Character identity feedback"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Looks like them|Doesn.t match|Use for identity/);
    expect(container.textContent).toContain("More like this");
    expect(container.textContent).toContain("Open in Generate");
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

  it.each(["playing", "render pending", "quote pending"])("stops %s TTS on microphone start and blocks voice requests during capture", async mode => {
    const pause = vi.fn(), play = vi.fn().mockResolvedValue(undefined), stopTrack = vi.fn();
    vi.stubGlobal("Audio", class {
      src: string; onerror: (() => void) | null = null; onended: (() => void) | null = null;
      constructor(src: string) { this.src = src; }
      pause = pause; play = play;
    });
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() { return true; }
      state = "inactive"; ondataavailable = null; onstop = null; onerror = null;
      start() { this.state = "recording"; } stop() { this.state = "inactive"; }
    });
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack, onended: null }] }) } });
    const secureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    let releaseTts!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { releaseTts = resolve; });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/voice-input")) return Response.json({ ok: true, data: {
        supported: true, available: true, ownerScope: "user:viewer-a", languages: ["en"],
        maxDurationMs: 60_000, maxUploadBytes: 8388608, resultTtlMs: 120_000,
      } });
      if (url === "/api/v1/generation/voice/quote" && mode === "quote pending") return pending;
      if (url === "/api/v1/generation/voice") return mode === "render pending" ? pending : Response.json({ data: { contentUrl: "/voice/recording-test.wav" } });
      return originalFetch(input, init);
    });
    try {
      await mountSession();
      await waitUntil(() => container.querySelector('[aria-label="Voice input"]') !== null);
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
      if (mode === "playing") expect(play).toHaveBeenCalledOnce();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Voice input"]')!.click());
      expect(container.textContent).toContain("Listening");
      if (mode === "playing") expect(pause).toHaveBeenCalledOnce();
      const beforeQuote = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/voice/quote")).length;
      const beforeRender = voiceRequests().length;
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/voice/quote"))).toHaveLength(beforeQuote);
      expect(voiceRequests()).toHaveLength(beforeRender);
      if (mode !== "playing") {
        await act(async () => releaseTts(mode === "render pending" ? Response.json({ data: { contentUrl: "/voice/late.wav" } }) : Response.json({ ok: true, data: { quote: {
          quoteToken: null, maxCostDreamcoins: 2, overflowCostDreamcoins: 2, allowanceMinutes: 30,
          remainingAllowanceMs: 60_000, balance: 100, accepted: true, alreadyDelivered: false,
        } } })));
        expect(play).not.toHaveBeenCalled();
        expect(voiceRequests()).toHaveLength(beforeRender);
      }
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Cancel")!.click());
      expect(stopTrack).toHaveBeenCalledOnce();
    } finally {
      if (secureContext) Object.defineProperty(window, "isSecureContext", secureContext);
      else Reflect.deleteProperty(window, "isSecureContext");
    }
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

  it("revokes private history, drafts, streams, audio and receipts when another surface confirms a new owner without focus", async () => {
    sessionMessages = [{ ...opening, attachments: [{ id: "private-image", kind: "generated_image", status: "completed", mediaAssetId: "private-image", mediaUrl: "/media/private-a.png" }] }];
    const pause = vi.fn();
    vi.stubGlobal("Audio", class {
      constructor(public src: string) {}
      pause = pause;
      async play() {}
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice") return Response.json({ data: { contentUrl: "/voice/private.wav" } });
      if (viewerId === "viewer-b" && String(input) === "/api/v1/chat/sessions/session-1") return Response.json({ ok: false }, { status: 503 });
      return originalFetch(input, init);
    });
    await startStreamingReply();
    expect(container.querySelector('img[data-asset-id="private-image"]')).not.toBeNull();
    await act(async () => typeMessage("A private unsent draft"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-message-id="assistant-0"] [data-testid="chat-play-voice"]')!.click());
    const storageKey = `idream:generation-receipt:v1:${encodeURIComponent("user:viewer-a")}:private-request`;
    const record = JSON.stringify({ kind: "generation", url: "/api/v1/generation/jobs", requestKey: "private-request", body: {
      mode: "image", outputCount: 1, quoteAuthority: { profileId: "image", profileVersion: 1,
        routeFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 8 },
    } });
    const saved = JSON.stringify({ version: 1, ownerScope: "user:viewer-a", record, idempotencyKey: "private-request" });
    window.localStorage.setItem(storageKey, saved);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", {
      key: storageKey, oldValue: null, newValue: saved, storageArea: window.localStorage,
    })));
    expect(container.querySelector('[data-pending-request-key="private-request"]')).not.toBeNull();
    const oldStream = FakeEventSource.instances.at(-1)!;
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    await act(async () => oldStream.emit("delta", { delta: "Late private answer" }));
    expect(container.textContent).not.toContain("Hey there.");
    expect(container.textContent).not.toContain("Once upon");
    expect(container.textContent).not.toContain("Late private answer");
    expect(container.querySelector('[data-testid="chat-header-avatars"] img')).toBeNull();
    expect(container.querySelector('img[data-asset-id="private-image"]')).toBeNull();
    expect(messageInput()).toBeNull();
    expect(container.querySelector('[data-pending-request-key="private-request"]')).toBeNull();
    expect(oldStream.closed).toBe(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(storageKey)).toBe(saved);
  });

  it("abandons an accepted send and its stream after shared owner change", async () => {
    await mountSession();
    await act(async () => { typeMessage("A private pending message"); });
    await act(async () => { submitComposer(); });
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    await act(async () => { releaseSend?.(sendPayload()); });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(container.textContent).not.toContain("hello there");
    expect(container.textContent).not.toContain("A private pending message");
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")).toHaveLength(1);
  });

  it("abandons a late accepted voice quote after shared owner change", async () => {
    const quote = Promise.withResolvers<Response>();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === "/api/v1/generation/voice/quote" ? quote.promise : originalFetch(input, init));
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    await act(async () => quote.resolve(Response.json({ ok: true, data: { quote: {
      quoteToken: null, maxCostDreamcoins: 2, overflowCostDreamcoins: 2, allowanceMinutes: 0,
      remainingAllowanceMs: 0, balance: 100, accepted: true, alreadyDelivered: false,
    } } })));
    expect(voiceRequests()).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-confirm-voice"]')).toBeNull();
  });

  it("does not start a private stream when the send body arrives after shared owner change", async () => {
    const body = Promise.withResolvers<unknown>();
    const response = Response.json({});
    const parse = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    await mountSession();
    await act(async () => { typeMessage("A delayed reply"); });
    await act(async () => { submitComposer(); releaseSend?.(response); });
    expect(parse).toHaveBeenCalledOnce();
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    await act(async () => { body.resolve(await sendPayload().json()); });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(container.textContent).not.toContain("hello there");
  });

  it("revokes private group history and speaker controls on shared owner change", async () => {
    await mountGroupSession();
    expect(container.textContent).toContain("I brought the blue notebook.");
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    expect(container.textContent).not.toContain("I brought the blue notebook.");
    expect(container.querySelector('[aria-label="Group speaker"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-header-avatars"] img')).toBeNull();
  });

  it("does not read a private conversation before account confirmation and recovers a failed initial check with Retry", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let unavailable = true;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      unavailable && String(input) === "/api/v1/me" ? Response.json({ ok: false }, { status: 503 }) : originalFetch(input, init));
    await act(async () => root.render(createElement(Fragment, null, createElement(ViewerProbe), createElement(ChatSessionClient, { id: "session-1" }))));
    await waitUntil(() => Boolean(container.querySelector('[role="alert"]')));
    expect(sessionReads).toBe(0);
    expect(container.textContent).not.toContain("Hey there.");
    unavailable = false;
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!.click());
    await waitUntil(() => Boolean(messageInput()));
    expect(container.textContent).toContain("Hey there.");
  });

  it("keeps anonymous visitors on the private-chat login path without reading a signed-in session", async () => {
    viewerId = null;
    await act(async () => root.render(createElement(Fragment, null, createElement(ViewerProbe), createElement(ChatSessionClient, { id: "session-1" }))));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="chat-session-auth-required"]')));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(sessionReads).toBe(0);
    expect(container.querySelector<HTMLAnchorElement>('a[href^="/login?"]')?.href).toContain("chat%2Fsession-1");
    expect(container.textContent).not.toContain("Hey there.");
  });

  it("retains a live session after StrictMode setup and still revokes it on a shared owner change", async () => {
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(ViewerProbe), createElement(ChatSessionClient, { id: "session-1" }))));
    await waitUntil(() => Boolean(messageInput()));
    await act(async () => { typeMessage("StrictMode private turn"); });
    await act(async () => { submitComposer(); releaseSend?.(sendPayload()); });
    await waitUntil(() => FakeEventSource.instances.length > 0);
    const source = FakeEventSource.instances.at(-1)!;
    viewerId = "viewer-b";
    await act(async () => { await sharedViewer.revalidate(); });
    expect(source.closed).toBe(true);
    expect(container.textContent).not.toContain("hello there");
  });

  it("keeps private history, draft and audio when shared revalidation confirms the same owner or has a network blip", async () => {
    const pause = vi.fn();
    vi.stubGlobal("Audio", class {
      constructor(public src: string) {}
      pause = pause;
      async play() {}
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let interrupted = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/generation/voice") return Response.json({ data: { contentUrl: "/voice/private.wav" } });
      if (interrupted && String(input) === "/api/v1/me") return Response.json({ ok: false }, { status: 503 });
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => typeMessage("Unsent draft"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    await act(async () => { await sharedViewer.revalidate(); });
    interrupted = true;
    await act(async () => { await sharedViewer.revalidate(); });
    expect(container.textContent).toContain("Hey there.");
    expect(messageInput()?.value).toBe("Unsent draft");
    expect(pause).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("clears private chat content and voice when focus loses access with %s", async status => {
    const pause = vi.fn();
    vi.stubGlobal("Audio", class {
      constructor(public src: string) {}
      pause = pause;
      async play() {}
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let inaccessible = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/generation/voice") return Response.json({ data: { contentUrl: "/voice/private.wav" } });
      if (inaccessible && url === "/api/v1/chat/sessions/session-1") return Response.json({ ok: false }, { status });
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    expect(container.textContent).toContain("Hey there.");
    expect(container.querySelector('[data-testid="chat-header-avatars"] img')).not.toBeNull();
    inaccessible = true;
    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(container.textContent).not.toContain("Hey there.");
    expect(container.querySelector('[data-testid="chat-header-avatars"] img')).toBeNull();
    expect(messageInput()).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
  });

  it.each(["network", "server"])("keeps the readable chat and voice through a focus %s failure", async failure => {
    const pause = vi.fn();
    vi.stubGlobal("Audio", class {
      constructor(public src: string) {}
      pause = pause;
      async play() {}
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let interrupted = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/generation/voice") return Response.json({ data: { contentUrl: "/voice/private.wav" } });
      if (interrupted && url === "/api/v1/chat/sessions/session-1") {
        if (failure === "network") throw new TypeError("Network connection lost");
        return Response.json({ ok: false }, { status: 503 });
      }
      return originalFetch(input, init);
    });
    await mountSession();
    await act(async () => typeMessage("Unsent draft"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    interrupted = true;
    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(container.textContent).toContain("Hey there.");
    expect(messageInput()?.value).toBe("Unsent draft");
    expect(pause).not.toHaveBeenCalled();
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

  it.each(["playing", "render pending", "quote pending"])("revokes %s voice when another page advances the reply attempt", async mode => {
    const pause = vi.fn();
    const playedUrls: string[] = [];
    vi.stubGlobal("Audio", class {
      constructor(public src: string) {}
      pause = pause;
      async play() { playedUrls.push(this.src); }
    });
    const tts = Promise.withResolvers<Response>();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/generation/voice/quote" && mode === "quote pending") return tts.promise;
      if (url === "/api/v1/generation/voice") return mode === "render pending"
        ? tts.promise : Response.json({ data: { contentUrl: "/voice/discarded.wav" } });
      return originalFetch(input, init);
    });
    sessionProactiveEnabled = true;
    sessionMessages = [opening, userTurn, { ...streamingReply, content: "Original answer", status: "sent" }];
    await mountSession();
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-play-voice"]')!.click());
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2, content: "Replacement answer", status: "sent" }];
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => Boolean(replyBubble()?.textContent?.includes("Replacement answer")));
    if (mode !== "playing") {
      await act(async () => tts.resolve(mode === "render pending"
        ? Response.json({ data: { contentUrl: "/voice/discarded.wav" } })
        : Response.json({ ok: true, data: { quote: {
          quoteToken: null, maxCostDreamcoins: 2, overflowCostDreamcoins: 2,
          allowanceMinutes: 30, remainingAllowanceMs: 60_000, balance: 100, accepted: true, alreadyDelivered: false,
        } } })));
    }

    if (mode === "playing") expect(pause).toHaveBeenCalledOnce();
    else expect(playedUrls).toEqual([]);
    if (mode === "quote pending") expect(voiceRequests()).toHaveLength(0);
    expect(replyBubble()?.querySelector('[data-testid="chat-play-voice"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a different history clip playing when another reply advances its attempt", async () => {
    const pause = vi.fn();
    vi.stubGlobal("Audio", class {
      constructor(public src: string) {}
      pause = pause;
      async play() {}
    });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === "/api/v1/generation/voice"
      ? Response.json({ data: { contentUrl: "/voice/opening.wav" } }) : originalFetch(input, init));
    sessionProactiveEnabled = true;
    sessionMessages = [opening, userTurn, { ...streamingReply, content: "Original answer", status: "sent" }];
    await mountSession();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-message-id="assistant-0"] [data-testid="chat-play-voice"]')!.click());
    sessionMessages = [opening, userTurn, { ...streamingReply, attempt: 2, content: "Replacement answer", status: "sent" }];
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => Boolean(replyBubble()?.textContent?.includes("Replacement answer")));

    expect(pause).not.toHaveBeenCalled();
    expect(container.querySelector('[data-message-id="assistant-0"] [data-testid="chat-play-voice"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not resurrect a deleted exchange from a focus read started during deletion", async () => {
    sessionMessages = [opening, userTurn, { ...streamingReply, content: "Reply being deleted", status: "sent" }];
    await mountSession();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const staleSnapshot = await originalFetch("/api/v1/chat/sessions/session-1");
    const deletion = Promise.withResolvers<Response>();
    const focusRead = Promise.withResolvers<Response>();
    let deferRead = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/messages/assistant-1" && init?.method === "DELETE") return deletion.promise;
      if (String(input) === "/api/v1/chat/sessions/session-1" && deferRead) {
        deferRead = false;
        return focusRead.promise;
      }
      return originalFetch(input, init);
    });
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-delete-message"]')!.click());
    await act(async () => replyBubble()?.querySelector<HTMLButtonElement>('[data-testid="chat-delete-message"]')!.click());
    deferRead = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => deletion.resolve(Response.json({ ok: true })));
    expect(replyBubble()).toBeNull();
    await act(async () => focusRead.resolve(staleSnapshot));

    expect(replyBubble()).toBeNull();
    expect(container.querySelector('[data-message-id="user-1"]')).toBeNull();
  });

  it("selects a group speaker through @ and sends one canonical request with that Character while preserving other speakers", async () => {
    await mountGroupSession();
    await act(async () => typeMessage("@Briar Hello from the garden"));
    await waitUntil(() => container.querySelector<HTMLSelectElement>('[aria-label="Group speaker"]')?.value === "character-2");
    expect(container.textContent).toContain("Avery");
    expect(container.textContent).toContain("No-memory");
    await act(async () => submitComposer());
    const sent = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === "/api/v1/chat/groups/group-1/messages" && init?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ content: "@Briar Hello from the garden", characterId: "character-2" });
    await act(async () => releaseSend?.(Response.json({ ok: true, data: {
      userMessage: { ...userTurn, content: "@Briar Hello from the garden", characterId: "character-2", sessionId: "member-2", speakerName: "Briar" },
      assistant: { ...streamingReply, characterId: "character-2", sessionId: "member-2", speakerName: "Briar" },
      streamUrl: "/api/v1/messages/assistant-1/stream?attempt=1",
    } })));
    await waitUntil(() => FakeEventSource.instances.length === 1);
    await act(async () => FakeEventSource.instances[0].emit("delta", { delta: "Briar speaking." }));
    expect(replyBubble()?.textContent).toContain("Briar");
    expect(replyBubble()?.textContent).toContain("Briar speaking.");
    expect(container.querySelector('[data-message-id="group-old-assistant"]')?.textContent).toContain("Avery");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Group speaker"]')?.disabled).toBe(true);
  });

  it("keeps the typed group message and explains itself when Enter lands during an @ speaker switch", async () => {
    await mountGroupSession();
    const groupFetch = vi.mocked(fetch).getMockImplementation()!;
    let releaseSpeaker: (() => void) | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("speaker=character-2") && !init?.method) {
        await new Promise<void>((resolve) => { releaseSpeaker = resolve; });
      }
      return groupFetch(input, init);
    });
    await act(async () => typeMessage("@Briar Hello from the garden"));
    await act(async () => submitComposer());

    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input) === "/api/v1/chat/groups/group-1/messages" && init?.method === "POST")).toBe(false);
    expect(messageInput()?.value).toBe("@Briar Hello from the garden");
    expect(container.querySelector('[data-testid="chat-session-status"]')?.textContent)
      .toContain("Selecting that Character");

    await act(async () => releaseSpeaker?.());
    await waitUntil(() => container.querySelector<HTMLSelectElement>('[aria-label="Group speaker"]')?.value === "character-2");
  });

  it("quotes an old group reply's voice using its original Character and session after the selected speaker changes", async () => {
    await mountGroupSession();
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Group speaker"]')!;
      select.value = "character-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitUntil(() => container.querySelector<HTMLSelectElement>('[aria-label="Group speaker"]')?.value === "character-2");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-message-id="group-old-assistant"] [data-testid="chat-play-voice"]')?.click());
    const quoted = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/generation/voice/quote");
    expect(JSON.parse(String(quoted?.[1]?.body))).toMatchObject({ characterId: "character-1", sessionId: "member-1", messageId: "group-old-assistant" });
  });

  it("offers actions on the proactive reply and none on the exchange it superseded", async () => {
    const sentReply = { ...streamingReply, turnId: "turn-1", content: "Hi.", status: "sent", attempt: 1 };
    const proactiveReply = {
      id: "assistant-2", turnId: "turn-2", role: "assistant", content: "The kiln's cooling.",
      status: "sent", attempt: 1, replyToMessageId: "hidden-directive",
    };
    sessionMessages = [opening, { ...userTurn, status: "sent" }, sentReply, proactiveReply];
    await mountSession();
    await waitUntil(() => Boolean(container.querySelector('[data-message-id="assistant-2"]')));

    const older = container.querySelector('[data-message-id="assistant-1"]');
    const olderUser = container.querySelector('[data-message-id="user-1"]');
    const proactive = container.querySelector('[data-message-id="assistant-2"]');
    // Main only revises the latest Turn; these would all be 409s.
    expect(olderUser?.querySelector('[data-testid="chat-edit-message"]')).toBeNull();
    expect(older?.querySelector('[data-testid="chat-regenerate"]')).toBeNull();
    expect(older?.querySelector('[data-testid="chat-delete-message"]')).toBeNull();
    expect(proactive?.querySelector('[data-testid="chat-regenerate"]')).not.toBeNull();
    expect(proactive?.querySelector('[data-testid="chat-delete-message"]')).not.toBeNull();
  });

  it("reads new proactive messages while the page stays open", async () => {
    sessionProactiveEnabled = true;
    await mountSession();
    await waitUntil(() => sessionReads > 0);
    const readsBefore = sessionReads;
    sessionMessages = [opening, {
      id: "assistant-2", turnId: "turn-2", role: "assistant", content: "The kiln's cooling.",
      status: "sent", attempt: 1, replyToMessageId: "hidden-directive",
    }];

    // Idle page, nothing generating: only the proactive poller is listening.
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => sessionReads > readsBefore);
    await waitUntil(() => Boolean(container.querySelector('[data-message-id="assistant-2"]')));
  });

  it("does not poll an idle page without proactive messages", async () => {
    await mountSession();
    await waitUntil(() => sessionReads > 0);
    const readsBefore = sessionReads;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(sessionReads).toBe(readsBefore);
  });

  it("keeps archived group history readable and deletable without exposing edit or regenerate", async () => {
    await mountGroupSession("archived");
    expect(container.textContent).toContain("This conversation is archived");
    expect(container.textContent).toContain("I brought the blue notebook.");
    expect(messageInput()?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="chat-edit-message"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-regenerate"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-delete-message"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-play-voice"]')).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "PATCH")).toBe(false);
  });

  it("shows the character's cover as a small header avatar", async () => {
    await mountSession();
    const avatars = [...container.querySelectorAll('[data-testid="chat-header-avatars"] img')];
    expect(avatars.map((image) => image.getAttribute("src"))).toEqual(["/media/avery-thumb.png"]);
  });

  it("shows the latest reply's scene under the header and hides it when there is none", async () => {
    const scene = (version: number, location: string) => ({
      schemaVersion: 1, version, location, time: "Late evening", participants: [], emotionalBeat: null, unresolvedThreads: [],
    });
    sessionMessages = [
      { ...opening, sceneVersion: 1, scene: scene(1, "Old harbor") },
      { id: "user-2", role: "user", content: "Walk with me.", status: "sent" },
      { id: "assistant-2", turnId: "turn-2", role: "assistant", content: "Sure.", status: "sent", attempt: 1, sceneVersion: 2, scene: scene(2, "Rooftop garden") },
    ];
    await mountSession();
    expect(container.querySelector('[data-testid="chat-scene"]')?.textContent).toBe("Scene · Rooftop garden · Late evening");
  });

  it("renders no scene line for a conversation without scene state", async () => {
    await mountSession();
    expect(container.querySelector('[data-testid="chat-scene"]')).toBeNull();
  });

  it("tells a new group how to start instead of inventing an opening line", async () => {
    await mountGroupSession("active", []);
    const empty = container.querySelector('[data-testid="group-chat-empty"]')?.textContent ?? "";
    expect(empty).toContain("Send a message to Avery");
    expect(empty).toContain("@mention Avery, Briar");
  });

  it("shows every group member's avatar in the header", async () => {
    await mountGroupSession();
    const avatars = [...container.querySelectorAll('[data-testid="chat-header-avatars"] img')];
    expect(avatars.map((image) => image.getAttribute("alt"))).toEqual(["Avery", "Briar"]);
  });

  async function mountGroupSession(status: "active" | "archived" = "active", messages?: unknown[]) {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const members = [{ characterId: "character-1", sessionId: "member-1", name: "Avery" }, { characterId: "character-2", sessionId: "member-2", name: "Briar" }];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/v1/chat/groups/group-1") && !init?.method) {
        const selected = new URL(url, "http://localhost").searchParams.get("speaker") === "character-2" ? members[1] : members[0];
        return Response.json({ ok: true, data: { session: {
          id: "group-1", ownerScope: "user:viewer-a", title: "Garden companions", status,
          characterId: selected.characterId, memoryEnabled: selected.characterId === "character-1",
          character: { name: selected.name, canUpdateIdentity: false }, group: { members, selectedSessionId: selected.sessionId },
          memberImages: { "character-1": "/media/avery-thumb.png", "character-2": "/media/briar-thumb.png" },
          messages: messages ?? [
            { id: "group-old-user", role: "user", content: "Avery, come to the garden.", status: "sent", characterId: "character-1", sessionId: "member-1", speakerName: "Avery" },
            { id: "group-old-assistant", turnId: "group-old-turn", role: "assistant", content: "I brought the blue notebook.", status: "sent", attempt: 1, replyToMessageId: "group-old-user", characterId: "character-1", sessionId: "member-1", speakerName: "Avery" },
          ],
        } } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(Fragment, null, createElement(ViewerProbe), createElement(ChatSessionClient, { id: "group-1", groupMode: true }))));
    await waitUntil(() => Boolean(container.querySelector('[aria-label="Group speaker"]')));
  }

  async function mountSession() {
    await act(async () => {
      root.render(createElement(Fragment, null, createElement(ViewerProbe), createElement(ChatSessionClient, { id: "session-1" })));
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
        streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=1",
      },
    });
  }

  function replyBubble() {
    return container.querySelector('[data-message-id="assistant-1"]');
  }

  function messageInput() {
    return container.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  }

  function typeMessage(value: string) {
    const input = messageInput();
    // Bypass React's value tracker so the change is not swallowed as a no-op.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
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
