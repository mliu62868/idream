// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation } = vi.hoisted(() => ({ adminV2Operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));

import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { CharacterDuplicateButton, CharacterDuplicateReceipt } from "./CharacterDuplicateButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("Copy as new draft", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
    window.sessionStorage.clear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("copies on one click, without a confirmation, and opens the new Character", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    adminV2Operation.mockResolvedValue({
      characterId: "copy-1", deepLink: "/admin/characters/copy-1?tab=assets",
      copiedImageCount: 3, skippedImageCount: 1, identityCopied: false,
    });
    await act(async () => root.render(<CharacterDuplicateButton characterId="source-1" />));
    await act(async () => container.querySelector("button")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(adminV2Operation).toHaveBeenCalledWith("POST /api/v2/admin/characters/:id/duplicate", { path: { id: "source-1" }, body: {} });
    expect(assign).toHaveBeenCalledWith("/admin/characters/copy-1?tab=assets");
  });

  it("shows the copy receipt once on the new draft, and not again after a reload", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    adminV2Operation.mockResolvedValue({
      characterId: "copy-1", deepLink: "/admin/characters/copy-1?tab=assets",
      copiedImageCount: 3, skippedImageCount: 1, identityCopied: false,
    });
    await act(async () => root.render(<CharacterDuplicateButton characterId="source-1" />));
    await act(async () => container.querySelector("button")!.click());

    // Another Character's page does not consume this receipt.
    await act(async () => root.render(<CharacterDuplicateReceipt characterId="other" />));
    await flush();
    expect(container.querySelector('[data-testid="character-duplicate-receipt"]')).toBeNull();

    await act(async () => root.render(<CharacterDuplicateReceipt characterId="copy-1" />));
    await flush();
    const receipt = container.querySelector('[data-testid="character-duplicate-receipt"]');
    expect(receipt?.textContent).toContain("Images copied: 3.");
    expect(receipt?.textContent).toContain("could not be copied and were left out: 1.");
    expect(receipt?.textContent).toContain("The visual identity was not copied.");
    expect(receipt?.textContent).toContain("Choose the primary portrait, character hero and chat moment images again");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<CharacterDuplicateReceipt characterId="copy-1" />));
    await flush();
    expect(container.querySelector('[data-testid="character-duplicate-receipt"]')).toBeNull();
  });

  it("explains a failure in place and can be retried", async () => {
    adminV2Operation.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => root.render(<CharacterDuplicateButton characterId="source-1" />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("button")!.disabled).toBe(false);
  });

  it("says which feature is missing and links to where it is added", async () => {
    adminV2Operation.mockRejectedValueOnce(new AdminV2RequestError("missing", 409, "conflict", {
      reason: "visual_traits_missing", deepLink: "/admin/characters/source-1?tab=soul",
    }));
    await act(async () => root.render(<CharacterDuplicateButton characterId="source-1" />));
    await act(async () => container.querySelector("button")!.click());
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("no features that never change");
    expect(alert?.querySelector("a")?.getAttribute("href")).toBe("/admin/characters/source-1?tab=soul");
  });
});
