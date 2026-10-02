// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: ComponentProps<"a">) => createElement("a", { href: String(href), ...props }, children) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/helpdesk", useSearchParams: () => new URLSearchParams() }));
import { AuthNav } from "./AuthNav";
import { fetchViewerScope, invalidateViewerAuthority } from "./viewer-auth";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("cross-tab account changes", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewer: string | null;
  let reload: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    viewer = "account-a";
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) });
    invalidateViewerAuthority();
    reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    vi.spyOn(window.location, "assign").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => {
      if (String(path) === "/api/v1/auth/logout") { viewer = null; return Response.json({ ok: true }); }
      return Response.json({ ok: true, data: { user: viewer ? { id: viewer, displayName: viewer, email: `${viewer}@example.test`, image: null } : null, anonymousId: "anonymous-1" } });
    }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root?.unmount()); container?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); invalidateViewerAuthority();
  });
  async function settle() { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
  async function mount() { await act(async () => root.render(createElement(AuthNav))); await settle(); }
  it("discards the whole stale workspace after an auth change in another tab", async () => {
    await mount();
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated-key", newValue: "x", storageArea: window.localStorage }));
    expect(reload).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "idream.auth-change", newValue: "new-auth", storageArea: window.localStorage })));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("rechecks identity on focus when a broadcast was unavailable", async () => {
    await mount(); expect(container.textContent).toContain("account-a");
    viewer = "account-b";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("broadcasts successful logout and invalidates cached authority before navigation", async () => {
    await mount(); expect(await fetchViewerScope()).toBe("user:account-a");
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Log out")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await settle();
    expect(window.localStorage.getItem("idream.auth-change")).toBeTruthy();
    expect(await fetchViewerScope()).toBe("anonymous:anonymous-1");
  });
});
