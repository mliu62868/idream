// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
import { ChatHubWorkspace } from "./ChatHubWorkspace";
import { ChatSessionListDrawer } from "./chat/ChatSessionListDrawer";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const rows = Array.from({ length: 51 }, (_, index) => ({ id: `session-${index + 1}`, title: `Conversation ${index + 1}`, characterId: "character", status: index === 50 ? "archived" : "active", memoryEnabled: true, lastMessageAt: new Date(Date.UTC(2026, 8, 2, 0, 0, 51 - index)).toISOString() }));
beforeEach(() => {
  invalidateViewerAuthority();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async input => String(input) === "/api/v1/me"
    ? Response.json({ ok: true, data: { user: { id: "viewer" } } })
    : String(input) === "/api/v1/chat/sessions" ? Response.json([...rows, { ...rows[0], id: "deleted", status: "deleted" }])
    : Response.json({ ok: true, data: { items: [], nextCursor: null } })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function more() {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Load more chats");
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function drawer(currentSessionId: string, open = true) { return createElement(ChatSessionListDrawer, { currentSessionId, open, onClose: () => {} }); }

describe("Complete chat history navigation", () => {
  it("reveals the 51st archived session from the hub without changing its exact destination", async () => {
    await act(async () => root.render(createElement(ChatHubWorkspace))); await settle();
    expect(container.querySelectorAll('[data-testid="chat-hub-session"]')).toHaveLength(50);
    expect(container.querySelector('a[href="/chat/session-51"]')).toBeNull();
    await more();
    expect(container.querySelector('a[href="/chat/session-51"]')?.textContent).toContain("Conversation 51");
    expect(container.querySelector('a[href="/chat/session-51"]')?.textContent).toContain("Archived");
    expect(container.querySelector('a[href="/chat/deleted"]')).toBeNull();
    expect(container.textContent).not.toContain("Load more chats");
  });

  it("reveals older drawer sessions and resets the window when the drawer reopens", async () => {
    await act(async () => root.render(drawer("session-1"))); await settle();
    expect(container.querySelectorAll('[data-testid="session-list-item"]')).toHaveLength(50);
    await more();
    expect(container.querySelector('a[href="/chat/session-51"]')?.textContent).toContain("Conversation 51");
    await act(async () => root.render(drawer("session-1", false)));
    await act(async () => root.render(drawer("session-2"))); await settle();
    expect(container.querySelectorAll('[data-testid="session-list-item"]')).toHaveLength(50);
    expect(container.querySelector('a[href="/chat/deleted"]')).toBeNull();
  });

  it("ignores an old drawer load after switching to another session scope", async () => {
    let releaseOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
    await act(async () => root.render(drawer("old-session"))); await settle();
    vi.mocked(fetch).mockResolvedValue(Response.json([{ ...rows[0], id: "new-session", title: "Current viewer chat" }]));
    await act(async () => root.render(drawer("new-session"))); await settle();
    await act(async () => releaseOld(Response.json(rows)));
    expect(container.textContent).toContain("Current viewer chat");
    expect(container.textContent).not.toContain("Conversation 1");
  });

  it("does not let a previous scope's rename failure replace the new drawer state", async () => {
    await act(async () => root.render(drawer("session-1"))); await settle();
    let releaseRename!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "PATCH"
      ? new Promise(resolve => { releaseRename = resolve; })
      : Response.json([{ ...rows[0], id: "new-session", title: "Current viewer chat" }]));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-rename"]')!.click());
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Rename chat"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(releaseRename).toBeDefined();
    await act(async () => root.render(drawer("new-session"))); await settle();
    await act(async () => releaseRename(Response.json({ error: "old failure" }, { status: 500 })));
    expect(container.textContent).toContain("Current viewer chat");
    expect(container.textContent).not.toContain("Couldn't rename");
    expect(container.querySelector('input[aria-label="Rename chat"]')).toBeNull();
  });
});
