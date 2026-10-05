// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => createElement("img", { alt }) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./AuthNav", () => ({ AuthNav: () => null }));
vi.mock("./MobileAppMenu", () => ({ MobileAppMenu: () => null }));
import { ExploreWorkspace } from "./ExploreWorkspace";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function settle() { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

// SPEC (EX-02): the Popular label names the window the list is ranked by, and
// the window travels in the URL and the request.
describe("Explore popular period", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: URLSearchParams[];
  beforeEach(() => {
    invalidateViewerAuthority();
    requests = [];
    window.history.replaceState(null, "", "/?sort=popular&period=week");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/me") return Response.json({ ok: true, data: { user: null } });
      if (url.pathname === "/api/v1/characters") requests.push(url.searchParams);
      return Response.json({ ok: true, data: { items: [], nextCursor: null } });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); });

  it("reads the period from the URL, shows it, and sends a changed period", async () => {
    await act(async () => root.render(createElement(ExploreWorkspace))); await settle();
    const sortButton = container.querySelector('[aria-label="Sort characters"]');
    const periodSelect = container.querySelector<HTMLSelectElement>('[aria-label="Popular period"]')!;
    expect(sortButton?.textContent).toBe("Popular · Week");
    expect(periodSelect.value).toBe("week");
    expect(requests.at(-1)?.get("period")).toBe("week");

    await act(async () => { periodSelect.value = "all"; periodSelect.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    expect(sortButton?.textContent).toBe("Popular · All time");
    expect(requests.at(-1)?.get("period")).toBe("all");
    expect(window.location.search).toContain("period=all");

    await act(async () => { periodSelect.value = "month"; periodSelect.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    // Month is the default window, so the URL leaves it out.
    expect(window.location.search).not.toContain("period=");
    expect(requests.at(-1)?.get("period")).toBe("month");
  });

  it("hides the period for sorts that are not windowed", async () => {
    window.history.replaceState(null, "", "/?sort=newest&period=week");
    await act(async () => root.render(createElement(ExploreWorkspace))); await settle();
    expect(container.querySelector('[aria-label="Popular period"]')).toBeNull();
    expect(requests.at(-1)?.has("period")).toBe(false);
  });
});

describe("Explore personalized discovery", () => {
  let root: Root, container: HTMLDivElement, viewer: string;
  beforeEach(() => {
    viewer = "owner-a"; invalidateViewerAuthority(); window.history.replaceState(null, "", "/?sort=following");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1/me") return Response.json({ ok: true, data: { user: { id: viewer } } });
      return path === "/api/v1/tags" ? Response.json({ ok: true, data: { items: [{ slug: `${viewer}-allowed`, label: `${viewer} allowed category`, isSensitive: false, isMutedByDefault: false, isMutedByUser: false, publicCharacterCount: 1 }] } })
        : Response.json({ ok: true, data: { items: [{ id: `${viewer}-character`, title: `${viewer} followed character`, age: "24", description: "Public.", likes: "0", chats: "0", creator: "Official", image: "/character.png" }], nextCursor: null } });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("offers an account-check retry after a first 503 and then restores cards", async () => {
    const fetcher = vi.mocked(fetch);
    const normalRead = fetcher.getMockImplementation()!;
    let unavailable = true;
    fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/v1/me" && unavailable
      ? Response.json({ ok: false, error: { message: "Account unavailable" } }, { status: 503 }) : normalRead(input, init));
    await act(async () => root.render(createElement(ExploreWorkspace))); await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Account unavailable");
    expect(container.textContent).not.toContain("Loading characters");
    expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith("/api/v1/characters"))).toHaveLength(0);
    unavailable = false;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click()); await settle();
    expect(container.textContent).toContain("owner-a followed character");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("replaces the previous account's Following characters after focus", async () => {
    await act(async () => root.render(createElement(ExploreWorkspace))); await settle();
    expect(container.textContent).toContain("owner-a followed character");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("owner-a followed character");
    expect(container.textContent).toContain("owner-b followed character");
    expect(window.location.search).toContain("sort=following");
  });
  it("replaces the previous account's visible categories after focus", async () => {
    await act(async () => root.render(createElement(ExploreWorkspace))); await settle();
    expect(container.textContent).toContain("owner-a allowed category");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("owner-a allowed category");
    expect(container.textContent).toContain("owner-b allowed category");
  });
});

describe("Explore dictionary slug authority", () => {
  let root: Root, container: HTMLDivElement, requests: URLSearchParams[], tagsFail: boolean;
  beforeEach(() => {
    invalidateViewerAuthority(); window.history.replaceState(null, "", "/"); requests = []; tagsFail = false;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/me") return Response.json({ ok: true, data: { user: null } });
      if (url.pathname === "/api/v1/tags") return tagsFail
        ? Response.json({ error: { message: "Tags unavailable" } }, { status: 503 })
        : Response.json({ ok: true, data: { items: [{ slug: "slow-burn", label: "Slow Burn Stories", isSensitive: false, isMutedByDefault: false, isMutedByUser: false, publicCharacterCount: 1 }] } });
      if (url.pathname === "/api/v1/characters") requests.push(url.searchParams);
      return Response.json({ ok: true, data: { items: [], nextCursor: null } });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); });
  async function mount() { await act(async () => root.render(createElement(ExploreWorkspace))); await settle(); }

  it("queries the dictionary slug when the user selects a renamed label", async () => {
    await mount();
    const chip = [...container.querySelectorAll("button")].find(button => button.textContent === "Slow Burn Stories");
    expect(chip).toBeDefined();
    await act(async () => chip!.click()); await settle();
    expect(requests.at(-1)?.get("tags")).toBe("slow-burn");
    expect(new URLSearchParams(window.location.search).get("tags")).toBe("slow-burn");
  });

  it("preserves the category slug deep link after same-owner revalidation", async () => {
    window.history.replaceState(null, "", "/?tags=slow-burn"); await mount();
    expect(container.textContent).toContain("Slow Burn Stories");
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(requests.at(-1)?.get("tags")).toBe("slow-burn");
    expect(new URLSearchParams(window.location.search).get("tags")).toBe("slow-burn");
  });

  it("distinguishes repeated labels and a tag named All from clearing the category", async () => {
    const normalRead = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/tags"
      ? Promise.resolve(Response.json({ ok: true, data: { items: [
        { slug: "mystery-a", label: "Mystery" }, { slug: "mystery-b", label: "Mystery" }, { slug: "all-stories", label: "All" },
      ].map(tag => ({ ...tag, isSensitive: false, isMutedByDefault: false, isMutedByUser: false, publicCharacterCount: 1 })) } }))
      : normalRead(input, init));
    await mount();
    const click = async (label: string) => {
      const chip = [...container.querySelectorAll("button")].find(button => button.textContent === label);
      expect(chip).toBeDefined(); await act(async () => chip!.click()); await settle();
    };
    await click("Mystery (mystery-b)");
    expect(requests.at(-1)?.get("tags")).toBe("mystery-b");
    await click("All (all-stories)");
    expect(requests.at(-1)?.get("tags")).toBe("all-stories");
    await click("All");
    expect(requests.at(-1)?.has("tags")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("tags")).toBe(false);
  });

  it("keeps generated labels distinct from another tag's literal label", async () => {
    const normalRead = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/tags"
      ? Promise.resolve(Response.json({ ok: true, data: { items: [
        { slug: "a", label: "All" }, { slug: "b", label: "All (a)" },
      ].map(tag => ({ ...tag, isSensitive: false, isMutedByDefault: false, isMutedByUser: false, publicCharacterCount: 1 })) } }))
      : normalRead(input, init));
    await mount();
    const chips = [...container.querySelectorAll("button")].filter(button => button.textContent?.startsWith("All"));
    expect(chips).toHaveLength(3);
    await act(async () => chips[2]!.click()); await settle();
    expect(requests.at(-1)?.get("tags")).toBe("b");
    expect(new URLSearchParams(window.location.search).get("tags")).toBe("b");
    expect(new Set(chips.map(button => button.textContent)).size).toBe(chips.length);
  });

  it("keeps an unavailable deep-link slug distinct from another tag's label", async () => {
    window.history.replaceState(null, "", "/?tags=secret");
    const normalRead = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/tags"
      ? Promise.resolve(Response.json({ ok: true, data: { items: [
        { slug: "other", label: "secret", isSensitive: false, isMutedByDefault: false, isMutedByUser: false, publicCharacterCount: 1 },
      ] } })) : normalRead(input, init));
    await mount();
    const chips = [...container.querySelectorAll("button")].filter(button => button.textContent?.startsWith("secret"));
    expect(chips).toHaveLength(2);
    await act(async () => chips[1]!.click()); await settle();
    expect(requests.at(-1)?.get("tags")).toBe("secret");
    expect(new URLSearchParams(window.location.search).get("tags")).toBe("secret");
    expect(new Set(chips.map(button => button.textContent)).size).toBe(chips.length);
  });

  it("keeps an explicit category during a dictionary outage without claiming all characters are shown", async () => {
    tagsFail = true; window.history.replaceState(null, "", "/?tags=slow-burn"); await mount();
    expect(requests.at(-1)?.get("tags")).toBe("slow-burn");
    expect(container.querySelector('[data-testid="explore-tags-status"]')?.textContent).not.toContain("Showing all public characters");
  });
});


