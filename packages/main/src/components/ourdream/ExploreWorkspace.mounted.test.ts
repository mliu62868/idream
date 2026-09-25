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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function settle() { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

// SPEC (EX-02): the Popular label names the window the list is ranked by, and
// the window travels in the URL and the request.
describe("Explore popular period", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: URLSearchParams[];
  beforeEach(() => {
    requests = [];
    window.history.replaceState(null, "", "/?sort=popular&period=week");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/characters") requests.push(url.searchParams);
      return Response.json({ ok: true, data: { items: [], nextCursor: null } });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

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
