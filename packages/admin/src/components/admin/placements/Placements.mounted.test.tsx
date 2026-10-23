// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlacementsNewPage } from "./PlacementsNewPage";
import { PlacementsDetailPage } from "./PlacementsDetailPage";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { apiGet, operation } = vi.hoisted(() => ({ apiGet: vi.fn(), operation: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation: operation }));

const placement = {
  id: "uploaded-placement", mediaAssetId: "artwork", slot: "campaign", targetType: "campaign",
  targetId: "community-feature", status: "draft", version: 4, publishedAt: null,
  verificationState: "pending", managedRunId: null, canPublish: true,
  metadata: { eyebrow: "Featured", title: "Autumn collection" },
  asset: { id: "artwork", url: "/artwork.png", thumbnailUrl: "/artwork.png" },
};

describe("operational artwork publication", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    apiGet.mockReset();
    operation.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("collects customer campaign copy and validates both halves of the optional CTA", async () => {
    apiGet.mockResolvedValue({ items: [{ id: "artwork", purpose: "campaign", targetId: null, customerPublishable: true, publishabilityReasons: [] }], pageInfo: { hasNextPage: false, endCursor: null } });
    await act(async () => root.render(<PlacementsNewPage />));
    const assetSelector = container.querySelector<HTMLSelectElement>('[aria-label="Asset"]')!;
    expect(assetSelector.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    expect(apiGet).not.toHaveBeenCalled();
    expect(assetSelector.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(assetSelector.disabled).toBe(false);
    await chooseAsset(container, "artwork");
    const title = container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]');
    expect(title).not.toBeNull();
    await change(title!, "Autumn collection");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign eyebrow"]')!, "Featured");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign destination key"]')!, "autumn");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Launch collection");
    const submit = button(container, "Create placement")!;
    expect(submit.disabled).toBe(false);
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA label"]')!, "Explore");
    expect(submit.disabled).toBe(true);
    for (const href of ["javascript:alert(1)", "explore", "#featured", "?view=campaigns"]) {
      await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA href"]')!, href);
      expect(submit.disabled, href).toBe(true);
    }
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA href"]')!, "/explore");
    expect(submit.disabled).toBe(false);
  });

  it("preserves the explicitly selected asset when paging fails", async () => {
    let rejectPage: (reason: Error) => void = () => {};
    apiGet.mockResolvedValueOnce({ items: [{ id: "artwork", purpose: "campaign", targetId: null, customerPublishable: true, publishabilityReasons: [] }], pageInfo: { hasNextPage: true, endCursor: "page-two" } })
      .mockImplementation(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
    await act(async () => root.render(<PlacementsNewPage />));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Asset"]')!.disabled).toBe(false);
    await chooseAsset(container, "artwork");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Autumn collection");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign eyebrow"]')!, "Featured");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign destination key"]')!, "autumn");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Launch collection");
    expect(button(container, "Create placement")!.disabled).toBe(false);
    const next = button(container, "Next page")!;
    await act(async () => { next.click(); next.click(); });
    expect(button(container, "Create placement")!.disabled).toBe(false);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 2");
    expect(container.querySelector('select')!.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(apiGet).toHaveBeenCalledTimes(2);
    await act(async () => rejectPage(new Error("Image library unavailable")));
    expect(container.querySelector('select')!.value).toBe("artwork");
    expect(container.querySelector('select')!.options.length).toBe(1);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Campaign destination key"]')!.value).toBe("autumn");
    expect(button(container, "Create placement")!.disabled).toBe(false);
    expect(container.textContent).toContain("Image library unavailable");
    expect(apiGet.mock.calls[1][0]).toContain("cursor=page-two");
  });

  it("offers a versioned publish action for eligible artwork and shows the refreshed public result", async () => {
    apiGet.mockResolvedValueOnce({ placement }).mockResolvedValue({ placement: { ...placement, status: "published", version: 5, canPublish: false, verificationState: "passed" } });
    operation.mockResolvedValue({});
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    const publish = button(container, "Publish");
    expect(publish).not.toBeNull();
    await act(async () => publish!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Launch campaign");
    await act(async () => button(dialog, "Publish")!.click());
    expect(operation).toHaveBeenCalledWith("POST /api/v2/admin/content/placements/:id/publish", {
      path: { id: placement.id }, ifMatch: 4,
      body: { reason: "Launch campaign", confirmation: placement.id },
    });
    await waitFor(() => container.textContent?.includes("Published. This campaign is visible in Community.") === true);
    expect(button(container, "Publish")).toBeNull();
  });

  it("does not offer publication without actor permission or backend eligibility", async () => {
    apiGet.mockResolvedValue({ placement: { ...placement, canPublish: false } });
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Placement details") === true);
    expect(button(container, "Publish")).toBeNull();
    expect(operation).not.toHaveBeenCalled();
  });

  it("lets an operator correct draft copy through a versioned edit without publishing", async () => {
    apiGet.mockResolvedValue({ placement });
    operation.mockResolvedValue({});
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    expect(button(container, "Edit")).not.toBeNull();
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Updated collection");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA label"]')!, "Explore");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA href"]')!, "explore");
    expect(button(container, "Save changes")!.disabled).toBe(true);
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA label"]')!, "");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign CTA href"]')!, "");
    await act(async () => button(container, "Save changes")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Correct collection title");
    await act(async () => button(dialog, "Save changes")!.click());
    expect(operation).toHaveBeenCalledWith("PATCH /api/v2/admin/content/placements/:id", {
      path: { id: placement.id }, ifMatch: 4, body: {
        metadata: { eyebrow: "Featured", title: "Updated collection", ctaLabel: null, href: null },
        reason: "Correct collection title", confirmation: placement.id,
      },
    });
    expect(operation.mock.calls.some(([id]) => id.endsWith("/publish"))).toBe(false);
  });

  it("keeps a campaign copy bound to the version originally edited after a shell refresh", async () => {
    apiGet.mockResolvedValueOnce({ placement }).mockResolvedValue({ placement: {
      ...placement, version: 5,
      metadata: { eyebrow: "Another operator", title: "Saved by another operator" },
    } });
    operation.mockRejectedValue(new Error("Expected version conflict"));
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "My unfinished copy");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!.value).toBe("My unfinished copy");
    await act(async () => button(container, "Save changes")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Correct campaign copy");
    await act(async () => button(dialog, "Save changes")!.click());
    expect(operation).toHaveBeenCalledWith("PATCH /api/v2/admin/content/placements/:id", {
      path: { id: placement.id }, ifMatch: 4,
      body: {
        reason: "Correct campaign copy", confirmation: placement.id,
        metadata: { eyebrow: "Featured", title: "My unfinished copy", ctaLabel: null, href: null },
      },
    });
  });

  it("does not silently approve new artwork content when a publication confirmation is open", async () => {
    apiGet.mockResolvedValueOnce({ placement }).mockResolvedValue({ placement: {
      ...placement, version: 5,
      metadata: { eyebrow: "Another operator", title: "Unreviewed new copy" },
    } });
    operation.mockRejectedValue(new Error("Expected version conflict"));
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    await act(async () => button(container, "Publish")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Publish reviewed campaign");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(apiGet).toHaveBeenCalledTimes(2);
    await act(async () => button(dialog, "Publish")!.click());
    expect(operation).toHaveBeenCalledWith("POST /api/v2/admin/content/placements/:id/publish", {
      path: { id: placement.id }, ifMatch: 4,
      body: { reason: "Publish reviewed campaign", confirmation: placement.id },
    });
  });

  it("keeps the latest placement projection when refreshes finish out of order", async () => {
    let finishEarlier!: (value: { placement: typeof placement }) => void;
    apiGet.mockResolvedValueOnce({ placement })
      .mockImplementationOnce(() => new Promise(resolve => { finishEarlier = resolve; }))
      .mockResolvedValueOnce({ placement: { ...placement, version: 6, metadata: { eyebrow: "Current", title: "Latest saved campaign" } } });
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(container.textContent).toContain("Latest saved campaign");
    await act(async () => finishEarlier({ placement }));
    expect(container.textContent).toContain("Latest saved campaign");
    expect(container.textContent).not.toContain("Autumn collection");
  });

  it("bases retained input on its own successful write rather than a later refresh", async () => {
    let finishWrite!: (value: { placement: typeof placement }) => void;
    apiGet.mockResolvedValueOnce({ placement }).mockResolvedValue({ placement: {
      ...placement, version: 6, metadata: { eyebrow: "External", title: "Later external revision" },
    } });
    operation.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }))
      .mockRejectedValue(new Error("Expected version conflict"));
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Submitted copy");
    await act(async () => button(container, "Save changes")!.click());
    const firstDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(firstDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Correct campaign copy");
    await act(async () => button(firstDialog, "Save changes")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "New retained copy");
    await act(async () => finishWrite({ placement: {
      ...placement, version: 5, metadata: { eyebrow: "Featured", title: "Submitted copy" },
    } }));

    expect(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!.value).toBe("New retained copy");
    await act(async () => button(container, "Save changes")!.click());
    const nextDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(nextDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Save retained copy");
    await act(async () => button(nextDialog, "Save changes")!.click());
    expect(operation.mock.calls[1][1]).toMatchObject({
      ifMatch: 5, body: { metadata: { title: "New retained copy" } },
    });
  });

  it("does not close a later confirmation when a revoked action finishes", async () => {
    let finishWrite!: (value: object) => void;
    apiGet.mockResolvedValue({ placement });
    operation.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await waitFor(() => container.textContent?.includes("Autumn collection") === true);
    await act(async () => button(container, "Publish")!.click());
    const firstDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(firstDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "First publication");
    await act(async () => button(firstDialog, "Publish")!.click());
    await act(async () => root.render(<PlacementsDetailPage canPublish={false} id={placement.id} />));
    await act(async () => root.render(<PlacementsDetailPage canPublish id={placement.id} />));
    await act(async () => button(container, "Publish")!.click());
    const nextDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(nextDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Second publication");
    await act(async () => finishWrite({}));
    expect(document.querySelector('[role="dialog"]')).toBe(nextDialog);
    expect(nextDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("Second publication");
  });
});

function button(target: HTMLElement, text: string) {
  return [...target.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text) ?? null;
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
  }
  throw new Error("Condition did not become true");
}

async function chooseAsset(container: HTMLElement, value: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Asset"]')!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
