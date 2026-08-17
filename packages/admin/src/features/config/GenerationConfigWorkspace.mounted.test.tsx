// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { GenerationConfigWorkspace } from "./GenerationConfigWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for generation config workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * SPEC: 功能开关这张表走 ui/DataTable，和后台其它十几张列表同一套表现层。
 *
 * INTENT: 它以前是这一簇里唯一一张手写 <table> —— 列头不过 t()（中文界面里印英文），
 * 布尔值直接 String(enabled) 印成 `true`/`false`，也拿不到骨架 / 空态 / 粘性列。
 */
describe("feature flags table", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  /** 每页一行，行的 key 就是这一页请求时用的 cursor —— 断言时一眼看出停在哪一页。 */
  function flagPage(cursor: string) {
    const pages: Record<string, { key: string; endCursor: string | null }> = {
      "": { key: "flag-page-1", endCursor: "cursor-2" },
      "cursor-2": { key: "flag-page-2", endCursor: null },
    };
    const page = pages[cursor] ?? pages[""]!;
    return {
      items: [
        {
          key: page.key,
          enabled: true,
          rolloutPercent: 25,
          version: 3,
          hardPolicy: false,
        },
      ],
      pageInfo: { endCursor: page.endCursor, hasNextPage: page.endCursor !== null },
    };
  }

  function flagsTable() {
    return container.querySelector('[aria-label="Feature flags scrollable table"]');
  }

  function pagerButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
  }

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    apiGet.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/feature-flags")) {
        return flagPage(new URL(path, "http://admin.test").searchParams.get("cursor") ?? "");
      }
      return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
    });
    window.history.replaceState(null, "", "/admin/system/config?tab=settings");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />,
      );
    });
    await waitUntil(() => container.textContent?.includes("flag-page-1") ?? false);
  }

  it("renders the flags through the shared table primitive", async () => {
    await mount();
    const table = flagsTable();
    expect(table).not.toBeNull();
    // 列头由 DataTable 过 t()，不再是手写 <th> 里的裸字符串。
    expect(table?.textContent).toContain("Hard policy");
    expect(table?.querySelector("caption")?.textContent).toBe("Feature flags");
  });

  // SPEC: 布尔值走通用占位口径，和后台其它表一致；`true` / `false` 不是给人读的。
  it("shows booleans in the shared wording instead of raw true/false", async () => {
    await mount();
    const table = flagsTable()?.textContent ?? "";
    expect(table).toContain("yes");
    expect(table).toContain("no");
    expect(table).not.toContain("true");
    expect(table).not.toContain("false");
  });

  // INVARIANT: 第一页没有上一页，但按钮要在场且置灰——藏起来运营就不知道它存在。
  it("greys out Previous page until the operator has paged forward", async () => {
    await mount();
    expect(pagerButton("Previous page")?.disabled).toBe(true);

    await act(async () => pagerButton("Next page")?.click());
    await waitUntil(() => container.textContent?.includes("flag-page-2") ?? false);
    expect(pagerButton("Previous page")?.disabled).toBe(false);
    expect(pagerButton("Next page")?.disabled).toBe(true);
  });
});
