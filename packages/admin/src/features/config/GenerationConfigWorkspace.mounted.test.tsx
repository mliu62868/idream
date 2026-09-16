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

describe("disabled model profile visibility", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    apiGet.mockImplementation(async (path) => ({
      items: path.startsWith("/api/v2/admin/generation/model-profiles") ? [
        { id: "h3", label: "H3", mode: "video", status: "active", version: 4, enabled: false },
        { id: "redgraft", label: "RedGraft", mode: "video", status: "active", version: 2, enabled: true, rollbackTarget: { id: "redgraft-v1", version: 1 } },
      ] : [],
      pageInfo: { endCursor: null, hasNextPage: false },
    }));
    window.history.replaceState(null, "", "/admin/ops/profiles");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it.each([
    // INVARIANT: 停用是单向的 —— 权威在这条 PATCH 上只接受 enabled:false，
    //            被停用的版本再也回不来（model-profiles.ts:305-314）。确认框必须这么说。
    // INVARIANT: 而且它还会连累目录：绑在这个版本上的已发布 Release 会被巡检打成 stale，
    //            正在服务它的公开角色被降为 unlisted（release-monitor.ts:174-195），
    //            两件事都不自愈。确认框不说这句，运营就是在不知情的情况下下架角色。
    ["en", "Profile disabled", "Disable", "this version can never be enabled again", "This cannot be undone.", "drops to unlisted"],
    ["zh", "已停用", "禁用", "这个版本再也无法重新启用", "这个操作无法撤回。", "降为 unlisted"],
  ] as const)("distinguishes a disabled active profile and explains restoration in %s", async (locale, disabled, disableAction, restoration, irreversible, cascade) => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminI18nProvider locale={locale}><GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} /></AdminI18nProvider>);
    });
    await waitUntil(() => [...container.querySelectorAll("h2")].some(heading => heading.textContent === "H3"));
    const rows = [...container.querySelectorAll("button")];
    const h3 = rows.find(button => button.querySelector("span")?.textContent === "H3")!;
    const redgraft = rows.find(button => button.querySelector("span")?.textContent === "RedGraft")!;
    expect(h3.textContent).toContain(disabled);
    expect(h3.textContent).toContain("v4");
    expect(redgraft.textContent).not.toContain(disabled);
    const detail = () => [...container.querySelectorAll("h2")].find(heading => ["H3", "RedGraft"].includes(heading.textContent ?? ""))!.closest("section")!;
    expect(detail().textContent).toContain(disabled);
    expect([...detail().querySelectorAll("button")].some(button => button.textContent === (locale === "zh" ? "回滚" : "Rollback"))).toBe(false);
    expect([...detail().querySelectorAll("button")].some(button => button.textContent === disableAction)).toBe(false);

    await act(async () => redgraft.click());
    expect(detail().textContent).not.toContain(disabled);
    expect(detail().textContent).toContain("redgraft-v1 · v1");
    expect([...detail().querySelectorAll("button")].some(button => button.textContent === (locale === "zh" ? "回滚" : "Rollback"))).toBe(true);
    await act(async () => [...detail().querySelectorAll("button")].find(button => button.textContent === disableAction)!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(restoration);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(irreversible);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(cascade);
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("second edit on this same profile");
    expect(apiWrite).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])("translates profile state, mode and %i recent jobs at the rendered boundary", async count => {
    apiGet.mockImplementation(async path => ({
      items: path.startsWith("/api/v2/admin/generation/model-profiles")
        ? [{ id: "image-profile", label: "image", mode: "image", status: "active", version: 2, enabled: true, runner: "comfyui", pipelineModel: "active" }]
        : path.startsWith("/api/v2/admin/jobs")
          ? Array.from({ length: count }, (_, index) => ({ id: `test-${index}`, profileId: "image-profile", profileVersion: 2, sourceType: "admin_profile_test" }))
          : [],
      pageInfo: { endCursor: null, hasNextPage: false },
    }));
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminI18nProvider locale="zh"><GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} /></AdminI18nProvider>);
    });
    await waitUntil(() => [...container.querySelectorAll("h2")].some(heading => heading.textContent === "image"));
    const profileButton = [...container.querySelectorAll("button")].find(button => button.querySelector("span")?.textContent === "image")!;
    expect(profileButton.querySelectorAll("span")[1].textContent).toBe("启用 · v2 · 图片");
    const detail = [...container.querySelectorAll("h2")].find(heading => heading.textContent === "image")!.closest("section")!;
    // SPEC: operator enums are translated; authored model names and runtime identifiers retain their original spelling.
    expect(detail.querySelector("p")?.textContent).toBe("启用 · v2 · comfyui · active");
    const jobCount = [...detail.querySelectorAll("p")].find(node => node.textContent?.includes("近期配置测试任务"));
    expect(jobCount?.textContent).toBe(`${count} 个近期配置测试任务`);
  });

  it("isolates review drafts by profile and version and restores the URL selection", async () => {
    let version = 1;
    apiGet.mockImplementation(async path => ({ items: path.startsWith("/api/v2/admin/generation/model-profiles") ? [
      { id: "a", label: "Profile A", mode: "image", status: "draft", version },
      { id: "b", label: "Profile B", mode: "image", status: "draft", version: 1 },
    ] : [] }));
    window.history.replaceState(null, "", "/admin/ops/profiles?profile=b");
    await act(async () => {
      root = createRoot(container);
      root.render(<GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />);
    });
    await waitUntil(() => [...container.querySelectorAll("h2")].some(heading => heading.textContent === "Profile B"));
    const samples = () => [...container.querySelectorAll("label")].find(label => label.textContent === "Consistency samples (≥20)")!.querySelector("input")!;
    const setValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => setValue(samples(), "20"));
    const passes = [...container.querySelectorAll("label")].find(label => label.textContent === "Consistency passes (≥80%)")!.querySelector("input")!;
    await act(async () => setValue(passes, "19"));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Publish")!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Review evidence: b · v1 · 19/20");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const select = (name: string) => [...container.querySelectorAll("button")].find(button => button.querySelector("span")?.textContent === name)!.click();
    await act(async () => select("Profile A"));
    expect(samples().value).toBe("");
    expect(new URLSearchParams(window.location.search).get("profile")).toBe("a");
    await act(async () => select("Profile B"));
    expect(samples().value).toBe("20");
    await act(async () => select("Profile A"));
    await act(async () => setValue(samples(), "25"));
    version = 2;
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitUntil(() => container.textContent?.includes("a · v2") === true);
    expect(samples().value).toBe("");
  });

  it("closes a confirmation when its reviewed profile changes on refresh", async () => {
    let updatedAt = "2026-09-16T01:00:00Z";
    apiGet.mockImplementation(async path => ({ items: path.startsWith("/api/v2/admin/generation/model-profiles")
      ? [{ id: "p", label: "Draft", mode: "video", status: "draft", version: 1, updatedAt }] : [] }));
    await act(async () => {
      root = createRoot(container);
      root.render(<GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />);
    });
    await waitUntil(() => [...container.querySelectorAll("button")].some(button => button.textContent === "Publish"));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Publish")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    updatedAt = "2026-09-16T02:00:00Z";
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitUntil(() => !document.querySelector('[role="dialog"]'));
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("queries profile tests, excludes other versions, and restores an older tracked job", async () => {
    window.history.replaceState(null, "", "/admin/ops/profiles?profile=p&testJob=older-test");
    apiGet.mockImplementation(async path => {
      if (path.startsWith("/api/v2/admin/generation/model-profiles")) return { items: [{ id: "p", profileKey: "portrait", label: "Portrait", mode: "image", status: "draft", version: 2 }] };
      if (path === "/api/v2/admin/jobs/older-test") return { request: { id: "older-test", profileId: "portrait", profileVersion: 2, sourceType: "admin_profile_test", legacyStatus: "failed", errorCode: "PROVIDER_TIMEOUT", assetCount: 0 } };
      return { items: path.startsWith("/api/v2/admin/jobs?") ? [{ id: "old-version", profileId: "portrait", profileVersion: 1, sourceType: "admin_profile_test" }, { id: "customer-job", profileId: "portrait", profileVersion: 2, sourceType: "user" }] : [] };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />);
    });
    await waitUntil(() => container.textContent?.includes("PROVIDER_TIMEOUT") === true);
    expect(container.textContent).not.toContain("old-version");
    expect(container.textContent).not.toContain("customer-job");
    expect(container.textContent).toContain("No output");
    expect(container.querySelector('a[href="/admin/ops/jobs?mode=image&job=older-test"]')).not.toBeNull();
    expect(apiGet.mock.calls.some(([path]) => path.includes("sourceType=admin_profile_test&search=portrait"))).toBe(true);
    apiGet.mockClear();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh")!.click());
    expect(apiGet).toHaveBeenCalledWith("/api/v2/admin/jobs/older-test");
  });

  it("restores a linked profile outside the current result page without choosing another profile", async () => {
    window.history.replaceState(null, "", "/admin/ops/profiles?profile=outside");
    apiGet.mockImplementation(async path => ({ items: path.startsWith("/api/v2/admin/generation/model-profiles")
      ? new URL(path, "http://localhost").searchParams.get("search") === "outside"
        ? [{ id: "outside", label: "Linked profile", mode: "image", status: "draft", version: 3 }]
        : [{ id: "first", label: "First page profile", mode: "image", status: "draft", version: 1 }]
      : [] }));
    await act(async () => {
      root = createRoot(container);
      root.render(<GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />);
    });
    await waitUntil(() => [...container.querySelectorAll("h2")].some(heading => heading.textContent === "Linked profile"));
    expect(container.textContent).toContain("Review evidence: outside · v3");
    expect([...container.querySelectorAll("h2")].some(heading => heading.textContent === "First page profile")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("profile")).toBe("outside");
  });

  it("keeps recent results visible when a pinned test fails to load and retries that test", async () => {
    window.history.replaceState(null, "", "/admin/ops/profiles?profile=p&testJob=older-test");
    let unavailable = true;
    apiGet.mockImplementation(async path => {
      if (path.startsWith("/api/v2/admin/generation/model-profiles")) return { items: [{ id: "p", mode: "image", status: "draft", version: 2 }] };
      if (path === "/api/v2/admin/jobs/older-test") {
        if (unavailable) throw new Error("Pinned test unavailable");
        return { request: { id: "older-test", profileId: "p", profileVersion: 2, sourceType: "admin_profile_test", legacyStatus: "failed", errorCode: "TIMEOUT" } };
      }
      return { items: path.startsWith("/api/v2/admin/jobs?") ? [{ id: "recent-test", profileId: "p", profileVersion: 2, sourceType: "admin_profile_test", legacyStatus: "completed", assetCount: 1 }] : [] };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />);
    });
    await waitUntil(() => container.textContent?.includes("Pinned test unavailable") === true);
    expect(container.querySelector('a[href="/admin/ops/jobs?mode=image&job=recent-test"]')).not.toBeNull();
    unavailable = false;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh")!.click());
    await waitUntil(() => container.textContent?.includes("TIMEOUT") === true);
    expect(container.textContent).not.toContain("Pinned test unavailable");
    expect(container.querySelector('a[href="/admin/ops/jobs?mode=image&job=recent-test"]')).not.toBeNull();
  });

  it("ignores a previous profile's delayed test response after selection changes", async () => {
    let resolveA!: (value: unknown) => void;
    apiGet.mockImplementation(async path => {
      if (path.startsWith("/api/v2/admin/generation/model-profiles")) return { items: [
        { id: "a", label: "Profile A", mode: "image", status: "draft", version: 1 },
        { id: "b", label: "Profile B", mode: "image", status: "draft", version: 1 },
      ] };
      if (path.includes("search=a")) return new Promise(resolve => { resolveA = resolve; });
      return { items: path.includes("search=b") ? [{ id: "b-test", profileId: "b", profileVersion: 1, sourceType: "admin_profile_test" }] : [] };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} />);
    });
    await waitUntil(() => Boolean(resolveA));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.querySelector("span")?.textContent === "Profile B")!.click());
    await waitUntil(() => container.textContent?.includes("b-test") === true);
    await act(async () => resolveA({ items: [{ id: "a-test", profileId: "a", profileVersion: 1, sourceType: "admin_profile_test" }] }));
    expect(container.textContent).toContain("b-test");
    expect(container.textContent).not.toContain("a-test");
  });

  it("keeps draft authoring unavailable when the authority disables diagnostics", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminI18nProvider locale="en"><GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} /></AdminI18nProvider>);
    });
    await waitUntil(() => container.textContent?.includes("Profile authoring is disabled") === true);
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Create profile draft")).toBe(false);
  });

  it("opens profile authoring from an empty catalogue when the authority enables it", async () => {
    apiGet.mockResolvedValue({ items: [], authoringEnabled: true, pageInfo: { endCursor: null, hasNextPage: false } });
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminI18nProvider locale="en"><GenerationConfigWorkspace permissions={{ manageFlags: true, manageProfiles: true }} /></AdminI18nProvider>);
    });
    await waitUntil(() => [...container.querySelectorAll("button")].some(button => button.textContent === "Create profile draft"));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Create profile draft")!.click());
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).toContain("Saving a draft does not change live traffic");
  });

});

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
