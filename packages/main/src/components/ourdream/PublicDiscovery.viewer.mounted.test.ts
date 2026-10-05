// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommunityWorkspace } from "./CommunityWorkspace";
import { CreatorProfileClient } from "./CreatorProfileClient";
import { invalidateViewerAuthority } from "./viewer-auth";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./ComicCatalog", () => ({ ComicDiscovery: () => null }));
vi.mock("./AppTopbar", () => ({ AppTopbar: () => null }));
vi.mock("./AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./SiteFooter", () => ({ SiteFooter: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, viewer: string | null;
const ok = (data: unknown) => Response.json({ ok: true, data });
function read(input: RequestInfo | URL) {
  const path = String(input);
  if (path === "/api/v1/me") return ok({ user: viewer ? { id: viewer } : null });
  const creator = { id: "creator-c", displayName: "Creator C", image: null, isFollowing: viewer === "owner-a", isSelf: false, stats: { characters: 0, followers: 1, likes: "0", chats: "0" } };
  if (path.startsWith("/api/v1/creators/")) return ok({ creator, characters: [], nextCursor: null });
  if (path.includes("/leaderboards")) return ok({ leaderboards: { characters: [], dreamers: [{ id: creator.id, displayName: creator.displayName, image: null, characters: 0, followers: 1, likes: "0", chats: "0", isFollowing: creator.isFollowing, isSelf: false }] }, experimentAssignment: null });
  if (path.includes("/collections")) return ok({ collections: [], nextCursor: null });
  if (path.includes("/campaigns")) return ok({ campaigns: [] });
  throw new Error(`Unexpected read ${path}`);
}
beforeEach(() => { viewer = "owner-a"; invalidateViewerAuthority(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const follow = () => [...container.querySelectorAll("button")].find(button => /^(Follow|Following)$/.test(button.textContent?.trim() ?? ""));
async function settle() { for (let i = 0; i < 8; i += 1) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
async function mount(surface: "community" | "creator") { await act(async () => root.render(surface === "community" ? createElement(CommunityWorkspace) : createElement(CreatorProfileClient, { id: "creator-c" }))); await settle(); expect(follow()).toBeDefined(); }

describe.each(["community", "creator"] as const)("%s follows stay with their viewer", surface => {
  it("reports a failed account confirmation without sending a follow or changing its state", async () => {
    let unavailable = false;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me" && unavailable) return Response.json({ ok: false }, { status: 503 });
      if (String(input).endsWith("/follow")) { writes.push(String(input)); return ok({ following: false, followers: 1 }); }
      return read(input);
    }));
    await mount(surface); unavailable = true; await act(async () => follow()!.click()); await settle();
    expect(writes).toEqual([]);
    expect(follow()?.textContent?.trim()).toBe("Following");
    expect(container.textContent).toMatch(/Could not (update|save).*follow/i);
  });
  it("sends a guest to the selected creator through signup without an account mutation", async () => {
    viewer = null;
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/follow")) { writes.push(String(input)); viewer = "owner-b"; return ok({ following: true, followers: 2 }); }
      if (init?.method) throw new Error("Unexpected account write");
      return read(input);
    }));
    await mount(surface); await act(async () => follow()!.click()); await settle();
    expect(writes).toEqual([]);
    expect(navigate).toHaveBeenCalledWith("/signup?next=%2Fcreators%2Fcreator-c");
  });
  it("updates a same-account follow from the authoritative result with a fixed scope", async () => {
    const scopes: Array<string | null> = [];
    let following = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/follow")) { scopes.push(new Headers(init?.headers).get("x-idream-viewer-scope")); following = false; return ok({ following: false, followers: 7 }); }
      const response = read(input); const payload = await response.json();
      if (payload.data.creator) payload.data.creator.isFollowing = following;
      if (payload.data.leaderboards) payload.data.leaderboards.dreamers[0].isFollowing = following;
      return Response.json(payload);
    }));
    await mount(surface); await act(async () => follow()!.click()); await settle();
    expect(scopes).toEqual(["user:owner-a"]);
    expect(follow()?.textContent?.trim()).toBe("Follow");
  });
  it("discards an old account's late follow receipt", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/follow")
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await mount(surface); await act(async () => follow()!.click()); await settle(); expect(finish).toBeDefined();
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => finish(ok({ following: true, followers: 999 }))); await settle();
    expect(follow()?.textContent?.trim()).toBe("Follow");
    expect(container.textContent).not.toContain("999 followers");
  });
  it("replaces Following after focus confirms a different account", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => read(input)));
    await mount(surface); expect(follow()?.textContent?.trim()).toBe("Following");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(follow()?.textContent?.trim()).toBe("Follow");
  });
  it("refuses the previous viewer's follow command before focus arrives", async () => {
    const accepted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/follow")) return read(input);
      const expected = new Headers(init?.headers).get("x-idream-viewer-scope");
      if (expected && expected !== `user:${viewer}`) return Response.json({ ok: false }, { status: 409 });
      accepted.push(viewer!); return ok({ following: false, followers: 1 });
    }));
    await mount(surface); viewer = "owner-b"; await act(async () => follow()!.click()); await settle();
    expect(accepted).toEqual([]);
  });
});