describe("Explore public content types", () => {
  let root: Root, container: HTMLDivElement, viewer: string;
  let comicRead: (query: URLSearchParams) => Promise<Response>;
  let packRead: (query: URLSearchParams) => Promise<Response>;
  let reads: { path: string; query: URLSearchParams; scope: string | null }[];
  const comic = { id: "comic-public", title: "Published story", description: "Public story", visibility: "public", status: "published", allowRemix: false, version: 1, creator: { id: "creator", displayName: "Creator" }, pageCount: 1, episodeCount: 1, coverUrl: "/comic.png", updatedAt: "2026-10-04", publishedAt: "2026-10-04", canManage: false };
  const pack = { id: "pack-public", title: "Published Pack", description: "Public assets", visibility: "public", status: "published", version: 1, creator: { id: "creator", displayName: "Creator" }, itemCount: 1, coverUrl: "/pack.png", releaseId: "release", releaseVersion: 1, claimUntil: null, publishedAt: "2026-10-04", updatedAt: "2026-10-04", priceCents: 0, rights: "personal_view_download_current_only", canManage: false, canClaim: true };
  const response = (items: unknown[], nextCursor: string | null = null) => Response.json({ ok: true, data: { items, nextCursor } });
  beforeEach(() => {
    invalidateViewerAuthority(); viewer = "owner-a"; reads = [];
    window.history.replaceState(null, "", "/?sort=popular&period=week&gender=any&tags=slow-burn");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    comicRead = async () => response([comic]); packRead = async () => response([pack]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/me") return Response.json({ ok: true, data: { user: { id: viewer } } });
      if (url.pathname === "/api/v1/comics" || url.pathname === "/api/v1/packs") {
        reads.push({ path: url.pathname, query: url.searchParams, scope: new Headers(init?.headers).get("x-idream-viewer-scope") });
        return url.pathname === "/api/v1/comics" ? comicRead(url.searchParams) : packRead(url.searchParams);
      }
      return response([]);
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); });
  async function mount() { await act(async () => root.render(createElement(ExploreWorkspace))); await settle(); }
  const nav = () => container.querySelector<HTMLElement>('nav[aria-label="Explore content types"]');

  it("links to existing public catalogs and keeps All on the current Explore filters", async () => {
    await mount();
    const links = [...nav()!.querySelectorAll("a")];
    expect(links.map(link => link.textContent)).toEqual(["All", "Comics", "Packs"]);
    expect(links[1]!.getAttribute("href")).toBe("/comics"); expect(links[2]!.getAttribute("href")).toBe("/packs");
    const all = new URL(links[0]!.getAttribute("href")!, "http://localhost");
    expect(all.pathname).toBe("/"); expect(all.searchParams.get("tags")).toBe("slow-burn");
    expect(all.searchParams.get("period")).toBe("week"); expect(all.searchParams.get("gender")).toBe("any");
    expect(nav()!.textContent).not.toContain("Group Chats");
    expect(reads).toHaveLength(2); expect(reads.every(read => read.scope === "user:owner-a")).toBe(true);
    expect(reads.find(read => read.path.endsWith("packs"))!.query.get("scope")).toBe("public");
    expect(reads.some(read => ["mine", "claimed"].includes(read.query.get("scope") ?? ""))).toBe(false);
  });

  it.each(["empty", "503", "malformed", "private"])("does not expose dead or private type entries for %s catalogs", async (mode) => {
    if (mode === "empty") { comicRead = async () => response([]); packRead = async () => response([]); }
    if (mode === "503") { comicRead = packRead = async () => Response.json({ ok: false }, { status: 503 }); }
    if (mode === "malformed") { comicRead = packRead = async () => response([{ id: "unproven" }]); }
    if (mode === "private") { comicRead = async () => response([{ ...comic, visibility: "private", canManage: true }]); packRead = async () => response([{ ...pack, visibility: "private", canManage: true }]); }
    await mount();
    expect(nav()).not.toBeNull(); expect([...nav()!.querySelectorAll("a")].map(link => link.textContent)).toEqual(["All"]);
  });

  it("finds a published Comic beyond an empty filtered first page", async () => {
    comicRead = async query => query.get("cursor") ? response([comic]) : response([], "after-filtered-row"); packRead = async () => response([]);
    await mount();
    expect([...nav()!.querySelectorAll("a")].map(link => link.textContent)).toEqual(["All", "Comics"]);
    expect(reads.filter(read => read.path.endsWith("comics")).map(read => read.query.get("cursor"))).toEqual([null, "after-filtered-row"]);
  });

  it("stops a repeated empty cursor without exposing a type or issuing an unbounded read", async () => {
    comicRead = async () => response([], "repeated"); packRead = async () => response([]);
    await mount();
    expect(nav()).not.toBeNull(); expect(nav()!.textContent).not.toContain("Comics");
    expect(reads.filter(read => read.path.endsWith("comics"))).toHaveLength(2);
  });

  it("drops a late previous-owner catalog body after the new owner has no public results", async () => {
    let release!: (value: unknown) => void;
    const body = new Promise(resolve => { release = resolve; });
    comicRead = async () => ({ ok: true, json: () => body }) as Response; packRead = async () => response([]);
    await mount(); expect(reads.some(read => read.scope === "user:owner-a")).toBe(true);
    viewer = "owner-b"; comicRead = async () => response([]);
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => release({ ok: true, data: { items: [comic], nextCursor: null } })); await settle();
    expect(nav()).not.toBeNull(); expect([...nav()!.querySelectorAll("a")].map(link => link.textContent)).toEqual(["All"]);
    expect(reads.filter(read => read.scope === "user:owner-b")).toHaveLength(2);
  });

  it("removes an earlier type entry when a same-owner refresh cannot confirm public availability", async () => {
    await mount(); expect(nav()!.textContent).toContain("Comics");
    comicRead = async () => Response.json({ ok: false }, { status: 503 }); packRead = async () => response([]);
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect([...nav()!.querySelectorAll("a")].map(link => link.textContent)).toEqual(["All"]);
  });
});


