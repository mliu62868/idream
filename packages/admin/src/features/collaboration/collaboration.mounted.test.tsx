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

  // 覆盖个人已保存视图不可恢复，必须保留确认。
  it("requires a confirmation before overwriting the operator's Saved View", async () => {
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
    expect(dialog?.textContent).toContain("Overwrite Saved View");
    expect(dialog?.textContent).toContain("Overdue billing");
    // 后端只存当前 queryState，没有版本历史 —— 覆盖不可恢复，所以要常驻红条 + 确认串。
    expect(dialog?.textContent).toContain("This cannot be undone.");
    expect(dialog?.querySelector('input[aria-label="Saved view name"]')).not.toBeNull();
  });

  // 删除同样要求敲名字：当前操作者的私有视图没有回收站。
  it("requires the view name before deleting the operator's Saved View", async () => {
    adminV2Request.mockImplementation(async () => ({ items: [savedView] }));
    await act(async () => {
      root = createRoot(container);
      root.render(<SavedViewsControl currentState={currentState} onApply={() => undefined} onSelectedChange={() => undefined} scope="case" selectedId="view-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.textContent?.includes("Delete") === true);

    const remove = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("Delete saved view"));
    await act(async () => remove?.click());

    expect(adminV2Request.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Overdue billing");
    expect(dialog?.textContent).toContain("There is no recycle bin.");
    expect(dialog?.textContent).toContain("This cannot be undone.");
    expect(dialog?.querySelector('input[aria-label="Saved view name"]')).not.toBeNull();
  });

  // handoff 会在服务端换掉记录的 ownerId 并 +1 version；父级不重拉就会拿着陈旧 version 去撞 409。
  it("tells the parent record to reload after a handoff transfers ownership", async () => {
    const authorityChanged = vi.fn(async () => undefined);
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

  it("keeps a committed handoff locked until readback succeeds and retries only the read", async () => {
    const authorityChanged = vi.fn().mockRejectedValueOnce(new Error("readback unavailable")).mockResolvedValue(undefined);
    adminV2Request.mockImplementation(async (_path, init) => init?.method === "POST"
      ? { activity: { id: "activity-1" }, authority: { ownerId: "operator-2", version: 5 } }
      : { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } });
    await act(async () => {
      root = createRoot(container);
      root.render(<CollaborationPanel canWrite onAuthorityChange={authorityChanged} targetId="case-1" targetType="case" targetVersion={4} />);
    });
    await waitUntil(() => container.querySelector("select") !== null);
    await act(async () => setReactValue(container.querySelector("select")!, "handoff"));
    await act(async () => setReactValue(container.querySelector<HTMLInputElement>('input[list="collaboration-actor-ids"]:not([placeholder])')!, "operator-2"));
    await act(async () => setReactValue(container.querySelector("textarea")!, "Please own the resolution"));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(container.textContent).toContain("Ownership transferred and recorded in the activity timeline.");
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!;
    await act(async () => retry.click());
    await waitUntil(() => container.querySelector('[role="alert"]') === null);
    expect(authorityChanged).toHaveBeenCalledTimes(2);
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects a retained form submission after its authority was locked or replaced", async () => {
    adminV2Request.mockImplementation(async (_path, init) => init?.method === "POST"
      ? { activity: { id: "activity-1" } }
      : { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } });
    const render = async (canWrite: boolean, version = 4) => act(async () => {
      root ??= createRoot(container);
      root.render(<CollaborationPanel canWrite={canWrite} onAuthorityChange={async () => undefined} targetId="case-1" targetType="case" targetVersion={version} />);
    });
    await render(true);
    await waitUntil(() => container.querySelector("textarea") !== null);
    await act(async () => setReactValue(container.querySelector("textarea")!, "Queued handoff evidence"));
    const form = container.querySelector("form")!;
    // Capture the actual mounted handler before the parent removes the form. A DOM-only
    // assertion would miss callbacks already retained by another interaction.
    const propsKey = Object.getOwnPropertyNames(container.querySelector("textarea")!).find(key => key.startsWith("__reactProps$"))!;
    const retainedSubmit = Reflect.get(form, propsKey).onSubmit as (event: { preventDefault: () => void }) => void;
    await render(false);
    await act(async () => retainedSubmit({ preventDefault: () => undefined }));
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await render(true);
    await act(async () => retainedSubmit({ preventDefault: () => undefined }));
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await render(true, 5);
    await act(async () => retainedSubmit({ preventDefault: () => undefined }));
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitUntil(() => adminV2Request.mock.calls.some(([, init]) => init?.method === "POST"));
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("preserves Watch for readers while activity writes are unavailable", async () => {
    let watching = false;
    adminV2Request.mockImplementation(async (_path, init) => {
      if (init?.method === "PUT") { watching = true; return { watching }; }
      return { items: [], actors: [], watching, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<CollaborationPanel canWrite={false} onAuthorityChange={async () => undefined} targetId="case-1" targetType="case" targetVersion={4} />);
    });
    const watch = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Watch")!;
    await waitUntil(() => Boolean(watch()) && !watch().disabled);
    expect(container.querySelector("form")).toBeNull();
    await act(async () => watch().click());
    await waitUntil(() => container.textContent?.includes("Stop watching") === true);
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(adminV2Request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});
