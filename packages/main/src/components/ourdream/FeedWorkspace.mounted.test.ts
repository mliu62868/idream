// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicFeedItem } from "@/lib/public-api-contracts";
import { FeedWorkspace } from "./FeedWorkspace";
import { invalidateViewerAuthority } from "./viewer-auth";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: ({ src, alt }: ComponentProps<"img">) => createElement("img", { src, alt }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
// This suite exercises Feed's real viewer gate; embedded Comic discovery has its own suite.
vi.mock("./ComicCatalog", () => ({ ComicDiscovery: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, container: HTMLDivElement, viewer: string | null;
const ok = (data: unknown) => Response.json({ ok: true, data });
const failedLike = () => Response.json({ ok: false, error: { message: "Controlled like failure" } }, { status: 503 });
function character(id: string, title: string, liked = false): PublicFeedItem {
  return { id: `character:${id}`, type: "character", character: { id, title, age: "24", description: "A public character.", likes: "0", chats: "0", creator: "Official", image: "/character.png", liked } };
}
function feed(owner = viewer) {
  // The service already applies each actor's muted tags. These snapshots model
  // different allowed cards, without pretending the client filters tags itself.
  return ok({ items: [character("shared", "Shared character", owner === "owner-a"), character(`${owner}-allowed`, `${owner} allowed character`)], nextCursor: null, focusedItemId: null });
}
function read(input: RequestInfo | URL) {
  const path = String(input);
  if (path === "/api/v1/me") return ok({ user: viewer ? { id: viewer } : null });
  if (path.startsWith("/api/v1/feed?")) return feed();
  throw new Error(`Unexpected read ${path}`);
}
beforeEach(() => {
  viewer = "owner-a"; invalidateViewerAuthority(); window.history.replaceState(null, "", "/feed");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function settle() { for (let i = 0; i < 6; i += 1) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
async function until(check: () => boolean) {
  for (let i = 0; i < 40; i += 1) { if (check()) return; await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
  expect(check()).toBe(true);
}
const sharedCard = () => [...container.querySelectorAll("article")].find(card => card.textContent?.includes("Shared character"));
const likeButton = () => sharedCard()?.querySelector<HTMLButtonElement>('[aria-label="Like"], [aria-label="Liked"]');
async function mount() { await act(async () => root.render(createElement(FeedWorkspace))); await until(() => Boolean(likeButton())); }
async function switchAccount() { viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); }

describe("Feed keeps personalized results and actions with their account", () => {
  it("rolls back an optimistic unlike when its account confirmation fails before any write", async () => {
    let unavailable = false;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me" && unavailable) return Response.json({ ok: false }, { status: 503 });
      if (String(input).endsWith("/like")) { writes.push(String(input)); return ok({ liked: false }); }
      return read(input);
    }));
    await mount(); unavailable = true; await act(async () => likeButton()!.click()); await settle();
    expect(writes).toEqual([]);
    expect(likeButton()?.getAttribute("aria-pressed")).toBe("true");
    expect(likeButton()?.disabled).toBe(false);
    expect(container.textContent).toContain("Could not save your like. Please try again.");
  });
  it.each(["Chat", "Like"])("does not submit a guest's %s under a newly signed-in cookie", async action => {
    viewer = null;
    const accepted: string[] = [];
    vi.spyOn(window.location, "assign").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return read(input);
      // The session changes after the preflight's anonymous answer, at the
      // actual write boundary. Main accepts a missing expected-user constraint.
      viewer = "owner-b";
      if (!new Headers(init.headers).has("x-idream-viewer-scope")) accepted.push(viewer);
      return String(input).endsWith("/like") ? ok({ liked: true }) : ok({ session: { id: "b-session" } });
    }));
    await mount(); await act(async () => sharedCard()!.querySelector<HTMLButtonElement>(`[aria-label="${action}"]`)!.click()); await settle();
    expect(accepted).toEqual([]);
  });
  it("loads and appends under the confirmed scope without losing a shared-item target", async () => {
    window.history.replaceState(null, "", "/feed?item=character%3Ashared");
    const reads: Array<{ path: string; scope: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/me") return read(input);
      reads.push({ path, scope: new Headers(init?.headers).get("x-idream-viewer-scope") });
      return path.includes("cursor=") ? ok({ items: [character("later", "Later character")], nextCursor: null, focusedItemId: null })
        : ok({ items: [character("shared", "Shared character")], nextCursor: "later-page", focusedItemId: "character:shared" });
    }));
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Load more")!.click());
    await until(() => container.textContent?.includes("Later character") === true);
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(reads).toEqual([
      { path: "/api/v1/feed?limit=8&item=character%3Ashared", scope: "user:owner-a" },
      { path: "/api/v1/feed?limit=8&cursor=later-page&item=character%3Ashared", scope: "user:owner-a" },
    ]);
  });

  it("shows a working retry for an initial account-check failure without an unconfirmed Feed read", async () => {
    let unavailable = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" && unavailable
      ? Response.json({ ok: false, error: { message: "Account check unavailable" } }, { status: 503 }) : read(input));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(FeedWorkspace)));
    await until(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.textContent).toContain("Account check unavailable");
    expect(container.textContent).not.toContain("Loading feed");
    expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith("/api/v1/feed"))).toHaveLength(0);
    unavailable = false;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Try again")!.click());
    await until(() => Boolean(likeButton()));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps an anonymous Chat request's character through signup and omits a user scope", async () => {
    viewer = null;
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/chat/sessions"
      ? Response.json({ ok: false, error: { message: "Sign in" } }, { status: 401 }) : read(input));
    vi.stubGlobal("fetch", fetcher);
    await mount();
    await act(async () => sharedCard()!.querySelector<HTMLButtonElement>('[aria-label="Chat"]')!.click());
    expect(navigate).toHaveBeenCalledWith("/signup?next=%2Fcharacters%2Fshared%3Fresume%3Dchat");
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(new Headers(init?.headers).has("x-idream-viewer-scope")).toBe(false);
  });

  it("keeps a pending optimistic unlike through confirmation refresh and rolls it back on failure", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/like")
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await mount(); await act(async () => likeButton()!.click()); await until(() => Boolean(finish));
    await settle(); expect(likeButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(likeButton()?.disabled).toBe(true);
    await act(async () => finish(failedLike())); await settle();
    expect(likeButton()?.getAttribute("aria-pressed")).toBe("true");
    expect(likeButton()?.disabled).toBe(false);
    expect(container.textContent).toContain("Controlled like failure");
  });

  it("abandons a late personalized read after another account has loaded", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/v1/feed?") && viewer === "owner-a"
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await act(async () => root.render(createElement(FeedWorkspace))); await until(() => Boolean(finish));
    await switchAccount(); await until(() => container.textContent?.includes("owner-b allowed character") === true);
    await act(async () => finish(feed("owner-a"))); await settle();
    expect(container.textContent).not.toContain("owner-a allowed character");
    expect(likeButton()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("replaces the previous account's liked state when focus confirms another viewer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => read(input)));
    await mount(); expect(likeButton()?.getAttribute("aria-pressed")).toBe("true");
    await switchAccount();
    expect(likeButton()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("replaces the previous account's muted-tag snapshot after an account change", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => read(input)));
    await mount(); expect(container.textContent).toContain("owner-a allowed character");
    await switchAccount();
    expect(container.textContent).not.toContain("owner-a allowed character");
    expect(container.textContent).toContain("owner-b allowed character");
  });

  it("refuses an old account's like when the cookie changes before focus arrives", async () => {
    const accepted: Array<{ owner: string | null; method: string | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/like")) return read(input);
      // Main checks an expected viewer before any account mutation.
      const expected = new Headers(init?.headers).get("x-idream-viewer-scope");
      if (expected !== null && expected !== `user:${viewer}`) return Response.json({ ok: false, error: { message: "Your account changed." } }, { status: 409 });
      accepted.push({ owner: viewer, method: init?.method });
      return ok({ liked: init?.method !== "DELETE" });
    }));
    await mount(); viewer = "owner-b";
    await act(async () => likeButton()!.click());
    await settle();
    expect(accepted).toEqual([]);
  });

  it("discards a previous account's late failed like instead of rolling back the new viewer", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/like")
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await mount(); await act(async () => likeButton()!.click()); await until(() => Boolean(finish));
    await switchAccount(); await act(async () => finish(failedLike())); await settle();
    expect(likeButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("Controlled like failure");
    expect(container.textContent).toContain("owner-b allowed character");
  });
});
