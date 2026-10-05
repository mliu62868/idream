// @vitest-environment happy-dom
import { act, createElement, Fragment, useState, type ComponentProps } from "react";
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
function drawer(currentSessionId: string, open = true) { return createElement(ChatSessionListDrawer, { currentSessionId, open, onClose: () => {}, fetchForViewer: fetch }); }

function ControlledDrawer() {
  const [open, setOpen] = useState(false);
  return createElement(Fragment, {}, createElement("button", { onClick: () => setOpen(true), "data-testid": "drawer-opener" }, "Open your chats"),
    createElement(ChatSessionListDrawer, { currentSessionId: "session-1", open, onClose: () => setOpen(false), fetchForViewer: fetch }));
}

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
    vi.mocked(fetch).mockImplementation(async () => Response.json([{ ...rows[0], id: "new-session", title: "Current viewer chat" }]));
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
  it("reports archive acknowledgement once and discards an acknowledgement after the drawer scope changes", async () => {
    const onArchived = vi.fn();
    const base = vi.mocked(fetch).getMockImplementation()!;
    let releaseOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/archive") && init?.method === "POST"
      ? String(input).includes("session-1/") ? Promise.resolve(Response.json({ ...rows[0], status: "archived" })) : new Promise(resolve => { releaseOld = resolve; })
      : base(input, init));
    await act(async () => root.render(createElement(ChatSessionListDrawer, { currentSessionId: "session-1", open: true, onClose: () => {}, onArchived, fetchForViewer: fetch }))); await settle();
    const archive = container.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!;
    await act(async () => archive.click()); await act(async () => archive.click()); await settle();
    expect(onArchived).toHaveBeenCalledExactlyOnceWith("session-1");
    const other = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="session-archive"]')][1];
    await act(async () => other.click()); await act(async () => other.click());
    expect(releaseOld).toBeDefined();
    await act(async () => root.render(createElement(ChatSessionListDrawer, { currentSessionId: "session-3", open: true, onClose: () => {}, onArchived, fetchForViewer: fetch }))); await settle();
    await act(async () => releaseOld(Response.json({ ...rows[1], status: "archived" }))); await settle();
    expect(onArchived).toHaveBeenCalledTimes(1);
    expect(container.querySelector('a[href="/chat/session-2"]')?.textContent).not.toContain("Archived");
  });
  it.each([
    [409, { error: "conflict", message: "End your voice call before archiving this chat" }, "End your voice call before archiving this chat"],
    [400, { ok: false, error: { code: "bad_request", message: "  Choose a valid conversation before archiving.  " } }, "Choose a valid conversation before archiving."],
    [409, { error: "conflict", message: " " }, "Couldn't archive this chat."],
    [409, { error: "conflict", message: 42 }, "Couldn't archive this chat."],
    [409, null, "Couldn't archive this chat."],
    [503, { error: "service_unavailable", message: "Internal archive failure" }, "Couldn't archive this chat."],
  ])("shows the actionable archive rejection or safe fallback for status %s and never acknowledges it", async (status, payload, expected) => {
    const onArchived = vi.fn();
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/archive") && init?.method === "POST"
      ? Promise.resolve(Response.json(payload, { status })) : base(input, init));
    await act(async () => root.render(createElement(ChatSessionListDrawer, { currentSessionId: "session-1", open: true, onClose: () => {}, onArchived, fetchForViewer: fetch }))); await settle();
    const archive = container.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!;
    await act(async () => archive.click()); await act(async () => archive.click()); await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
    expect(container.querySelector('a[href="/chat/session-1"]')?.textContent).not.toContain("Archived");
    expect(onArchived).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("discards a late archive rejection body after the drawer session scope changes", async () => {
    let releaseBody!: (body: unknown) => void;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/archive") && init?.method === "POST"
      ? Promise.resolve({ ok: false, status: 409, json: () => new Promise(resolve => { releaseBody = resolve; }) } as Response)
      : base(input, init));
    await act(async () => root.render(drawer("session-1"))); await settle();
    const archive = container.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!;
    await act(async () => archive.click()); await act(async () => archive.click());
    expect(releaseBody).toBeDefined();
    await act(async () => root.render(drawer("session-2"))); await settle();
    await act(async () => releaseBody({ error: "conflict", message: "End your voice call before archiving this chat" })); await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('a[href="/chat/session-2"]')).not.toBeNull();
  });
  it("closes an archive confirmation on dialog Escape and returns focus to its opener without submitting", async () => {
    await act(async () => root.render(createElement(ControlledDrawer)));
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="drawer-opener"]')!;
    await act(async () => { opener.focus(); opener.click(); }); await settle();
    const archive = container.querySelector<HTMLButtonElement>('[data-testid="session-archive"]')!;
    await act(async () => { archive.focus(); archive.click(); });
    const dialog = container.querySelector<HTMLElement>('[aria-label="Your chats"]')!;
    await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(container.querySelector('[aria-label="Your chats"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await act(async () => opener.click()); await settle();
    expect(container.querySelector('[aria-label="Confirm archive chat"]')).toBeNull();
  });
  it("closes inline rename on Escape without its blur submitting the cancelled draft", async () => {
    await act(async () => root.render(createElement(ControlledDrawer)));
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="drawer-opener"]')!;
    await act(async () => { opener.focus(); opener.click(); }); await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-rename"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Rename chat"]')!;
    await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Cancelled rename"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[aria-label="Your chats"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });
});
