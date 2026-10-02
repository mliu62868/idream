// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));
vi.mock("@/components/admin/i18n", () => ({ useAdminI18n: () => ({ t: (text: string) => text, value: (text: string) => text }) }));
import { PackOperationsPanel } from "./PackOperationsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const summary = { id: "pack-fixture", title: "Controlled Pack", description: "Listed current content", status: "published", visibility: "public", version: 3,
  creator: { id: "creator-fixture", displayName: "Controlled creator" }, itemCount: 1, coverUrl: null, releaseId: "release-fixture", releaseVersion: 3, claimUntil: null,
  publishedAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", priceCents: 0, rights: "personal_view_download_current_only", canManage: false, canClaim: true };
const detail = { ...summary, manifest: null, grant: null, grants: [], blockedReason: null, release: { id: "release-fixture", version: 3, title: summary.title, description: summary.description,
  priceCents: 0, rights: summary.rights, claimUntil: null, publishedAt: summary.publishedAt, canAccess: false,
  items: [{ id: "asset-fixture", caption: "Selected image", type: "image", contentType: "image/png", sizeBytes: 4096, url: null, downloadUrl: null }] } };
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); apiGet.mockReset(); apiWrite.mockReset(); apiGet.mockImplementation(async (path: string) => path.includes("?") ? { items: [summary], nextCursor: null } : detail); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function mount(canBlock = true) { await act(async () => root.render(<PackOperationsPanel canBlock={canBlock} />)); await act(async () => vi.advanceTimersByTimeAsync(1)); }
function button(text: string) { const element = [...container.querySelectorAll("button")].find(item => item.textContent === text); if (!element) throw new Error(`Missing ${text}`); return element; }
async function change(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
describe("Pack operator authority", () => {
  it("requires the exact inspected version, a reason and target confirmation, and can recover a lost response", async () => {
    apiWrite.mockRejectedValueOnce(new Error("Controlled lost response")).mockResolvedValueOnce({ ...detail, status: "blocked", version: 4, canClaim: false, blockedReason: "Emergency access withdrawal" });
    await mount(); expect(container.querySelector("textarea")).toBeNull(); await act(async () => button("Inspect Pack").click());
    expect(container.textContent).toContain("Selected image"); expect(button("Block all access").disabled).toBe(true);
    await change(container.querySelector("textarea")!, "Emergency access withdrawal"); await change(container.querySelector("input")!, "different-pack"); expect(button("Block all access").disabled).toBe(true);
    await change(container.querySelector("input")!, "pack-fixture"); await act(async () => button("Block all access").click()); expect(container.textContent).toContain("Controlled lost response");
    await act(async () => button("Block all access").click()); expect(apiWrite.mock.calls[1]).toEqual(apiWrite.mock.calls[0]);
    expect(apiWrite.mock.calls[0]).toEqual(["/api/v2/admin/packs/pack-fixture/block", "POST", { version: 3, confirmation: "pack-fixture", reason: "Emergency access withdrawal" }]);
    expect(container.textContent).toContain("Blocked; existing receipts retained.");
  });
  it("permits inspection without exposing a block command to read-only operators", async () => {
    await mount(false); await act(async () => button("Inspect Pack").click()); expect(container.textContent).toContain("Selected image"); expect(container.querySelector("textarea")).toBeNull(); expect(apiWrite).not.toHaveBeenCalled();
  });
  it("opens the exact Pack from an operational deep link", async () => {
    const previous = window.location.href; window.history.replaceState(null, "", "/admin/moderation?pack=pack-fixture");
    try { await mount(); expect(apiGet).toHaveBeenCalledWith("/api/v2/admin/packs/pack-fixture"); expect(container.textContent).toContain("Selected image"); }
    finally { window.history.replaceState(null, "", previous); }
  });
  it("refreshes the inspected authority after a conflict and blocks commands until the new version arrives", async () => {
    const old = { ...detail, version: 2 };
    let completeRefresh!: (value: typeof detail) => void;
    let detailReads = 0;
    apiGet.mockImplementation(async (path: string) => path.includes("?")
      ? { items: [], nextCursor: null }
      : ++detailReads === 1 ? old : new Promise<typeof detail>(resolve => { completeRefresh = resolve; }));
    apiWrite.mockRejectedValueOnce(new Error("Pack changed. Reload before continuing.")).mockResolvedValueOnce({ ...detail, status: "blocked", version: 4, canClaim: false, blockedReason: "Emergency access withdrawal" });
    const previous = window.location.href; window.history.replaceState(null, "", "/admin/moderation?pack=pack-fixture");
    try {
      await mount(); await change(container.querySelector("textarea")!, "Emergency access withdrawal"); await change(container.querySelector("input")!, "pack-fixture");
      await act(async () => button("Block all access").click());
      expect(container.textContent).toContain("Pack changed. Reload before continuing.");
      await act(async () => button("Reload Packs").click());
      expect(detailReads).toBe(2);
      expect(container.textContent).toContain("Controlled Pack · Version 2");
      expect(button("Block all access").disabled).toBe(true);
      await act(async () => completeRefresh({ ...detail, status: "withdrawn", canClaim: false }));
      expect(container.textContent).toContain("Controlled Pack · Version 3");
      expect(button("Block all access").disabled).toBe(false);
      await act(async () => button("Block all access").click());
      expect(apiWrite.mock.calls.map(call => call[2].version)).toEqual([2, 3]);
      expect(container.textContent).toContain("Blocked; existing receipts retained.");
    } finally { window.history.replaceState(null, "", previous); }
  });
  it("retains the inspected context and a visible error when its current authority cannot reload", async () => {
    const previous = window.location.href; window.history.replaceState(null, "", "/admin/moderation?pack=pack-fixture");
    try {
      await mount(); await change(container.querySelector("textarea")!, "Emergency access withdrawal"); await change(container.querySelector("input")!, "pack-fixture");
      apiWrite.mockRejectedValueOnce(new Error("Pack changed. Reload before continuing."));
      await act(async () => button("Block all access").click());
      apiGet.mockImplementation(async (path: string) => { if (path.includes("?")) return { items: [], nextCursor: null }; throw new Error("Current Pack authority could not load."); });
      await act(async () => button("Reload Packs").click());
      expect(container.textContent).toContain("Current Pack authority could not load.");
      expect(container.textContent).toContain("Controlled Pack · Version 3");
      expect(container.querySelector("textarea")!.value).toBe("Emergency access withdrawal");
      expect(button("Block all access").disabled).toBe(true);
      await act(async () => button("Block all access").click());
      expect(apiWrite).toHaveBeenCalledTimes(1);
    } finally { window.history.replaceState(null, "", previous); }
  });
});
