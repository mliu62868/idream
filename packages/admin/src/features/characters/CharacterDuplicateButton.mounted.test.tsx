// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation } = vi.hoisted(() => ({ adminV2Operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));

import { CharacterDuplicateButton } from "./CharacterDuplicateButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Copy as new draft", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("copies on one click, without a confirmation, and opens the new Character", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    adminV2Operation.mockResolvedValue({ deepLink: "/admin/characters/copy-1?tab=assets" });
    await act(async () => root.render(<CharacterDuplicateButton characterId="source-1" />));
    await act(async () => container.querySelector("button")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(adminV2Operation).toHaveBeenCalledWith("POST /api/v2/admin/characters/:id/duplicate", { path: { id: "source-1" }, body: {} });
    expect(assign).toHaveBeenCalledWith("/admin/characters/copy-1?tab=assets");
  });

  it("explains a failure in place and can be retried", async () => {
    adminV2Operation.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => root.render(<CharacterDuplicateButton characterId="source-1" />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("button")!.disabled).toBe(false);
  });
});
