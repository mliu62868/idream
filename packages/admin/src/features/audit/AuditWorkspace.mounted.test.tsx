// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>() }));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite: vi.fn(), apiDelete: vi.fn() }));

import { AuditWorkspace } from "./AuditWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 一次批量操作写出的四条同类记录 —— 折叠后只剩第一条可见。
const batchRun = ["a", "b", "c", "d"].map((suffix) => ({
  id: `audit-${suffix}`,
  action: "character.image_readiness.repaired",
  actorId: "system:editorial",
  actorRole: "system",
  reason: "Adopt the live editorial portrait as image-production input",
  targetType: "character_project",
  targetId: `project-${suffix}`,
  createdAt: "2026-08-20T01:00:00.000Z",
}));

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the audit workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("audit repeat collapsing and row selection", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ items: batchRun, pageInfo: { endCursor: null, hasNextPage: false } });
    window.history.replaceState(null, "", "/admin/audit-log");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function clickButton(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Button not found: ${label}`);
    return act(async () => button.click());
  }

  function checkboxes() {
    return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
      (input) => input.getAttribute("aria-label")?.startsWith("Select row "),
    );
  }

  async function mounted() {
    await act(async () => {
      root = createRoot(container);
      root.render(<AuditWorkspace />);
    });
    await waitUntil(() => checkboxes().length > 0);
  }

  // SPEC: 折叠默认开着，四条同类只显示第一条。
  it("shows one row per run and says how many it hid", async () => {
    await mounted();

    expect(checkboxes()).toHaveLength(1);
    expect(container.textContent).toContain("3 repeats of the row above are hidden");
  });

  // SPEC: 折起来的行必须同时退出勾选。
  // INTENT: DataTable 的「全选」只作用于可见行，所以"展开 → 全选 → 折叠"之后 selectedRows 里
  //         留着三条屏幕上已经看不见的 ID，选择条会说「4 selected」而只有一个框是勾的，
  //         「复制选中 ID」跟着复制到运营从没看过的行。审计日志上这是硬伤。
  it("drops rows from the selection when collapsing hides them", async () => {
    await mounted();
    await clickButton("Show every row");
    expect(checkboxes()).toHaveLength(4);

    const selectAll = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.getAttribute("aria-label") === "Select all rows on this page");
    if (!selectAll) throw new Error("Select-all checkbox is missing");
    await act(async () => selectAll.click());
    expect(container.textContent).toContain("4 selected");

    await clickButton("Hide repeats");

    expect(checkboxes()).toHaveLength(1);
    expect(container.textContent).toContain("1 selected");
    expect(container.textContent).not.toContain("4 selected");
  });
});
