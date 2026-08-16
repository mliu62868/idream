// @vitest-environment happy-dom

// SPEC: 保存的视图是本页唯一的破坏性写操作。此前那个垃圾桶图标点一下就直接发 DELETE ——
//       没有确认、没有撤销、双击会发两次。本用例锁住"点图标不写、确认了才写、且只写一次"。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewQueueView } from "./ReviewQueueView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const savedView = {
  id: "saved-view-1",
  scope: "moderation_review_queue",
  label: "Reported only",
  queryState: {
    search: "",
    filters: { reportFilter: "reported" },
    sort: { field: "created_at", direction: "asc" },
    pageSize: 25,
  },
  version: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("ReviewQueueView saved-view deletion", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("never deletes on the icon click alone, and deletes exactly once after the name is confirmed", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/api/v2/admin/saved-views") && (init?.method ?? "GET") === "DELETE") {
        return Response.json({ ok: true, data: { deleted: true } });
      }
      if (path.includes("/api/v2/admin/saved-views")) {
        return Response.json({ ok: true, data: { items: [savedView] } });
      }
      return Response.json({
        ok: true,
        data: { items: [], pageInfo: { endCursor: null, hasNextPage: false } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ReviewQueueView />);
    });
    await waitFor(() => container.textContent?.includes("Reported only") ?? false);

    const trash = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete saved view Reported only"]',
    );
    expect(trash).not.toBeNull();

    // 双击垃圾桶：以前这里会发出两个 DELETE，现在应该一个都没有。
    await act(async () => {
      trash?.click();
      trash?.click();
    });
    expect(deleteCalls(fetchMock)).toHaveLength(0);

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Reported only");

    const submit = dialogButton(dialog, "Delete");
    expect(submit?.disabled).toBe(true);

    const nameInput = dialog?.querySelector<HTMLInputElement>("input");
    expect(nameInput).not.toBeNull();
    await changeInput(nameInput!, "Reported only");

    await act(async () => {
      dialogButton(dialog, "Delete")?.click();
    });
    await waitFor(() => deleteCalls(fetchMock).length === 1);

    expect(deleteCalls(fetchMock)).toHaveLength(1);
    // 成功后必须说话——25 个静默写操作里的一个。
    await waitFor(() => container.textContent?.includes("Saved view Reported only deleted.") ?? false);
  });
});

function deleteCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, options]) =>
    (options as RequestInit | undefined)?.method === "DELETE"
  );
}

function dialogButton(dialog: HTMLElement | null, label: string) {
  return Array.from(dialog?.querySelectorAll("button") ?? []).find(
    (button) => button.textContent?.trim() === label,
  );
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Condition did not become true");
}
