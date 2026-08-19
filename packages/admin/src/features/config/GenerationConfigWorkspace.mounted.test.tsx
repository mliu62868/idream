// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { AdminI18nProvider } from "@/components/admin/i18n";
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

/**
 * SPEC: 中文 locale 下，页面外壳（筛选、分页签、时效行）不许露出英文源串。
 *
 * INTENT: 这一层的破口不是词典缺词，而是**接收方组件没过 t()** —— Field / Select / Tab /
 * Freshness / Action 五个本地组件都直接渲染 {label}，于是调用点传的裸字符串原样打到屏幕上。
 * i18n-completeness.test.ts 只验证"词典里有这个 key"，验证不到"渲染时查了词典"，所以它全绿
 * 而中文后台照样印着 Profile mode / Flag state。这里用 zh locale 真挂载，堵住那条缝。
 */
describe("Chinese locale: workspace chrome", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    apiGet.mockImplementation(async () => ({
      items: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    }));
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

  async function mountZh() {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <AdminI18nProvider locale="zh">
          <GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />
        </AdminI18nProvider>,
      );
    });
  }

  it("translates the filter labels instead of printing the raw prop", async () => {
    await mountZh();
    const text = container.textContent ?? "";

    expect(text).toContain("配置档案模式");
    expect(text).toContain("配置档案状态");
    expect(text).toContain("开关状态");
    expect(text).not.toContain("Profile mode");
    expect(text).not.toContain("Profile status");
    expect(text).not.toContain("Flag state");
  });

  it("translates the tab label and its subtitle", async () => {
    await mountZh();
    const text = container.textContent ?? "";

    expect(text).toContain("测试和发布");
    expect(text).toContain("功能开关");
    expect(text).not.toContain("Test and publish");
  });

  // SPEC: 空态文案由 `hint={filtered ? "A" : "B"}` 这种三元喂给 ui/EmptyState 的 t()。
  // INTENT: 这类 key 源码里没有一处 t("字面量")，i18n-completeness.test.ts 认不出来，
  // 于是它们缺了中文词条也没人报警——这里用真挂载兜住。
  it("translates the empty state fed through a conditional expression", async () => {
    await mountZh();
    const text = container.textContent ?? "";

    expect(text).toContain("还没有任何功能开关");
    expect(text).toContain("权威里还没有任何功能开关。");
    expect(text).not.toContain("No feature flags exist");
  });

  // SPEC: "开关状态"筛选的取值是查询串里的 true/false，不是领域枚举 —— 它们不进全局 zhValues，
  // 由 Select 的 booleanOptions 就地映射成开关语义。断言下拉里读到的是人话。
  it("renders the boolean flag filter as enabled/disabled wording", async () => {
    await mountZh();
    const options = [...container.querySelectorAll("option")].map((option) => option.textContent);

    expect(options).toContain("已启用");
    expect(options).toContain("已关闭");
    expect(options).not.toContain("true");
    expect(options).not.toContain("false");
  });
});
