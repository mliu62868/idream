// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));
vi.mock("@/components/admin/i18n", () => ({ useAdminI18n: () => ({ t: (value: string) => value, value: (value: string) => value }) }));
import { ComicReviewPanel } from "./ComicReviewPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const summary = { id: "comic-fixture", title: "Controlled Comic", description: "Submitted Comic fixture",
  visibility: "public", status: "pending_review", allowRemix: true, version: 3,
  creator: { id: "creator-fixture", displayName: "Controlled creator" }, pageCount: 1, episodeCount: 1,
  coverUrl: null, updatedAt: "2026-09-10T00:00:00Z", publishedAt: null, canManage: true };
const detail = { ...summary, reviewNote: null, episodes: [{ id: "chapter-fixture", title: "Chapter one", ordinal: 0,
  pages: [{ id: "page-fixture", mediaAssetId: "asset-fixture", ordinal: 0, caption: "A submitted page",
    url: null, remixHref: null, character: null }] }] };
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
