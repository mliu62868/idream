// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlacementsNewPage } from "./PlacementsNewPage";
import { PlacementsDetailPage } from "./PlacementsDetailPage";

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
    apiGet.mockReset();
    operation.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("collects customer campaign copy and validates both halves of the optional CTA", async () => {
    apiGet.mockResolvedValue({ items: [{ id: "artwork", purpose: "campaign", targetId: null, customerPublishable: true, publishabilityReasons: [] }], pageInfo: { hasNextPage: false, endCursor: null } });
    await act(async () => root.render(<PlacementsNewPage />));
    await waitFor(() => container.querySelector('select')?.disabled === false);
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

  it("invalidates the asset selection immediately when paging and retains no stale choices after failure", async () => {
    let rejectPage: (reason: Error) => void = () => {};
    apiGet.mockResolvedValueOnce({ items: [{ id: "artwork", purpose: "campaign", targetId: null, customerPublishable: true, publishabilityReasons: [] }], pageInfo: { hasNextPage: true, endCursor: "page-two" } })
      .mockImplementation(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
    await act(async () => root.render(<PlacementsNewPage />));
    await waitFor(() => container.querySelector('select')?.disabled === false);
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Autumn collection");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign eyebrow"]')!, "Featured");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign destination key"]')!, "autumn");
    await change(container.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Launch collection");
    expect(button(container, "Create placement")!.disabled).toBe(false);
    const next = button(container, "Next page")!;
    await act(async () => { next.click(); next.click(); });
    expect(button(container, "Create placement")!.disabled).toBe(true);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 2");
    expect(container.querySelector('select')!.disabled).toBe(true);
    await waitFor(() => apiGet.mock.calls.length === 2);
    await act(async () => rejectPage(new Error("Image library unavailable")));
    expect(container.querySelector('select')!.options.length).toBe(0);
    expect(button(container, "Create placement")!.disabled).toBe(true);
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
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  throw new Error("Condition did not become true");
}
