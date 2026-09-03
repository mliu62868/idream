// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
import { CollectionDetail } from "./CollectionDetail";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function page(id: string, ids: string[], nextCursor: string | null, canManage = false) {
  return Response.json({ ok: true, data: {
    collection: { id, name: `${id} collection`, visibility: canManage ? "private" : "public", itemCount: 13 },
    canManage, items: ids.map((itemId) => ({ id: itemId, type: itemId === "video" ? "video" : "image", url: `/user-content/${itemId}/content.${itemId === "video" ? "mp4" : "png"}` })), nextCursor,
  } });
}
function mutation(id: string) { return Response.json({ ok: true, data: { removed: true, collection: { id, name: `${id} collection`, visibility: "private", itemCount: 1 } } }); }

describe("CollectionDetail", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(id = "a") { await act(async () => root.render(createElement(CollectionDetail, { id, key: id }))); }
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 2_000;
    while (!predicate()) { if (Date.now() > until) throw new Error(`Timed out: ${container.textContent}`); await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); }
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(found).toBeDefined(); return found!;
  }
  async function click(label: string) { await act(async () => button(label).click()); }

  it("loads the thirteenth video with native controls after the first twelve images", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("cursor=") ? page("a", ["video"], null) : page("a", Array.from({ length: 12 }, (_, i) => `image-${i + 1}`), "next+cursor"));
    vi.stubGlobal("fetch", fetcher);
    await render();
    await waitFor(() => container.querySelectorAll("img").length === 12);
    expect(container.querySelector('img[alt="Collection image 5"]')).not.toBeNull();
    await click("Load more items");
    await waitFor(() => Boolean(container.querySelector("video")));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/user-content/video/content.mp4");
    expect(container.querySelector("video")?.hasAttribute("controls")).toBe(true);
    expect(container.querySelectorAll('[data-testid="collection-detail-item"]')).toHaveLength(13);
    expect(container.textContent).not.toContain("Load more items");
    expect(container.textContent).not.toContain("Remove from collection");
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/media/collections/a?cursor=next%2Bcursor", expect.objectContaining({ cache: "no-store" }));
  });

  it("retains loaded members and retries exactly the failed next page", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("cursor=")) return page("a", ["first"], "next");
      return ++attempts === 1 ? Response.json({ ok: false, error: { code: "unavailable", message: "Try later" } }, { status: 503 }) : page("a", ["last"], null);
    }));
    await render(); await waitFor(() => Boolean(container.querySelector("img")));
    await click("Load more items"); await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.querySelector("img")?.getAttribute("src")).toContain("first");
    await click("Retry collection"); await waitFor(() => container.querySelectorAll("img").length === 2);
    expect(attempts).toBe(2);
  });

  it("ignores an old collection response after the selected link changes", async () => {
    let resolveOld!: (value: Response) => void;
    let oldSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/a")) { oldSignal = init?.signal ?? undefined; return new Promise<Response>((resolve) => { resolveOld = resolve; }); }
      return page("b", ["b-photo"], null);
    }));
    await render(); await render("b"); await waitFor(() => Boolean(container.querySelector("img")));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld(page("a", ["private-a"], null, true)));
    expect(container.textContent).toContain("b collection");
    expect(container.querySelector('img[src*="private-a"]')).toBeNull();
    expect(container.textContent).not.toContain("Save collection");
  });

  it("clears private content on focus and rejects a delayed response from the prior viewer", async () => {
    let calls = 0;
    let oldBody!: (value: unknown) => void;
    const oldResponse = Response.json({});
    vi.spyOn(oldResponse, "json").mockImplementation(() => new Promise((resolve) => { oldBody = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return page("a", ["visible-private"], null, true);
      if (calls === 2) return oldResponse;
      return Response.json({ ok: false, error: { code: "not_found", message: "Collection not found" } }, { status: 404 });
    }));
    await render(); await waitFor(() => Boolean(container.querySelector("img")));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => Boolean(oldBody));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    const stale = await page("a", ["old-private"], null, true).json();
    await act(async () => oldBody(stale));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("Save collection");
    expect(container.textContent).toContain("Collection not found");
  });

  it("drops an old page when the next request revokes access instead of retaining private members", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url).includes("cursor=")
      ? Response.json({ ok: false, error: { code: "not_found", message: "Collection not found" } }, { status: 404 })
      : page("a", ["private"], "next", true)));
    await render(); await waitFor(() => Boolean(container.querySelector("img")));
    await click("Load more items"); await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("Save collection");
  });

  it("keeps an item after a rejected remove and reloads authoritative members after success", async () => {
    let removeAttempts = 0;
    let removed = false;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (++removeAttempts === 1) return Response.json({ ok: false, error: { code: "conflict", message: "Try again" } }, { status: 409 });
        removed = true; return mutation("a");
      }
      return page("a", removed ? ["second"] : ["first", "second"], null, true);
    });
    vi.stubGlobal("fetch", fetcher);
    await render(); await waitFor(() => container.querySelectorAll("img").length === 2);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove item 1 from collection"]')!.click());
    await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.querySelectorAll("img")).toHaveLength(2);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove item 1 from collection"]')!.click());
    await waitFor(() => container.querySelectorAll("img").length === 1);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("second");
    expect(container.textContent).toContain("original media stays in your Gallery");
    expect(fetcher).toHaveBeenCalledWith("/api/v1/media/collections/a/items/first", expect.objectContaining({ method: "DELETE" }));
  });
});
