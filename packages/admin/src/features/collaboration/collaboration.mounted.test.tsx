// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string, init?: { method?: string }) => Promise<unknown>>(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { CollaborationPanel } from "./CollaborationPanel";
import { SavedViewsControl } from "./SavedViewsControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const savedView = {
  id: "view-1",
  scope: "case" as const,
  label: "Overdue billing",
  queryState: { search: "", filters: { view: "overdue" }, sort: { field: "updated_at", direction: "desc" as const }, pageSize: 30 },
  version: 3,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

const currentState = savedView.queryState;

// React 覆盖了 value 的 setter，直接赋值不会触发 onChange —— 走原型上的原生 setter 才行。
function setReactValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the collaboration UI");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("collaboration write safety", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    adminV2Request.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    document.querySelectorAll('[role="dialog"]').forEach((node) => node.parentElement?.remove());
    vi.restoreAllMocks();
  });

  // 覆盖共享视图会改变同事下次打开看到的查询，此前一点即写，没有任何确认。
  it("requires a confirmation before overwriting a shared Saved View", async () => {
    adminV2Request.mockImplementation(async () => ({ items: [savedView] }));
    await act(async () => {
      root = createRoot(container);
      root.render(<SavedViewsControl currentState={currentState} onApply={() => undefined} onSelectedChange={() => undefined} scope="case" selectedId="view-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.textContent?.includes("Overwrite v") === true);

    const overwrite = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Overwrite v"));
    await act(async () => overwrite?.click());

    expect(adminV2Request.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Overwrite the shared Saved View");
    expect(dialog?.textContent).toContain("Overdue billing");
  });

  // handoff 会在服务端换掉记录的 ownerId 并 +1 version；父级不重拉就会拿着陈旧 version 去撞 409。
  it("tells the parent record to reload after a handoff transfers ownership", async () => {
    const authorityChanged = vi.fn();
    adminV2Request.mockImplementation(async (path, init) => {
      if (init?.method === "POST") return { activity: { id: "activity-1" }, authority: { ownerId: "operator-2", version: 5 } };
      return { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<CollaborationPanel canWrite onAuthorityChange={authorityChanged} targetId="case-1" targetType="case" targetVersion={4} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.querySelector("select") !== null);

    await act(async () => setReactValue(container.querySelector("select")!, "handoff"));
    await act(async () => setReactValue(container.querySelector<HTMLInputElement>('input[list="collaboration-actor-ids"]:not([placeholder])')!, "operator-2"));
    await act(async () => setReactValue(container.querySelector("textarea")!, "Taking this to the billing queue"));
    await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitUntil(() => authorityChanged.mock.calls.length > 0);

    expect(authorityChanged).toHaveBeenCalledTimes(1);
  });
});
