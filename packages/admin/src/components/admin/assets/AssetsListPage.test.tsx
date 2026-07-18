// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentAsset } from "./assets-api";

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet }));
vi.mock("@/components/admin/i18n", () => ({
  useAdminI18n: () => ({
    t: (value: string, replacements?: Record<string, string | number>) =>
      Object.entries(replacements ?? {}).reduce(
        (text, [key, replacement]) => text.replaceAll(`{${key}}`, String(replacement)),
        value,
      ),
    value: (value: string) => value.replaceAll("_", " "),
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("@/components/admin/ui/AssetImage", () => ({
  AssetImage: ({ asset }: { asset: ContentAsset }) => <div data-image-id={asset.id} />,
}));

import { AssetsListPage } from "./AssetsListPage";

type ListResponse = {
  readonly items: readonly ContentAsset[];
  readonly pageInfo: { readonly endCursor: string | null; readonly hasNextPage: boolean };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function asset(id: string, status: string): ContentAsset {
  return {
    id,
    type: "image",
    url: `/assets/${id}.webp`,
    thumbnailUrl: `/assets/${id}-thumb.webp`,
    isSynthetic: false,
    customerPublishable: true,
    publishabilityReasons: [],
    width: 800,
    height: 1_000,
    safetyStatus: "passed",
    sourceJobId: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    platformStatus: status,
    purpose: "character_cover",
    targetType: "character",
    targetId: "character-1",
    tags: [],
    description: id,
    sourceJob: null,
    sourceBatch: null,
    placements: [],
  };
}

const response = (item: ContentAsset): ListResponse => ({
  items: [item],
  pageInfo: { endCursor: null, hasNextPage: false },
});

const listResponse = (...items: ContentAsset[]): ListResponse => ({
  items,
  pageInfo: { endCursor: null, hasNextPage: false },
});

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Asset list state");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function findButton(label: string, root: ParentNode = document) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === label) ?? null;
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AssetsListPage request authority", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/admin/content/assets");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiGet.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears stale clickable cards immediately and ignores an older inverse-order response", async () => {
    const approved = deferred<ListResponse>();
    const rejected = deferred<ListResponse>();
    apiGet.mockImplementation((path) => {
      if (path.includes("status=approved")) return approved.promise;
      if (path.includes("status=rejected")) return rejected.promise;
      return Promise.resolve(response(asset("old-card", "generated")));
    });

    await act(async () => root.render(<AssetsListPage />));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/old-card"]') !== null);

    const status = container.querySelector<HTMLSelectElement>('select[aria-label="Status"]');
    expect(status).not.toBeNull();
    await act(async () => {
      (status as HTMLSelectElement).value = "approved";
      (status as HTMLSelectElement).dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('a[href="/admin/content/assets/old-card"]')).toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    await waitUntil(() => apiGet.mock.calls.some(([path]) => path.includes("status=approved")));

    await act(async () => {
      (status as HTMLSelectElement).value = "rejected";
      (status as HTMLSelectElement).dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitUntil(() => apiGet.mock.calls.some(([path]) => path.includes("status=rejected")));

    rejected.resolve(response(asset("latest-card", "rejected")));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/latest-card"]') !== null);
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("false");

    approved.resolve(response(asset("stale-card", "approved")));
    await act(async () => { await approved.promise; });
    expect(container.querySelector('a[href="/admin/content/assets/latest-card"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/content/assets/stale-card"]')).toBeNull();
  });

  it("selects only archive-eligible cards and clears the current page selection", async () => {
    apiGet.mockResolvedValue(listResponse(
      asset("asset-b", "approved"),
      asset("asset-a", "generated"),
      asset("asset-archived", "archived"),
    ));

    await act(async () => root.render(<AssetsListPage />));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/asset-a"]') !== null);

    await click(findButton("Select page", container));
    await waitUntil(() => container.textContent?.includes("2 selected") === true);

    expect(container.querySelector<HTMLInputElement>('input[aria-label="Select asset asset-a"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Select asset asset-b"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Select asset asset-archived"]')?.disabled).toBe(true);

    await click(findButton("Clear selection", container));
    await waitUntil(() => container.textContent?.includes("0 selected") === true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Select asset asset-a"]')?.checked).toBe(false);
  });

  it("keeps the Image Library browse-only when content.asset.review is not granted", async () => {
    apiGet.mockResolvedValue(listResponse(asset("asset-read-only", "approved")));

    await act(async () => root.render(<AssetsListPage canReview={false} />));
    await waitUntil(() =>
      container.querySelector('a[href="/admin/content/assets/asset-read-only"]') !== null,
    );

    expect(container.querySelector('input[aria-label="Select asset asset-read-only"]')).toBeNull();
    expect(findButton("Select page", container)).toBeNull();
    expect(findButton("Archive selected", container)).toBeNull();
  });

  it("preflights dependencies and deep-links the repair without calling the mutation", async () => {
    const free = asset("asset-free", "approved");
    const blocked = asset("asset-blocked", "approved");
    const dependency = {
        kind: "character_release" as const,
        characterId: "character-1",
        releaseId: "release-1",
        releaseState: "current" as const,
        slot: "portrait",
        repairPath: "/admin/characters/character-1?tab=release",
    };
    apiGet.mockResolvedValue(listResponse(free, blocked));
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          assetIds: ["asset-blocked", "asset-free"],
          blockers: [{
            assetId: "asset-blocked",
            dependencies: [dependency],
          }],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<AssetsListPage />));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/asset-free"]') !== null);
    await click(findButton("Select page", container));
    await click(findButton("Archive selected", container));

    await waitUntil(() =>
      container.querySelector('a[href="/admin/characters/character-1?tab=release"]') !== null,
    );
    expect(container.textContent).toContain("1 selected assets have active authority dependencies.");
    expect(container.textContent).toContain("No selected asset was changed.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/content/assets/bulk/preflight");
  });

  it("requires the exact canonical IDs and submits one atomic archive before refreshing and clearing", async () => {
    const assetB = asset("asset-b", "approved");
    const assetA = asset("asset-a", "generated");
    apiGet.mockResolvedValue(listResponse(assetB, assetA));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          data: {
            assetIds: ["asset-a", "asset-b"],
            blockers: [],
          },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          data: { updatedIds: ["asset-a", "asset-b"] },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<AssetsListPage />));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/asset-a"]') !== null);
    await click(findButton("Select page", container));
    await click(findButton("Archive selected", container));
    await waitUntil(() => document.querySelector('[role="dialog"]') !== null);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("asset-a,asset-b");
    const submit = findButton("Archive selected", dialog ?? document);
    expect(submit?.disabled).toBe(true);

    await enter(dialog?.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]') ?? null, "Retire unused set");
    await enter(
      dialog?.querySelector<HTMLInputElement>('input[aria-label="Paste exact asset IDs to confirm"]') ?? null,
      "asset-b,asset-a",
    );
    expect(submit?.disabled).toBe(true);
    await enter(
      dialog?.querySelector<HTMLInputElement>('input[aria-label="Paste exact asset IDs to confirm"]') ?? null,
      "asset-a,asset-b",
    );
    expect(submit?.disabled).toBe(false);

    await click(submit);
    await waitUntil(() => fetchMock.mock.calls.length === 2);
    await waitUntil(() => container.textContent?.includes("2 assets archived. The selection was cleared.") === true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/content/assets/bulk/preflight");
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      assetIds: ["asset-a", "asset-b"],
      status: "archived",
      reason: "Retire unused set",
      confirmation: "asset-a,asset-b",
    });
    expect(container.textContent).toContain("0 selected");
    expect(apiGet.mock.calls.filter(([path]) => !path.endsWith("/asset-a") && !path.endsWith("/asset-b")).length).toBeGreaterThan(1);
  });

  it("keeps a transaction-time dependency conflict in the dialog with a repair link", async () => {
    const selected = asset("asset-race", "approved");
    apiGet.mockResolvedValue(listResponse(selected));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          data: { assetIds: ["asset-race"], blockers: [] },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: false,
          error: {
            message: "Asset remains in use",
            details: {
              code: "asset_authority_dependency_active",
              assetId: "asset-race",
              dependencies: [{
                kind: "creative_run_asset",
                characterId: "character-1",
                itemId: "item-1",
                runId: "run-1",
                status: "approved",
                repairPath: "/admin/creative/runs/run-1",
              }],
              repairPath: "/admin/creative/runs/run-1",
            },
          },
        }),
      }));

    await act(async () => root.render(<AssetsListPage />));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/asset-race"]') !== null);
    await click(findButton("Select page", container));
    await click(findButton("Archive selected", container));
    await waitUntil(() => document.querySelector('[role="dialog"]') !== null);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    await enter(dialog?.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]') ?? null, "Archive stale candidate");
    await enter(
      dialog?.querySelector<HTMLInputElement>('input[aria-label="Paste exact asset IDs to confirm"]') ?? null,
      "asset-race",
    );
    await click(findButton("Archive selected", dialog ?? document));

    await waitUntil(() => dialog?.querySelector('a[href="/admin/creative/runs/run-1"]') !== null);
    expect(dialog?.textContent).toContain("No selected asset was changed.");
    expect(dialog?.textContent).toContain("asset-race");
    expect(dialog?.textContent).not.toContain("No active authority dependencies were found.");
    expect(container.textContent).toContain("1 selected");
  });

  it("names the exact asset when the batch preflight finds a stale selection", async () => {
    const selected = asset("asset-stale", "approved");
    apiGet.mockResolvedValue(listResponse(selected));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        ok: false,
        error: {
          message: "One or more content assets were not found",
          details: { missingAssetIds: ["asset-stale"] },
        },
      }),
    }));

    await act(async () => root.render(<AssetsListPage />));
    await waitUntil(() => container.querySelector('a[href="/admin/content/assets/asset-stale"]') !== null);
    await click(findButton("Select page", container));
    await click(findButton("Archive selected", container));

    await waitUntil(() =>
      container.textContent?.includes("Dependency preflight failed for asset(s)") === true,
    );
    expect(container.textContent).toContain(
      "Dependency preflight failed for asset(s) asset-stale: One or more content assets were not found",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
