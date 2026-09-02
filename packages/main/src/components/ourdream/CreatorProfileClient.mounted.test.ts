// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./SiteFooter", () => ({ SiteFooter: () => null }));
vi.mock("./CharacterCard", () => ({ CharacterCard: ({ card }: { card: { id: string; title: string } }) => createElement("a", { href: `/characters/${card.id}` }, card.title) }));
import { CreatorProfileClient } from "./CreatorProfileClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function page(creatorId: string, ids: string[], nextCursor: string | null) {
  return Response.json({ ok: true, data: {
    creator: { id: creatorId, displayName: creatorId, image: null, isFollowing: false, isSelf: false, stats: { characters: 25, followers: 0, likes: "0", chats: "0" } },
    characters: ids.map((id) => ({ id, title: id, age: "25", image: "/image.png", description: "A public character.", likes: "0", chats: "0", creator: creatorId, liked: false })),
    nextCursor,
  } });
}

describe("CreatorProfileClient pagination", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(id = "creator-a") {
    await act(async () => root.render(createElement(CreatorProfileClient, { id })));
  }
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${container.textContent}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  function moreButton() {
    const result = [...container.querySelectorAll("button")].find((item) => /Load more characters/.test(item.textContent ?? ""));
    expect(result).toBeDefined();
    return result!;
  }
  async function clickMore() {
    await act(async () => moreButton().click());
  }

  it("appends the final page and removes the load-more action when exhausted", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("cursor=")
      ? page("creator-a", ["character-25"], null)
      : page("creator-a", Array.from({ length: 24 }, (_, i) => `character-${i + 1}`), "next+cursor"));
    vi.stubGlobal("fetch", fetcher);
    await render();
    await waitFor(() => container.querySelectorAll('a[href^="/characters/"]').length === 24);
    await clickMore();
    await waitFor(() => container.querySelectorAll('a[href^="/characters/"]').length === 25);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/creators/creator-a?cursor=next%2Bcursor", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.textContent).not.toContain("Load more characters");
  });

  it("keeps the current cards and cursor after a page error, then retries the same page", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("cursor=")) return page("creator-a", ["first"], "next");
      if (++attempts === 1) return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
      return page("creator-a", ["last"], null);
    }));
    await render();
    await waitFor(() => Boolean(container.querySelector('a[href="/characters/first"]')));
    await clickMore();
    await waitFor(() => Boolean(container.textContent?.includes("Could not load more characters")));
    expect(container.querySelector('a[href="/characters/first"]')).not.toBeNull();
    await clickMore();
    await waitFor(() => Boolean(container.querySelector('a[href="/characters/last"]')));
    expect(attempts).toBe(2);
  });

  it("aborts an old creator page and never appends it under the next creator", async () => {
    let resolveOld!: (value: Response) => void;
    let oldSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("cursor=")) {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      }
      return String(input).includes("creator-b") ? page("creator-b", ["b-first"], null) : page("creator-a", ["a-first"], "next");
    }));
    await render();
    await waitFor(() => Boolean(container.querySelector('a[href="/characters/a-first"]')));
    await clickMore();
    await render("creator-b");
    await waitFor(() => Boolean(container.querySelector('a[href="/characters/b-first"]')));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld(page("creator-a", ["a-last"], null)));
    expect(container.querySelector('a[href="/characters/a-first"]')).toBeNull();
    expect(container.querySelector('a[href="/characters/a-last"]')).toBeNull();
  });

  it("restarts from the first page when the server rejects a stale view cursor", async () => {
    let firstPages = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("cursor=")) return Response.json({ error: { message: "Viewer filters changed" } }, { status: 400 });
      firstPages += 1;
      return page("creator-a", [firstPages === 1 ? "old-view" : "new-view"], firstPages === 1 ? "old-cursor" : null);
    }));
    await render();
    await waitFor(() => Boolean(container.querySelector('a[href="/characters/old-view"]')));
    await clickMore();
    await waitFor(() => Boolean(container.textContent?.includes("Refresh creator profile")));
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh creator profile")!;
    await act(async () => refresh.click());
    await waitFor(() => Boolean(container.querySelector('a[href="/characters/new-view"]')));
    expect(container.querySelector('a[href="/characters/old-view"]')).toBeNull();
    expect(firstPages).toBe(2);
  });
});
