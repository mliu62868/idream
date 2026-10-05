// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentAsset } from "@idream/shared/admin";
import { AssetsSection } from "./AssetsSection";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => <span /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function asset(id: string): ContentAsset {
  return {
    id, type: "image", url: `/uploads/${id}.png`, thumbnailUrl: `/uploads/${id}.png`,
    contentType: "image/png", width: 512, height: 512, safetyStatus: "safe",
    sourceJobId: null, isSynthetic: false, customerPublishable: false,
    publishabilityReasons: [], promptSummary: null, metadata: {},
    createdAt: "2026-10-05T00:00:00.000Z", platformStatus: "approved", purpose: "campaign",
    targetType: null, targetId: null, tags: ["operator-audit"], description: "Unused audit upload",
    sourceJob: null, sourceBatch: null, placements: [], authorityDependencies: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function ok(data: unknown) { return Response.json({ ok: true, data }); }

describe("AssetsSection bulk archive authority", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
  let preflightResponse: (init?: RequestInit) => Promise<Response>;
  let bulkResponse: (init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/creative/library");
    container = document.createElement("div");
    container.id = "admin-shell-background";
    document.body.append(container);
    root = createRoot(container);
    preflightResponse = async (init) => ok({ assetIds: JSON.parse(String(init?.body)).assetIds, blockers: [] });
    bulkResponse = async () => ok({ updatedIds: ["asset-a", "asset-b"] });
    fetchMock = vi.fn(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/bulk/preflight")) return preflightResponse(init);
      if (url.pathname.endsWith("/bulk")) return bulkResponse(init);
      if (url.pathname === "/api/v2/admin/assets/asset-b") return ok({ asset: asset("asset-b") });
      if (url.pathname === "/api/v2/admin/assets" && (!init?.method || init.method === "GET")) {
        const items = url.searchParams.get("search") === "asset-b" ? [asset("asset-b")] : [asset("asset-a"), asset("asset-b")];
        return ok({ items, pageInfo: { endCursor: null, hasNextPage: false, totalCount: items.length } });
      }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(canReview = true) {
    await act(async () => root.render(<AssetsSection canReview={canReview} view={{ kind: "list" }} />));
  }
  function button(label: string, scope: ParentNode = document) {
    const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
    expect(result, `Missing button: ${label}`).toBeDefined();
    return result!;
  }
  function dialog() { return document.querySelector<HTMLDivElement>('[role="dialog"]'); }
  function bulkWrites() { return fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname.endsWith("/bulk")); }
  async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error("Expected AssetsSection state did not appear");
  }
  async function preflightPage() {
    await waitFor(() => container.querySelector('input[type="checkbox"]') !== null);
    await act(async () => button("Select page").click());
    await act(async () => button("Archive selected", container).click());
  }
  async function fill(input: HTMLInputElement, text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function confirmDraft(ids = "asset-a,asset-b") {
    const current = dialog()!;
    await fill(current.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Retire unused audit uploads");
    await fill(current.querySelector<HTMLInputElement>('[aria-label="Paste exact asset IDs to confirm"]')!, ids);
  }
  async function restoreQuery(search: string) {
    // Browser Back/Forward can change the workspace while the dialog makes its background inert.
    await act(async () => {
      window.history.pushState(null, "", `/admin/creative/library${search}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }

  it("discards an open archive intent when review permission is revoked and requires a fresh confirmation after regrant", async () => {
    await render();
    await preflightPage();
    await waitFor(() => dialog() !== null);
    await confirmDraft();
    expect(button("Archive selected", dialog()!).disabled).toBe(false);
    await render(false);
    expect(dialog()).toBeNull();
    expect(container.querySelector('[aria-label="Bulk archive"]')).toBeNull();
    await render();
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("0 selected");
    expect(bulkWrites()).toHaveLength(0);
    await preflightPage();
    await waitFor(() => dialog() !== null);
    expect(button("Archive selected", dialog()!).disabled).toBe(true);
    expect(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("");
  });

  it("does not reopen a late preflight from a revoked review capability after permission returns", async () => {
    const pending = deferred<Response>();
    preflightResponse = () => pending.promise;
    await render();
    await preflightPage();
    expect(dialog()).toBeNull();
    await render(false);
    await render();
    await act(async () => pending.resolve(ok({ assetIds: ["asset-a", "asset-b"], blockers: [] })));
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("0 selected");
    expect(bulkWrites()).toHaveLength(0);
  });

  it("discards a prepared archive when browser history restores a different asset query", async () => {
    await render();
    await preflightPage();
    await confirmDraft();
    await restoreQuery("?search=asset-b");
    expect(dialog()).toBeNull();
    await waitFor(() => container.querySelector('[aria-label="Select asset asset-b"]') !== null);
    expect(container.textContent).toContain("0 selected");
    expect(bulkWrites()).toHaveLength(0);
    await preflightPage();
    expect(dialog()!.textContent).toContain("asset-b");
    expect(dialog()!.textContent).not.toContain("asset-a");
    expect(button("Archive selected", dialog()!).disabled).toBe(true);
  });

  it.each(["success", "conflict"])("keeps the new query, selection and confirmation after an old archive returns %s", async (outcome) => {
    const pending = deferred<Response>();
    bulkResponse = () => pending.promise;
    await render();
    await preflightPage();
    await confirmDraft();
    await act(async () => button("Archive selected", dialog()!).click());
    expect(bulkWrites()).toHaveLength(1);
    await restoreQuery("?search=asset-b");
    expect(dialog()).toBeNull();
    await waitFor(() => container.querySelector('[aria-label="Select asset asset-b"]') !== null);
    await preflightPage();
    await confirmDraft("asset-b");
    const newDialog = dialog();
    await act(async () => pending.resolve(outcome === "success"
      ? ok({ updatedIds: ["asset-a", "asset-b"] })
      : Response.json({ ok: false, error: { message: "Old archive now blocked", details: { missingAssetIds: ["asset-a"] } } }, { status: 409 })));
    expect(dialog()).toBe(newDialog);
    expect(new URL(window.location.href).searchParams.get("search")).toBe("asset-b");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select asset asset-b"]')!.checked).toBe(true);
    expect(dialog()!.querySelector<HTMLInputElement>('[aria-label="Paste exact asset IDs to confirm"]')!.value).toBe("asset-b");
    expect(document.body.textContent).not.toContain("Old archive now blocked");
    expect(bulkWrites()).toHaveLength(1);
  });

  it("archives only the explicitly confirmed selected set and clears the completed intent", async () => {
    await render();
    await preflightPage();
    expect(button("Archive selected", dialog()!).disabled).toBe(true);
    await confirmDraft();
    await act(async () => button("Archive selected", dialog()!).click());
    await waitFor(() => dialog() === null);
    expect(bulkWrites()).toHaveLength(1);
    expect(JSON.parse(String(bulkWrites()[0][1]?.body))).toEqual({
      assetIds: ["asset-a", "asset-b"], status: "archived", reason: "Retire unused audit uploads", confirmation: "asset-a,asset-b",
    });
    expect(container.textContent).toContain("2 assets archived. The selection was cleared.");
    expect(container.textContent).toContain("0 selected");
  });

  it("keeps an active authority dependency as a whole-batch blocker without opening confirmation", async () => {
    preflightResponse = async () => ok({
      assetIds: ["asset-a", "asset-b"],
      blockers: [{ assetId: "asset-b", dependencies: [{ kind: "character_primary_image", characterId: "character-a", repairPath: "/admin/characters/character-a" }] }],
    });
    await render();
    await preflightPage();
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Character primary image");
    expect(container.querySelector('a[href="/admin/characters/character-a"]')).not.toBeNull();
    expect(bulkWrites()).toHaveLength(0);
  });

  it("does not reload an unmounted list or overwrite the detail URL when its bulk receipt arrives", async () => {
    window.history.replaceState(null, "", "/admin/creative/library?search=asset-a");
    const pending = deferred<Response>();
    bulkResponse = () => pending.promise;
    await render();
    await preflightPage();
    await confirmDraft();
    await act(async () => button("Archive selected", dialog()!).click());
    expect(bulkWrites()).toHaveLength(1);
    await act(async () => {
      window.history.pushState(null, "", "/admin/creative/library/asset-b");
      root.render(<AssetsSection canReview view={{ kind: "detail", id: "asset-b" }} />);
    });
    await waitFor(() => container.querySelector("textarea") !== null);
    const detailUrl = window.location.href;
    const listReads = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname === "/api/v2/admin/assets").length;
    const readsBeforeReceipt = listReads();
    await act(async () => pending.resolve(ok({ updatedIds: ["asset-a", "asset-b"] })));
    expect(window.location.href).toBe(detailUrl);
    expect(listReads()).toBe(readsBeforeReceipt);
    expect(container.textContent).toContain("Description & tags");
  });
});
