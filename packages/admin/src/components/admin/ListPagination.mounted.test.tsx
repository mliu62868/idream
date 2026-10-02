// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { AssetsListPage } from "./assets/AssetsListPage";
import { PlacementsListPage } from "./placements/PlacementsListPage";
import { RecipesListPage } from "./recipes/RecipesListPage";
import { PresetsListPage } from "./presets/PresetsListPage";
import { StartersListPage } from "./starters/StartersListPage";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), apiGet }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("./ui/AssetImage", () => ({ AssetImage: ({ asset }: { asset: { id: string } }) => <span>{asset.id}</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-10-01T00:00:00.000Z";
const cases: { name: string; route: string; view: () => ReactElement; item: (id: string) => unknown }[] = [
  { name: "Recipes", route: "/admin/ops/recipes", view: () => <RecipesListPage canWrite />, item: (id) => ({ id, recipeKey: id, label: id, mode: "image", useCase: "character", body: "", negativeBase: null, version: 1, status: "active", createdAt: timestamp, updatedAt: timestamp }) },
  { name: "Presets", route: "/admin/ops/recipes?view=presets", view: () => <PresetsListPage canWrite />, item: (id) => ({ id, scope: "built_in", type: "background", category: null, label: id, controls: {}, visibility: "public", status: "active" }) },
  { name: "Starters", route: "/admin/characters/starters", view: () => <StartersListPage canWrite={false} />, item: (id) => ({ id, scope: "built_in", name: id, summary: null, gender: null, style: null, appearance: {}, advancedDetails: {}, tags: [], isActive: true, sortOrder: 1 }) },
  { name: "Placements", route: "/admin/growth/merchandising?view=placements", view: () => <PlacementsListPage canPublish={false} />, item: (id) => ({ id, mediaAssetId: id, slot: "campaign", targetType: "campaign", targetId: id, status: "draft", version: 1, publishedAt: null, verificationState: "unverified", managedRunId: null, asset: { id, url: "/image.webp", thumbnailUrl: "/image.webp" } }) },
  { name: "Assets", route: "/admin/content/assets?targetId=character-1", view: () => <AssetsListPage canReview={false} />, item: (id) => ({ id, type: "image", url: "/image.webp", thumbnailUrl: "/image.webp", contentType: "image/webp", isSynthetic: false, customerPublishable: true, publishabilityReasons: [], width: 800, height: 1000, safetyStatus: "passed", sourceJobId: null, createdAt: timestamp, platformStatus: "approved", purpose: "character_cover", targetType: "character", targetId: "character-1", tags: [], description: id, promptSummary: null, metadata: {}, sourceJob: null, sourceBatch: null, placements: [] }) },
];

describe.each(cases)("$name forward cursor navigation", (testCase) => {
  let container: HTMLDivElement;
  let root: Root;
  const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
  function response(path: string) {
    const cursor = new URL(path, window.location.origin).searchParams.get("cursor");
    const page = cursor === "c1" ? 2 : cursor ? 3 : 1;
    return { items: [testCase.item(`row-${page}`)], pageInfo: { endCursor: page < 3 ? `c${page}` : null, hasNextPage: page < 3 } };
  }
  async function settle() {
    for (let tick = 0; tick < 3; tick += 1) await act(async () => { await vi.advanceTimersByTimeAsync(251); });
  }
  async function mount() { await act(async () => root.render(testCase.view())); await settle(); }
  async function click(label: string) { expect(button(label)).toBeDefined(); await act(async () => button(label).click()); await settle(); }
  function lastParams() { return new URL(apiGet.mock.calls.at(-1)![0], window.location.origin).searchParams; }

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", testCase.route);
    apiGet.mockReset().mockImplementation(async (path) => response(path));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

  it("reads preceding pages after remounting through forward cursors and keeps adjacent URL state", async () => {
    await mount(); await click("Next page"); await click("Next page");
    expect(container.textContent).toContain("row-3");
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(button("Previous page").disabled).toBe(false);
    await click("Previous page"); expect(lastParams().get("cursor")).toBe("c1"); expect(container.textContent).toContain("row-2");
    await click("Previous page"); expect(lastParams().has("cursor")).toBe(false); expect(container.textContent).toContain("row-1");
    expect(button("Previous page").disabled).toBe(true);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 1");
    const original = new URL(testCase.route, window.location.origin).searchParams;
    for (const key of ["view", "targetId"]) if (original.has(key)) expect(new URLSearchParams(window.location.search).get(key)).toBe(original.get(key));
    expect(apiGet.mock.calls.every(([path]) => !new URL(path, window.location.origin).searchParams.has("before"))).toBe(true);
  });

  it("offers an explicit first-page return for a deep link without cursor history", async () => {
    const url = new URL(testCase.route, window.location.origin); url.searchParams.set("cursor", "cold-cursor"); url.searchParams.set("page", "5");
    window.history.replaceState(null, "", url);
    await mount(); expect(container.textContent).toContain("row-3");
    expect(button("Back to first page").disabled).toBe(false);
    await click("Back to first page");
    expect(lastParams().has("cursor")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 1");
  });

  it("resets cursor history with a new filter and returns within the new query", async () => {
    await mount(); await click("Next page");
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label^="Search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "new-query");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }); await settle();
    expect(lastParams().get("search")).toBe("new-query"); expect(lastParams().has("cursor")).toBe(false);
    expect(button("Previous page").disabled).toBe(true);
    await click("Next page"); await click("Previous page");
    expect(lastParams().get("search")).toBe("new-query"); expect(lastParams().has("cursor")).toBe(false);
  });

  it("refreshes a pending page from the shell, ignores its older failure, and restores browser Back", async () => {
    await mount();
    let rejectOld!: (reason: Error) => void;
    apiGet.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    await click("Next page");
    expect(new URLSearchParams(window.location.search).get("cursor")).toBe("c1");
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))); await settle();
    expect(container.textContent).toContain("row-2");
    await act(async () => rejectOld(new Error("older page read failed")));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => window.history.back()); await settle();
    expect(lastParams().has("cursor")).toBe(false); expect(container.textContent).toContain("row-1");
  });

  it("rereads an identical URL on popstate rather than leaving an invalidated read stuck", async () => {
    await mount(); const calls = apiGet.mock.calls.length;
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate"))); await settle();
    expect(apiGet).toHaveBeenCalledTimes(calls + 1);
    expect(container.textContent).toContain("row-1");
    expect(button("Next page").disabled).toBe(false);
  });
});
