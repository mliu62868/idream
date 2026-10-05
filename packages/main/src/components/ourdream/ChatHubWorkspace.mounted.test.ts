// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHubWorkspace } from "./ChatHubWorkspace";
import { invalidateViewerAuthority } from "./viewer-auth";
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, viewer: string | null;
const ok = (data: unknown) => Response.json({ ok: true, data });
const session = (title: string, id = "session-1", status = "active", lastMessageAt = "2026-10-04T12:00:00.000Z") => ({ id, title, status, lastMessageAt, characterId: "character-1", memoryEnabled: true });
const read = (input: RequestInfo | URL) => {
  const path = String(input);
  if (path === "/api/v1/me") return ok({ user: viewer ? { id: viewer } : null });
  if (path === "/api/v1/chat/sessions") return Response.json([session(`Private ${viewer}`)]);
  if (path.startsWith("/api/v1/characters?")) return ok({ items: [], nextCursor: null });
  throw new Error(`Unexpected read ${path}`);
};
async function settle() { for (let i = 0; i < 8; i += 1) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
async function mount() { await act(async () => root.render(createElement(ChatHubWorkspace))); await settle(); }
const retry = () => [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === "Retry");
beforeEach(() => { viewer = "owner-a"; invalidateViewerAuthority(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ChatHubWorkspace private viewer lifecycle", () => {
  it("does not read private sessions for a guest and preserves the chat target in auth links", async () => {
    viewer = null; const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { reads.push(String(input)); return read(input); }));
    await mount(); expect(reads).not.toContain("/api/v1/chat/sessions"); expect(container.textContent).toContain("Sign in to see your chats");
    expect(container.querySelector('a[href="/login?next=%2Fchat"]')).not.toBeNull(); expect(container.querySelector('a[href="/signup?next=%2Fchat"]')).not.toBeNull();
  });
  it("reads private sessions only after confirming the account and attaches its fixed scope", async () => {
    let confirm!: (response: Response) => void; const scopes: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return new Promise<Response>(resolve => { confirm = resolve; });
      if (String(input) === "/api/v1/chat/sessions") scopes.push(new Headers(init?.headers).get("x-idream-viewer-scope"));
      return read(input);
    }));
    await mount(); expect(scopes).toEqual([]); await act(async () => confirm(ok({ user: { id: "owner-a" } }))); await settle();
    expect(scopes).toEqual(["user:owner-a"]); expect(container.textContent).toContain("Private owner-a");
  });
  it("does not read sessions for a malformed account confirmation", async () => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { reads.push(String(input)); return String(input) === "/api/v1/me" ? ok({ user: {} }) : read(input); }));
    await mount(); expect(reads).toEqual(["/api/v1/me"]); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(retry()).toBeDefined();
  });
  it("removes the old private title while the next account's list is pending", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/chat/sessions" && viewer === "owner-b"
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await mount(); expect(container.textContent).toContain("Private owner-a"); viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("Private owner-a"); expect(finish).toBeDefined();
    await act(async () => finish(Response.json([session("Private owner-b")]))); await settle(); expect(container.textContent).toContain("Private owner-b");
  });
  it("discards the previous account's late list even if its fetch ignores abort", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/chat/sessions" && viewer === "owner-a"
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await mount(); expect(finish).toBeDefined(); viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => finish(Response.json([session("Private owner-a late")]))); await settle();
    expect(container.textContent).toContain("Private owner-b"); expect(container.textContent).not.toContain("Private owner-a");
  });
  it("withdraws private sessions on signout and refreshes them after signin", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => read(input)));
    await mount(); viewer = null; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("Private owner-a"); expect(container.textContent).toContain("Sign in to see your chats");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); expect(container.textContent).toContain("Private owner-b");
  });
  it("recovers initial confirmation failure through the visible Retry button", async () => {
    let unavailable = true; const privateReads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me" && unavailable) return Response.json({ ok: false }, { status: 503 });
      if (String(input) === "/api/v1/chat/sessions") privateReads.push(String(input));
      return read(input);
    }));
    await mount(); expect(privateReads).toEqual([]); expect(retry()).toBeDefined(); unavailable = false;
    await act(async () => retry()!.click()); await settle(); expect(privateReads).toHaveLength(1); expect(container.textContent).toContain("Private owner-a");
  });
  it("refreshes same-account activity after focus and keeps archived but excludes deleted sessions", async () => {
    let refreshed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/chat/sessions"
      ? Response.json([session(refreshed ? "Recent reply" : "Initial reply", "s1"), session("Deleted private", "s2", "deleted"), session("Archived reply", "s3", "archived", "2026-10-03T12:00:00.000Z")]) : read(input)));
    await mount(); expect(container.textContent).not.toContain("Deleted private"); expect(container.textContent).toContain("Archived reply");
    refreshed = true; await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); expect(container.textContent).toContain("Recent reply"); expect(container.textContent).not.toContain("Initial reply");
    expect([...container.querySelectorAll('[data-testid="chat-hub-session"]')].map(item => item.getAttribute("href"))).toEqual(["/chat/s1", "/chat/s3"]);
  });
});
