// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));
vi.mock("@/components/admin/i18n", () => ({ useAdminI18n: () => ({ t: (value: string) => value, value: (value: string) => value }) }));
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { ComicReviewPanel } from "./ComicReviewPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const summary = { id: "comic-fixture", title: "Controlled Comic", description: "Submitted Comic fixture",
  visibility: "public", status: "pending_review", allowRemix: true, version: 3,
  creator: { id: "creator-fixture", displayName: "Controlled creator" }, pageCount: 1, episodeCount: 1,
  coverUrl: null, updatedAt: "2026-09-10T00:00:00Z", publishedAt: null, canManage: true };
const detail = { ...summary, reviewNote: null, episodes: [{ id: "chapter-fixture", title: "Chapter one", ordinal: 0,
  pages: [{ id: "page-fixture", mediaAssetId: "asset-fixture", ordinal: 0, caption: "A submitted page",
    url: null, width: 512, height: 640, remixHref: null, character: null }] }] };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); apiGet.mockReset(); apiWrite.mockReset();
  apiGet.mockImplementation(async (path: string) => path.includes("?") ? { items: [summary], nextCursor: null } : detail);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function mount(canReview = true) {
  await act(async () => root.render(<ComicReviewPanel canReview={canReview} />));
  await act(async () => vi.advanceTimersByTimeAsync(1));
}
function button(text: string) {
  const value = [...container.querySelectorAll("button")].find((element) => element.textContent === text);
  if (!value) throw new Error(`Missing button ${text}`);
  return value;
}
async function reason(value: string) {
  const field = container.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("Comic review authority UI", () => {
  it("requires inspecting the exact version and a reason, then recovers an uncertain decision with the same key", async () => {
    apiWrite.mockRejectedValueOnce(new Error("Controlled lost response")).mockResolvedValueOnce({ ...detail, status: "published", publishedAt: "2026-09-10T01:00:00Z" });
    await mount();
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => button("Review pages").click());
    expect(container.textContent).toContain("A submitted page");
    expect(button("Approve version 3").disabled).toBe(true);
    await reason("Reviewed every submitted page");
    await act(async () => button("Approve version 3").click());
    expect(container.textContent).toContain("Controlled lost response");
    await act(async () => button("Approve version 3").click());
    expect(apiWrite).toHaveBeenCalledTimes(2);
    expect(apiWrite.mock.calls[1]).toEqual(apiWrite.mock.calls[0]);
    expect(apiWrite.mock.calls[0]).toEqual([
      "/api/v2/admin/comics/comic-fixture/decision", "POST",
      { version: 3, reason: "Reviewed every submitted page", decision: "approve", confirmation: "comic-fixture" },
    ]);
    expect(container.textContent).toContain("Remove published version 3");
  });

  it("reloads the inspected Comic after a decision conflict before enabling the current version", async () => {
    let detailReads = 0;
    let completeRefresh!: (value: typeof detail) => void;
    apiGet.mockImplementation(async (path: string) => path.includes("?")
      ? { items: [summary], nextCursor: null }
      : ++detailReads === 1 ? { ...detail, version: 2 } : new Promise<typeof detail>(resolve => { completeRefresh = resolve; }));
    apiWrite.mockRejectedValueOnce(new Error("Comic changed. Reload this Comic."))
      .mockResolvedValueOnce({ ...detail, status: "published", publishedAt: "2026-09-10T01:00:00Z" });
    await mount();
    await act(async () => button("Review pages").click());
    await reason("Reviewed every submitted page");
    await act(async () => button("Approve version 2").click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(detailReads).toBe(2);
    expect(button("Approve version 2").disabled).toBe(true);
    await act(async () => completeRefresh(detail));
    expect(container.querySelector("textarea")!.value).toBe("Reviewed every submitted page");
    expect(button("Approve version 3").disabled).toBe(false);
    await act(async () => button("Approve version 3").click());
    expect(apiWrite.mock.calls.map(call => call[2].version)).toEqual([2, 3]);
    expect(container.textContent).toContain("Remove published version 3");
  });

  it("retries the exact deep-linked comic after its initial detail read fails outside the visible queue", async () => {
    let detailReads = 0;
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("?")) return { items: [], nextCursor: null };
      if (++detailReads === 1) throw new AdminV2RequestError("Detail authority temporarily unavailable", 503, "unavailable");
      return detail;
    });
    const previous = window.location.href;
    window.history.replaceState(null, "", "/admin/moderation?comic=comic-fixture");
    try {
      await mount();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
      expect(detailReads).toBe(2);
      expect(container.textContent).toContain("A submitted page");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally { window.history.replaceState(null, "", previous); }
  });

  it("separates failed reads from uncertain decisions and folds the original error into technical details", async () => {
    apiGet.mockRejectedValueOnce(new AdminV2RequestError("Internal Comic authority address", 503, "unavailable"));
    await mount();
    let alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Retry to load the latest data.");
    expect(alert.querySelector("details")?.open).toBe(false);
    expect(alert.querySelector("details")?.textContent).toContain("Internal Comic authority address");
    await act(async () => alert.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => button("Review pages").click());
    await reason("Reviewed every submitted page");
    apiWrite.mockRejectedValueOnce(new AdminV2RequestError("Internal Comic write address", 503, "unavailable"));
    await act(async () => button("Approve version 3").click());
    alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("whether the write landed is unknown");
    expect(alert.querySelector("details")?.open).toBe(false);
    expect(alert.querySelector("details")?.textContent).toContain("Internal Comic write address");
  });

  it("lets a reader inspect pages without exposing approval or removal commands", async () => {
    await mount(false); await act(async () => button("Review pages").click());
    expect(container.textContent).toContain("A submitted page");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Approve version");
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("opens the Comic named by a media dependency repair link without a list click", async () => {
    window.history.replaceState(null, "", "/admin/moderation?comic=comic-fixture");
    try {
      await mount();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(apiGet).toHaveBeenCalledWith("/api/v2/admin/comics/comic-fixture");
      expect(container.textContent).toContain("A submitted page");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
