// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request, translate, displayValue } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string) => Promise<unknown>>(),
  translate: (value: string) => value,
  displayValue: (value: string) => value.replaceAll("_", " "),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

vi.mock("@/components/admin/i18n", () => ({
  useAdminI18n: () => ({ locale: "en" as const, t: translate, value: displayValue }),
}));

vi.mock("@/features/collaboration/CollaborationPanel", () => ({
  CollaborationPanel: () => <div data-testid="collaboration-panel" />,
}));

import { CreativeRunWorkspace } from "./CreativeRunWorkspace";

const permissions = { read: true, write: false, review: false, place: false };

// INTENT: React 会接管 input 的 value setter，直接赋值不会触发 onChange，
//         必须走原型上的原生 setter 再派发 input 事件。
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function searchInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>("form input");
  if (!input) throw new Error("The Creative Run search input is missing.");
  return input;
}

function listPage(id: string) {
  return {
    items: [
      {
        id,
        title: `Run ${id}`,
        purpose: "feed",
        executionOutcome: "succeeded",
        reviewState: "approved",
        deploymentState: "placed",
        verificationState: "verified",
        workflowStage: "complete",
        ownerId: null,
        target: { type: "none" as const },
        counts: {
          total: 1,
          generated: 1,
          failed: 0,
          approved: 1,
          placed: 1,
        },
        updatedAt: "2026-07-16T12:00:00.000Z",
      },
    ],
    pageInfo: { endCursor: null, hasNextPage: false },
    asOf: "2026-07-16T12:00:00.000Z",
  };
}

describe("Creative Run list projection", () => {
  let container: HTMLDivElement;
  let root: Root;
  const requested: string[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.useFakeTimers();
    requested.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path: string) => {
      requested.push(path);
      return listPage(`run-${requested.length}`);
    });
    window.history.replaceState(null, "", "/admin/creative/runs");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "list" }}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("restores the query from the address bar and reads it exactly once", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/creative/runs?search=hero&executionOutcome=failed",
    );
    await mount();

    // INVARIANT: 挂载只发一个请求——地址栏恢复不得在默认查询之外再打一枪。
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("search=hero");
    expect(requested[0]).toContain("executionOutcome=failed");
    expect(
      container.querySelector('a[href="/admin/creative/runs/run-1"]'),
    ).not.toBeNull();
  });

  it("does not refetch while the operator is still typing in the filter form", async () => {
    await mount();
    expect(requested).toHaveLength(1);

    const input = searchInput(container);
    await act(async () => setInputValue(input, "hero"));
    expect(input.value).toBe("hero");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // SPEC: 表单草稿与已生效查询分开，打字不触发取数。
    expect(requested).toHaveLength(1);
  });

  it("fetches the new query and records it in history only when Apply is submitted", async () => {
    await mount();
    await act(async () => setInputValue(searchInput(container), "hero"));
    const form = container.querySelector("form");
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("search=hero");
    expect(window.location.search).toContain("search=hero");
    expect(
      container.querySelector('a[href="/admin/creative/runs/run-2"]'),
    ).not.toBeNull();
  });

  it("keeps a failed first load reportable instead of showing an empty result", async () => {
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async () => {
      throw new Error("Creative projection unavailable");
    });
    await mount();

    // INVARIANT: 首次取数失败必须与"查询成功但没有结果"区分开。
    expect(container.textContent).toContain("Creative projection unavailable");
    expect(container.textContent).toContain("No successful query yet");
  });
});
