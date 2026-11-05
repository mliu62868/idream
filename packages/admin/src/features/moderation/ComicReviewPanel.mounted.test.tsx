// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiGet, apiWrite, toast } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn(), toast: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));
vi.mock("@/components/admin/i18n", () => ({ adminDateLocale: () => undefined, translateAdmin: (_locale: string, value: string) => value, useAdminI18n: () => ({ locale: "en", t: (value: string) => value, value: (value: string) => value }) }));
vi.mock("@/components/admin/ui/Toast", () => ({ useToast: () => ({ toast }), useFailureToast: () => vi.fn() }));
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
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
  vi.useFakeTimers(); apiGet.mockReset(); apiWrite.mockReset(); toast.mockReset();
  apiGet.mockImplementation(async (path: string) => path.includes("?") ? { items: [summary], nextCursor: null } : detail);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function mount(canReview = true) {
  await act(async () => root.render(<ComicReviewPanel canReview={canReview} />));
  await act(async () => vi.advanceTimersByTimeAsync(1));
}
function button(text: string, scope: ParentNode = container) {
  const value = [...scope.querySelectorAll("button")].find((element) => element.textContent === text);
  if (!value) throw new Error(`Missing button ${text}`);
  return value;
}
async function reason(value: string) {
  const field = container.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function fillDialog(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true })); });
}
const published = { ...detail, status: "published", publishedAt: "2026-09-10T01:00:00Z" };
async function inspectPublished() {
  apiGet.mockImplementation(async (path: string) => path.includes("?") ? { items: [{ ...summary, status: "published" }], nextCursor: null } : published);
  await mount();
  await act(async () => button("Review pages").click());
}

describe("Comic review authority UI", () => {
  it("removes a published version only through a confirmation the operator typed, then reports it", async () => {
    apiWrite.mockResolvedValueOnce({ ...published, status: "withdrawn", publishedAt: null, version: 4 });
    await inspectPublished();
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => button("Remove published version 3").click());
    expect(apiWrite).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(dialog.textContent).toContain("Readers lose this Comic right away.");
    const submit = () => button("Remove published version", dialog);
    expect(submit().disabled).toBe(true);
    await fillDialog("Decision reason", "Removed after a rights complaint");
    await fillDialog("Type this Comic ID to confirm", "not-the-comic");
    expect(submit().disabled).toBe(true);
    await fillDialog("Type this Comic ID to confirm", "comic-fixture");
    await act(async () => submit().click());
    expect(apiWrite.mock.calls).toEqual([["/api/v2/admin/comics/comic-fixture/decision", "POST", {
      version: 3, reason: "Removed after a rights complaint", decision: "remove", confirmation: "comic-fixture",
    }]]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toast).toHaveBeenCalledWith({ tone: "success", title: "Published Comic version removed." });
  });

  it("keeps a failed removal in the dialog and rereads the Comic when the operator gives up", async () => {
    apiWrite.mockRejectedValueOnce(new AdminV2RequestError("Comic changed", 409, "conflict", { blocker: "version_mismatch" }));
    await inspectPublished();
    await act(async () => button("Remove published version 3").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    await fillDialog("Decision reason", "Removed after a rights complaint");
    await fillDialog("Type this Comic ID to confirm", "comic-fixture");
    await act(async () => button("Remove published version", dialog).click());
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Someone changed this record");
    expect(toast).not.toHaveBeenCalled();
    const readsBefore = apiGet.mock.calls.length;
    await act(async () => button("Cancel", dialog).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(apiGet.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(apiGet).toHaveBeenLastCalledWith("/api/v2/admin/comics/comic-fixture");
  });

  it("confirms approve with a toast and answers the shell refresh with a reread of queue and inspection", async () => {
    apiWrite.mockResolvedValueOnce(published);
    await mount();
    await act(async () => button("Review pages").click());
    await reason("Reviewed every submitted page");
    await act(async () => button("Approve version 3").click());
    expect(toast).toHaveBeenCalledWith({ tone: "success", title: "Comic version approved and published." });
    const readsBefore = apiGet.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(apiGet.mock.calls.slice(readsBefore).map(([path]) => path)).toEqual([
      "/api/v2/admin/comics?status=pending_review&limit=12", "/api/v2/admin/comics/comic-fixture",
    ]);
  });

  it("labels the failed decision's recovery as Reload, rereads without writing, and keeps the failure visible", async () => {
    apiWrite.mockRejectedValueOnce(new AdminV2RequestError("Comic write unavailable", 503, "unavailable"));
    await mount();
    await act(async () => button("Review pages").click());
    await reason("Reviewed every submitted page");
    await act(async () => button("Approve version 3").click());
    const alert = () => container.querySelector('[role="alert"]');
    expect(alert()?.textContent).toContain("whether the write landed is unknown");
    expect([...alert()!.querySelectorAll("button")].map((node) => node.textContent).slice(0, 2)).toEqual(["Reload", "Dismiss"]);
    await act(async () => button("Reload").click());
    expect(apiWrite).toHaveBeenCalledTimes(1);
    expect(alert()?.textContent).toContain("whether the write landed is unknown");
    await act(async () => button("Dismiss").click());
    expect(alert()).toBeNull();
  });

  it("pages forward and back through the queue instead of an append-only load-more", async () => {
    apiGet.mockImplementation(async (path: string) => path.includes("cursor=page-2")
      ? { items: [{ ...summary, id: "comic-two", title: "Second page Comic" }], nextCursor: null }
      : { items: [summary], nextCursor: "page-2" });
    await mount();
    await act(async () => button("Next page").click());
    expect(container.textContent).toContain("Second page Comic");
    expect(container.textContent).not.toContain("Controlled Comic");
    await act(async () => button("Previous page").click());
    expect(container.textContent).toContain("Controlled Comic");
    expect(button("Previous page").disabled).toBe(true);
  });

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
