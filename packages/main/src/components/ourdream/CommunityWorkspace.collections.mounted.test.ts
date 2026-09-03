// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: () => null }));
const location = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(location.search) }));
vi.mock("./CollectionDetail", () => ({ CollectionDetail: () => null }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./ReportDialog", () => ({ useReportDialog: () => ({ openReport: vi.fn(), reportDialog: null }) }));
import { CommunityWorkspace } from "./CommunityWorkspace";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function collections(ids: string[], nextCursor: string | null) {
  return Response.json({ ok: true, data: { collections: ids.map((id) => ({ id, name: id, visibility: "public", itemCount: 1, previews: [{ id: `${id}-image`, type: "image", url: "/image.png" }] })), nextCursor } });
}
describe("Community public collection pages", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { location.search = ""; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 2_000;
    while (!predicate()) { if (Date.now() > until) throw new Error(`Timed out: ${container.textContent}`); await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); }
  }
  async function more() {
    const button = [...container.querySelectorAll("button")].find((item) => /Show more collections|Retry more collections/.test(item.textContent ?? ""));
    expect(button).toBeDefined(); await act(async () => button!.click());
  }
  const cards = () => container.querySelectorAll('[data-testid="community-collection-card"]');
  function installFetcher(next: () => Response) {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/collections?cursor=")) return next();
      if (url.endsWith("/collections")) return collections(Array.from({ length: 20 }, (_, i) => `collection-${i + 1}`), "page+2");
      if (url.includes("/campaigns")) return Response.json({ ok: true, data: { campaigns: [] } });
      return Response.json({ ok: true, data: { leaderboards: { characters: [], dreamers: [] }, experimentAssignment: null } });
    });
    vi.stubGlobal("fetch", fetcher); return fetcher;
  }
  it("loads the twenty-first collection from the next server page and opens details", async () => {
    const fetcher = installFetcher(() => collections(["collection-21"], null));
    await act(async () => root.render(createElement(CommunityWorkspace)));
    await waitFor(() => cards().length === 3);
    for (let count = 0; count < 6; count += 1) await more();
    expect(cards()).toHaveLength(20);
    await more(); await waitFor(() => cards().length === 21);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/community/collections?cursor=page%2B2", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector('a[href="/community?collection=collection-21"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Show more collections");
  });
  it("keeps all loaded cards on a page failure and retries the same cursor", async () => {
    let attempts = 0;
    installFetcher(() => ++attempts === 1 ? Response.json({ ok: false }, { status: 503 }) : collections(["collection-21"], null));
    await act(async () => root.render(createElement(CommunityWorkspace)));
    await waitFor(() => cards().length === 3);
    for (let count = 0; count < 7; count += 1) await more();
    await waitFor(() => Boolean(container.textContent?.includes("Retry more collections")));
    expect(cards()).toHaveLength(20);
    await more(); await waitFor(() => cards().length === 21);
    expect(attempts).toBe(2);
  });

  it("discards an old cursor during collection URL changes and waits for the new first page", async () => {
    let firstPage!: (value: Response) => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/community/collections?collection=new-focus") return new Promise<Response>((resolve) => { firstPage = resolve; });
      if (url.includes("/collections?cursor=")) return collections(["new-last"], null);
      if (url.endsWith("/collections")) return collections(Array.from({ length: 20 }, (_, i) => `old-${i}`), "old-cursor");
      if (url.includes("/campaigns")) return Response.json({ ok: true, data: { campaigns: [] } });
      return Response.json({ ok: true, data: { leaderboards: { characters: [], dreamers: [] }, experimentAssignment: null } });
    });
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(CommunityWorkspace)));
    await waitFor(() => cards().length === 3);
    for (let count = 0; count < 6; count += 1) await more();
    expect(cards()).toHaveLength(20);
    location.search = "collection=new-focus";
    await act(async () => root.render(createElement(CommunityWorkspace)));
    await waitFor(() => Boolean(firstPage));
    expect(cards()).toHaveLength(0);
    const staleMore = [...container.querySelectorAll("button")].find((item) => item.textContent === "Show more collections");
    if (staleMore) {
      expect(staleMore.disabled).toBe(true);
      await act(async () => staleMore.click());
    }
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("cursor="))).toHaveLength(0);
    await act(async () => firstPage(collections(["new-first"], "new-cursor")));
    await waitFor(() => cards().length === 1);
    expect(cards()[0]?.textContent).toContain("new-first");
    await more(); await waitFor(() => cards().length === 2);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/community/collections?cursor=new-cursor", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.textContent).not.toContain("old-0");
    expect(container.textContent).toContain("new-last");
  });
});