describe("Explore navigation context", () => {
  let root: Root, container: HTMLDivElement, viewer: string, revision: string, requests: URLSearchParams[];
  let failSecond: boolean, failMe: boolean;
  const path = "/?sort=newest&gender=any&limit=1";
  const card = (index: number) => ({ id: `${viewer}-card-${index}`, title: `${viewer} ${revision} Character ${index}`, age: "24", description: "Public.", likes: "0", chats: "0", creator: "Official", image: "/character.png" });
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
    invalidateViewerAuthority();
    window.history.replaceState({ __NA: true, tree: "next-history-fixture" }, "", path);
    viewer = "owner-a"; revision = "original"; requests = []; failSecond = false; failMe = false;
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0, writable: true });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/me") return failMe ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, data: { user: { id: viewer } } });
      if (url.pathname === "/api/v1/characters") {
        requests.push(url.searchParams);
        const page = Number(url.searchParams.get("cursor") ?? "0") + 1;
        if (failSecond && page === 2) return Response.json({ ok: false }, { status: 503 });
        return Response.json({ ok: true, data: { items: [card(page)], nextCursor: page < 3 ? String(page) : null } });
      }
      return Response.json({ ok: true, data: { items: [], nextCursor: null } });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); window.localStorage.removeItem("idream.auth-change"); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  async function mount() { await act(async () => root.render(createElement(ExploreWorkspace))); await settle(); }
  async function loadThree() {
    await mount();
    for (let i = 0; i < 2; i++) { await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Load more")!.click()); await settle(); }
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(3);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1_212, writable: true });
    await act(async () => window.dispatchEvent(new Event("scroll"))); await settle();
  }
  async function leaveAndReturn() {
    const saved = window.history.state;
    window.history.pushState({ __NA: true, tree: "character-entry" }, "", "/characters/owner-a-card-3");
    await act(async () => root.unmount());
    expect(window.history.state).toEqual({ __NA: true, tree: "character-entry" });
    root = createRoot(container); window.history.replaceState(saved, "", path);
    requests = []; vi.mocked(window.scrollTo).mockClear();
  }

  it("reconfirms the owner and rereads every previously loaded page before restoring the Back position", async () => {
    await loadThree(); await leaveAndReturn(); revision = "fresh"; await mount();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(3);
    expect(container.textContent).toContain("owner-a fresh Character 3"); expect(container.textContent).not.toContain("original Character");
    expect(requests.map(query => query.get("cursor"))).toEqual([null, "1", "2"]);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1_212, left: 0, behavior: "instant" });
    expect(window.history.state).toMatchObject({ __NA: true, tree: "next-history-fixture" });
    expect(JSON.stringify(window.history.state)).not.toContain("owner-a");
    expect(JSON.stringify(window.history.state)).not.toContain("fresh Character");
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me").length).toBeGreaterThanOrEqual(2);
  });

  it.each(["owner", "auth", "storage", "history-cap"])("does not restore old context after %s invalidation", async mode => {
    await loadThree(); await leaveAndReturn();
    if (mode === "owner") viewer = "owner-b";
    if (mode === "auth") window.localStorage.setItem("idream.auth-change", "new-auth-nonce");
    if (mode === "storage") vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    if (mode === "history-cap" && window.history.state?.__idreamExplore) window.history.replaceState({ ...window.history.state, __idreamExplore: { ...window.history.state.__idreamExplore, pages: 999_999 } }, "", path);
    await mount();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(1);
    expect(requests.map(query => query.get("cursor"))).toEqual([null]);
    expect(window.scrollTo).not.toHaveBeenCalled();
    if (mode === "owner") { expect(container.textContent).toContain("owner-b original Character 1"); expect(container.textContent).not.toContain("owner-a"); }
  });

  it("keeps only freshly read cards on a failed restoration and offers a retry without moving the scroll", async () => {
    await loadThree(); await leaveAndReturn(); failSecond = true; revision = "fresh"; await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not restore");
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(1); expect(window.scrollTo).not.toHaveBeenCalled();
    failSecond = false;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click()); await settle();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1_212, left: 0, behavior: "instant" });
  });

  it("requires a fresh account confirmation before restoring and can retry that confirmation", async () => {
    await loadThree(); await leaveAndReturn(); failMe = true; await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not restore");
    expect(requests).toHaveLength(0); expect(window.scrollTo).not.toHaveBeenCalled();
    failMe = false;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click()); await settle();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(3);
  });

  it("abandons a previous owner's delayed restoration body without scrolling or writing the new history entry", async () => {
    await loadThree(); await leaveAndReturn();
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: unknown) => void; const body = new Promise(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes("cursor=1")
      ? Promise.resolve({ ok: true, json: () => body } as Response) : normal(input, init));
    await mount();
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => release({ ok: true, data: { items: [{ ...card(2), id: "owner-a-card-2", title: "Late private preference A" }], nextCursor: "2" } })); await settle();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(1);
    expect(container.textContent).toContain("owner-b original Character 1"); expect(container.textContent).not.toContain("Late private preference A");
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({ __NA: true, tree: "next-history-fixture" });
  });

  it("preserves checkpoint metadata when normalizing an equivalent URL and keeps Next's canonical filters current", async () => {
    await loadThree(); await leaveAndReturn();
    const originalReplace = window.history.replaceState.bind(window.history);
    const saved = window.history.state;
    const internal = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ["explore"] } };
    let canonicalHref = new URL("/?gender=any&limit=1&sort=newest", window.location.href).href;
    originalReplace({ ...saved, ...internal, customEntry: "preserved" }, "", canonicalHref);
    // Match Next 16's public native-history boundary: internal commits bypass
    // canonical URL updates; public writes copy the current framework tree.
    vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
      if (!data?.__NA && !data?._N && url) canonicalHref = new URL(String(url), window.location.href).href;
      originalReplace({ ...data, ...internal }, unused, url);
    });
    await mount();
    expect(window.history.state).toMatchObject({ ...internal, customEntry: "preserved", __idreamExplore: { pages: 3, scrollY: 1_212 } });
    const gender = container.querySelector<HTMLSelectElement>('[aria-label="Gender filter"]')!;
    expect(gender).not.toBeNull();
    await act(async () => { gender.value = "male"; gender.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    // A later real framework commit must retain the filter selected by the user.
    window.history.replaceState({ ...window.history.state, ...internal }, "", canonicalHref);
    expect(new URLSearchParams(window.location.search).get("gender")).toBe("male");
    expect(window.history.state).toMatchObject({ ...internal, customEntry: "preserved", __idreamExplore: { pages: 1 } });
    expect(requests.at(-1)?.get("gender")).toBe("male");
  });

  it("keeps the user's new scroll position when they scroll while Back pages are being restored", async () => {
    await loadThree(); await leaveAndReturn();
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: unknown) => void; const body = new Promise(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes("cursor=1")
      ? Promise.resolve({ ok: true, json: () => body } as Response) : normal(input, init));
    await mount();
    await act(async () => { window.dispatchEvent(new Event("wheel")); Object.defineProperty(window, "scrollY", { configurable: true, value: 222, writable: true }); window.dispatchEvent(new Event("scroll")); });
    await act(async () => release({ ok: true, data: { items: [card(2)], nextCursor: "2" } })); await settle();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(3);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(window.history.state.__idreamExplore).toMatchObject({ pages: 3, scrollY: 222 });
  });

  it("cancels a delayed Back page after the user chooses a different filter", async () => {
    await loadThree(); await leaveAndReturn();
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: unknown) => void; const body = new Promise(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes("cursor=1")
      ? Promise.resolve({ ok: true, json: () => body } as Response) : normal(input, init));
    await mount();
    const gender = container.querySelector<HTMLSelectElement>('[aria-label="Gender filter"]')!;
    await act(async () => { gender.value = "male"; gender.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    await act(async () => release({ ok: true, data: { items: [{ ...card(2), title: "Stale restored card" }], nextCursor: "2" } })); await settle();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("Stale restored card");
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(requests.at(-1)?.get("gender")).toBe("male");
    expect(window.history.state.__idreamExplore).toMatchObject({ pages: 1 });
  });

  it("reports a shorter fresh catalog instead of pretending the previous page count was restored", async () => {
    await loadThree(); await leaveAndReturn();
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes("cursor=1")
      ? (requests.push(new URL(String(input), "http://localhost").searchParams), Promise.resolve(Response.json({ ok: true, data: { items: [card(2)], nextCursor: null } }))) : normal(input, init));
    await mount();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("catalog changed");
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(requests.map(query => query.get("cursor"))).toEqual([null, "1"]);
  });

  it("does not replay a clipped older checkpoint after the loaded page count exceeds the restoration cap", async () => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/v1/characters") return normal(input, init);
      requests.push(url.searchParams);
      const page = Number(url.searchParams.get("cursor") ?? "0") + 1;
      return Promise.resolve(Response.json({ ok: true, data: { items: [card(page)], nextCursor: page < 62 ? String(page) : null } }));
    });
    await mount();
    for (let i = 0; i < 60; i++) {
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Load more")!.click());
    }
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(61);
    await leaveAndReturn(); await mount();
    expect(requests.map(query => query.get("cursor"))).toEqual([null]);
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(1);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("does not restart or duplicate pages when the same owner is confirmed during a restoration", async () => {
    await loadThree(); await leaveAndReturn();
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: unknown) => void; const body = new Promise(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes("cursor=1")
      ? Promise.resolve({ ok: true, json: () => body } as Response) : normal(input, init));
    await mount();
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => release({ ok: true, data: { items: [card(2)], nextCursor: "2" } })); await settle();
    expect(container.querySelectorAll('a[href^="/characters/"]')).toHaveLength(3);
    const characterCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/v1/characters"));
    expect(characterCalls.map(([input]) => new URL(String(input), "http://localhost").searchParams.get("cursor"))).toEqual([null, "1", "2", null, "1", "2"]);
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });
});
