// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
import { CollectionDetail } from "./CollectionDetail";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function page(id: string, ids: string[], nextCursor: string | null, canManage = false, name = `${id} collection`, visibility = canManage ? "private" : "public") {
  return Response.json({ ok: true, data: {
    collection: { id, name, visibility, itemCount: 13 },
    canManage, items: ids.map((itemId) => ({ id: itemId, type: itemId === "video" ? "video" : "image", url: `/user-content/${itemId}/content.${itemId === "video" ? "mp4" : "png"}` })), nextCursor,
  } });
}
function mutation(id: string) { return Response.json({ ok: true, data: { removed: true, collection: { id, name: `${id} collection`, visibility: "private", itemCount: 1 } } }); }

describe("CollectionDetail", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(id = "a", onChanged?: () => void) { await act(async () => root.render(createElement(CollectionDetail, { id, key: id, onChanged }))); }
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 2_000;
    while (!predicate()) { if (Date.now() > until) throw new Error(`Timed out: ${container.textContent}`); await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); }
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(found).toBeDefined(); return found!;
  }
  async function click(label: string) { await act(async () => button(label).click()); }
  async function rename(value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  for (const method of ["PATCH", "DELETE"] as const) {
    it(`keeps a pending ${method} locked across focus and reloads after its actual commit`, async () => {
      let resolveWrite!: (value: Response) => void;
      let writeSignal: AbortSignal | null | undefined;
      let committed = false;
      let readCount = 0;
      const onChanged = vi.fn();
      const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === method) {
          writeSignal = init.signal;
          return new Promise<Response>((resolve) => { resolveWrite = resolve; });
        }
        readCount += 1;
        return page("a", committed && method === "DELETE" ? ["second"] : ["first", "second"], null, true, committed ? "Saved collection" : "a collection");
      });
      vi.stubGlobal("fetch", fetcher);
      await render("a", onChanged); await waitFor(() => Boolean(container.querySelector("form")));
      if (method === "PATCH") { await rename("Saved collection"); await click("Save collection"); }
      else await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove item 1 from collection"]')!.click());
      await waitFor(() => Boolean(resolveWrite));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await waitFor(() => readCount === 2 && Boolean(container.querySelector("form")));
      expect(writeSignal?.aborted).toBe(false);
      expect(button("Save collection").disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Remove item 1 from collection"]')?.disabled).toBe(true);
      expect(onChanged).not.toHaveBeenCalled();
      committed = true;
      await act(async () => resolveWrite(mutation("a")));
      await waitFor(() => readCount === 3 && !button("Save collection").disabled);
      expect(container.querySelector("h2")?.textContent).toBe("Saved collection");
      expect(container.querySelectorAll("img")).toHaveLength(method === "DELETE" ? 1 : 2);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  }

  it("does not project an old owner's delayed successful write after focus confirms another viewer", async () => {
    let resolveWrite!: (value: Response) => void;
    let owner = true;
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH"
      ? new Promise<Response>((resolve) => { resolveWrite = resolve; })
      : page("a", owner ? ["private"] : ["public"], null, owner)));
    await render("a", onChanged); await waitFor(() => Boolean(container.querySelector("form")));
    await rename("Private unfinished name"); await click("Save collection");
    await waitFor(() => Boolean(resolveWrite));
    owner = false;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => Boolean(container.querySelector('img[src*="public"]')));
    await act(async () => resolveWrite(mutation("a")));
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Collection updated.");
    expect(container.textContent).not.toContain("Private unfinished name");
    expect(onChanged).not.toHaveBeenCalled();
    owner = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => Boolean(container.querySelector("form")));
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("a collection");
  });

  it("preserves unsaved name and visibility on same-owner refresh, then clears them when access is lost", async () => {
    let owner = true;
    vi.stubGlobal("fetch", vi.fn(async () => owner ? page("a", ["image"], null, true)
      : Response.json({ ok: false, error: { code: "not_found", message: "Collection not found" } }, { status: 404 })));
    await render(); await waitFor(() => Boolean(container.querySelector("form")));
    await rename("Unsent name");
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => Boolean(container.querySelector("form")));
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Unsent name");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    owner = false;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.querySelector("form")).toBeNull();
    owner = true;
    await click("Retry collection"); await waitFor(() => Boolean(container.querySelector("form")));
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("a collection");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

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
    await render(); await waitFor(() => Boolean(oldSignal));
    await render("b"); await waitFor(() => Boolean(container.querySelector("img")));
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
