// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSearch } from "./AppSearch";
import { PublicCharacterStrip } from "./PublicCharacterStrip";
import { invalidateViewerAuthority } from "./viewer-auth";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/form", () => ({ default: ({ action, children, ...props }: ComponentProps<"form">) => createElement("form", { ...props, action: String(action) }, children) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, container: HTMLDivElement, viewer: string | null;
const ok = (data: unknown) => Response.json({ ok: true, data });
function responseFor(input: RequestInfo | URL) {
  if (String(input) === "/api/v1/me") return ok({ user: viewer ? { id: viewer } : null });
  const character = { id: `${viewer ?? "guest"}-character`, title: `${viewer ?? "guest"} preferred character`, age: "24", description: "Public.", likes: "0", chats: "0", creator: "Official", image: "/character.png" };
  // The same query has different public results because mute and For You
  // preferences belong to the current account, even though the cards are public.
  return String(input).startsWith("/api/v1/search/suggest")
    ? ok({ characters: [character], tags: [], routes: [] })
    : ok({ items: [character], nextCursor: null });
}
async function settle() { await act(async () => new Promise(resolve => setTimeout(resolve, 240))); for (let i = 0; i < 4; i += 1) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
async function mount(surface: "search" | "strip") {
  await act(async () => root.render(createElement(surface === "search" ? AppSearch : PublicCharacterStrip)));
  if (surface === "search") await act(async () => container.querySelector<HTMLInputElement>("input")!.focus());
  await settle();
}
beforeEach(() => { viewer = "owner-a"; push.mockClear(); invalidateViewerAuthority(); window.history.replaceState(null, "", "/?q=magic"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(["search", "strip"] as const)("%s public preferences", surface => {
  it("refreshes the same public query when focus confirms another account", async () => {
    const scopes: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/v1/me") scopes.push(new Headers(init?.headers).get("x-idream-viewer-scope"));
      return responseFor(input);
    }));
    await mount(surface); expect(container.textContent).toContain("owner-a preferred character");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("owner-a preferred character");
    expect(container.textContent).toContain("owner-b preferred character");
    expect(scopes).toEqual(["user:owner-a", "user:owner-b"]);
    if (surface === "search") expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("magic");
  });
  it("keeps anonymous public reads available without a signed-in scope", async () => {
    viewer = null;
    const scopes: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/v1/me") scopes.push(new Headers(init?.headers).get("x-idream-viewer-scope"));
      return responseFor(input);
    }));
    await mount(surface);
    expect(container.textContent).toContain("guest preferred character");
    expect(scopes).toEqual([null]);
  });
  it("offers a retry when the first account check fails before any public read", async () => {
    let unavailable = true;
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me" && unavailable) return Response.json({ ok: false }, { status: 503 });
      if (String(input) !== "/api/v1/me") reads.push(String(input));
      return responseFor(input);
    }));
    await mount(surface);
    expect(reads).toEqual([]);
    const retry = container.querySelector<HTMLButtonElement>(surface === "search" ? '[aria-label="Retry search suggestions"]' : '[aria-label="Retry public characters"]');
    expect(retry).not.toBeNull();
    unavailable = false; await act(async () => retry!.click()); await settle();
    expect(container.textContent).toContain("owner-a preferred character");
    expect(reads).toHaveLength(1);
  });
  it("ignores an old account's late response even when fetch ignores cancellation", async () => {
    let finish!: (response: Response) => void;
    let holdFirst = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/me" && holdFirst) {
        holdFirst = false;
        return new Promise<Response>(resolve => { finish = resolve; });
      }
      return responseFor(input);
    }));
    await mount(surface); expect(finish).toBeDefined();
    const oldResponse = responseFor(surface === "search" ? "/api/v1/search/suggest?q=magic" : "/api/v1/characters?sort=for-you&limit=4");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).toContain("owner-b preferred character");
    await act(async () => finish(oldResponse)); await settle();
    expect(container.textContent).not.toContain("owner-a preferred character");
    expect(container.textContent).toContain("owner-b preferred character");
  });
  it("refreshes changed preferences for the same confirmed account", async () => {
    let updated = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const response = responseFor(input);
      if (!updated || String(input) === "/api/v1/me") return response;
      const payload = await response.json();
      const cards = surface === "search" ? payload.data.characters : payload.data.items;
      cards[0].title = "updated preferred character";
      return Response.json(payload);
    }));
    await mount(surface); expect(container.textContent).toContain("owner-a preferred character");
    updated = true; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("owner-a preferred character");
    expect(container.textContent).toContain("updated preferred character");
  });
});

it("does not keyboard-select the previous account's suggestions while the next result is loading", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/v1/search/suggest") && viewer === "owner-b"
    ? new Promise<Response>(resolve => { finish = resolve; }) : responseFor(input)));
  await mount("search"); expect(container.textContent).toContain("owner-a preferred character");
  viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); expect(finish).toBeDefined();
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(push).not.toHaveBeenCalled();
  await act(async () => finish(responseFor("/api/v1/search/suggest?q=magic"))); await settle();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(push).toHaveBeenCalledWith("/characters/owner-b-character");
});
