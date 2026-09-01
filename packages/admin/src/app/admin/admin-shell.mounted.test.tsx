// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import {
  ADMIN_LOCALE_COOKIE,
  DEFAULT_ADMIN_SHELL_PREFERENCES,
  type AdminShellPreferences,
} from "@/components/admin/shell-preferences";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SPEC: 挂载时不给当前页的读权限——内容区落到"无此工作区权限"面板，于是这组测试只碰
//       外壳本身（顶栏、侧栏、账号菜单），不需要给任何工作台的取数打桩。
function shellProps(overrides: {
  initialSection?: string;
  permissions?: AdminPermissionKey[];
  preferences?: Partial<AdminShellPreferences>;
} = {}) {
  return {
    actor: { id: "operator-1", role: "admin" },
    initialAccess: true,
    initialPermissions: overrides.permissions ?? [],
    initialSection: overrides.initialSection ?? "today",
    preferences: { ...DEFAULT_ADMIN_SHELL_PREFERENCES, ...overrides.preferences },
    shellSignals: {
      environment: "local" as const,
      dataClass: "fixture" as const,
      fixtureState: "included" as const,
      productTimezone: "UTC",
      freshness: { state: "reported" as const, label: "2026-08-16T00:00:00.000Z" },
    },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mountShell(props = shellProps()) {
  container = document.createElement("div");
  container.innerHTML = renderToString(<AdminConsoleClient {...props} />);
  document.body.append(container);
  await act(async () => {
    root = hydrateRoot(container!, <AdminConsoleClient {...props} />);
  });
}

function searchInput() {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Global admin search"]');
  if (!input) throw new Error("Global admin search input is missing from the shell");
  return input;
}

function accountMenuTrigger() {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-controls="admin-account-menu"]');
  if (!trigger) throw new Error("Account menu trigger is missing from the shell");
  return trigger;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.cookie = `${ADMIN_LOCALE_COOKIE}=; path=/; max-age=0`;
});

describe("admin shell keyboard and account menu", () => {
  it("focuses the global search from anywhere with the keyboard shortcut", async () => {
    await mountShell();

    for (const modifier of ["metaKey", "ctrlKey"] as const) {
      searchInput().blur();
      await act(async () => {
        document.dispatchEvent(
          new window.KeyboardEvent("keydown", { bubbles: true, key: "k", [modifier]: true }),
        );
      });
      expect(document.activeElement, modifier).toBe(searchInput());
    }
  });

  it("clears and releases the search on Escape", async () => {
    await mountShell();
    const input = searchInput();

    // 受控 input 必须走原生 value setter，否则 React 的 value tracker 认为没变，onChange 不触发。
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "amy");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(searchInput().value).toBe("amy");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => {
      searchInput().dispatchEvent(
        new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });

    expect(searchInput().value).toBe("");
    expect(document.activeElement).not.toBe(searchInput());
  });

  // SPEC: 数据来源没有被删——它只是离开了常驻正文流，搬进账号菜单。
  it("keeps provenance, language, and work mode reachable inside the account menu", async () => {
    await mountShell();

    expect(document.querySelector('[data-testid="admin-shell-signals"]')).toBeNull();
    await act(async () => accountMenuTrigger().click());

    const signals = document.querySelector('[data-testid="admin-shell-signals"]');
    expect(signals?.textContent).toContain("local");
    expect(signals?.textContent).toContain("UTC");
    expect(document.querySelector('select[aria-label="Work mode"]')).not.toBeNull();
    expect(document.querySelector('select[aria-label="Language"]')).not.toBeNull();
  });

  // SPEC: 偏好写 cookie，不写 localStorage —— 服务端必须能在下一次导航的首帧就读到它。
  it("persists a language change to a cookie the server can read", async () => {
    await mountShell();

    await act(async () => accountMenuTrigger().click());
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
    await act(async () => {
      select.value = "zh";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });

    expect(document.cookie).toContain(`${ADMIN_LOCALE_COOKIE}=zh`);
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem(ADMIN_LOCALE_COOKIE)).toBeNull();
  });

  // SPEC: 常驻导航只保留最高频对象；其余能力先进入业务工作区，而不是平铺成几十个同级入口。
  it("expands the workspace directory in place", async () => {
    await mountShell(shellProps({
      permissions: ["admin.approval.review"],
    }));
    const workspaceToggle = [...document.querySelectorAll<HTMLButtonElement>("aside nav button")]
      .find((button) => button.textContent?.includes("Workspaces"));

    expect(workspaceToggle).toBeDefined();
    expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => workspaceToggle!.click());

    expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("true");
    expect([...document.querySelectorAll<HTMLAnchorElement>("aside nav a")]
      .some((link) => link.textContent?.includes("System"))).toBe(true);
  });

  // SPEC: 侧栏按工作区收敛；区内先展示常规任务，低频工具再渐进披露，不能退化成搜索或记 URL。
  it("keeps every permitted tool reachable without flattening subviews into the sidebar", async () => {
    await mountShell(shellProps({
      initialSection: "ops/jobs",
      permissions: ["generation.job.read", "ops.queue.read"],
      preferences: { workMode: "support" },
    }));
    const workspaceToggle = [...document.querySelectorAll<HTMLButtonElement>("aside nav button")]
      .find((button) => button.textContent?.includes("Workspaces"));

    expect(workspaceToggle).toBeDefined();
    expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("true");

    const sidebarHrefs = [...document.querySelectorAll<HTMLAnchorElement>("aside nav a")]
      .map((link) => link.getAttribute("href"));
    expect(sidebarHrefs).toContain("/admin/ops/jobs");
    expect(sidebarHrefs).not.toContain("/admin/ops/jobs?view=dead-letter");
    expect(sidebarHrefs).not.toContain("/admin/ops/providers?view=backends");

    const sectionToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="admin-workspace-section-menu"]',
    );
    expect(sectionToggle?.textContent).toContain("Platform Operations");
    await act(async () => sectionToggle!.click());

    const mainSectionHrefs = [...document.querySelectorAll<HTMLAnchorElement>(
      '#admin-workspace-section-menu a',
    )].map((link) => link.getAttribute("href"));
    expect(mainSectionHrefs).toContain("/admin/ops/jobs");
    expect(mainSectionHrefs).toContain("/admin/ops/providers");
    expect(mainSectionHrefs).not.toContain("/admin/ops/jobs?view=dead-letter");
    expect(mainSectionHrefs).not.toContain("/admin/ops/providers?view=backends");

    const toolsToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="admin-workspace-tools-menu"]',
    );
    expect(toolsToggle?.textContent).toContain("Tools & diagnostics");
    expect(toolsToggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toolsToggle!.click());

    const toolHrefs = [...document.querySelectorAll<HTMLAnchorElement>(
      '#admin-workspace-tools-menu a',
    )].map((link) => link.getAttribute("href"));
    expect(toolHrefs).toContain("/admin/ops/jobs?view=dead-letter");
    expect(toolHrefs).toContain("/admin/ops/providers?view=backends");
  });

  // SPEC: 常见 13 英寸 Chrome 内容宽度约 1272px，已经属于桌面工作区，不应退回抽屉导航。
  // SPEC: 工作区菜单在常见 840px 高视口里应直接露出完整工具列表，低矮窗口才滚动。
  it("uses the desktop shell from 1200px and gives the workspace menu enough visible height", async () => {
    await mountShell(shellProps({
      initialSection: "ops/jobs?view=dead-letter",
      permissions: ["generation.job.read", "ops.queue.read"],
      preferences: { workMode: "support" },
    }));

    const desktopSidebar = document.querySelector<HTMLElement>("main > div > aside");
    const mobileTrigger = document.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]');
    expect(desktopSidebar?.className).toContain("min-[1200px]:flex");
    expect(mobileTrigger?.className).toContain("min-[1200px]:hidden");

    const sectionToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="admin-workspace-section-menu"]',
    );
    await act(async () => sectionToggle!.click());
    expect(document.querySelector<HTMLElement>("#admin-workspace-section-menu")?.className)
      .toContain("max-h-[min(80vh,40rem)]");
  });

  // SPEC: 搜索结果在同一个 Next 路由段内只更新 query 时，工作区目录与页头切换器都要跟着新页面。
  it("reopens Workspaces when the mounted shell enters another low-frequency destination", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => {}));
    const permissions: AdminPermissionKey[] = ["ops.queue.read", "generation.job.read"];
    try {
      const jobsProps = shellProps({ initialSection: "ops/jobs", permissions });
      await mountShell(jobsProps);
      const workspaceToggle = [...document.querySelectorAll<HTMLButtonElement>("aside nav button")]
        .find((button) => button.textContent?.includes("Workspaces"));

      expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("true");
      await act(async () => workspaceToggle!.click());
      expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        root!.render(
          <AdminConsoleClient
            {...shellProps({ initialSection: "ops/jobs?view=dead-letter", permissions })}
          />,
        );
      });

      expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("true");
      const sectionToggle = document.querySelector<HTMLButtonElement>(
        'button[aria-controls="admin-workspace-section-menu"]',
      );
      await act(async () => sectionToggle!.click());
      const toolsToggle = document.querySelector<HTMLButtonElement>(
        'button[aria-controls="admin-workspace-tools-menu"]',
      );
      expect(toolsToggle?.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('#admin-workspace-tools-menu [aria-current="page"]')?.textContent)
        .toContain("Dead-letter");
    } finally {
      fetchMock.mockRestore();
    }
  });

  // SPEC: 兼容工具不是侧栏一级入口，但只要命令尚未合并，就必须从所属工作区可发现。
  it("surfaces a compatibility-only tool through its workspace", async () => {
    await mountShell(shellProps({
      initialSection: "support",
      permissions: ["case.read", "support.request.read"],
    }));

    const workspaceToggle = [...document.querySelectorAll<HTMLButtonElement>("aside nav button")]
      .find((button) => button.textContent?.includes("Workspaces"));
    expect(workspaceToggle?.getAttribute("aria-expanded")).toBe("true");
    const sidebarHrefs = [...document.querySelectorAll<HTMLAnchorElement>("aside nav a")]
      .map((link) => link.getAttribute("href"));
    expect(sidebarHrefs).toContain("/admin/cases?view=mine");
    expect(sidebarHrefs).not.toContain("/admin/support");

    const sectionToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="admin-workspace-section-menu"]',
    );
    await act(async () => sectionToggle!.click());
    expect(document.querySelector<HTMLButtonElement>(
      'button[aria-controls="admin-workspace-tools-menu"]',
    )?.getAttribute("aria-expanded")).toBe("true");
    expect([...document.querySelectorAll<HTMLAnchorElement>(
      '#admin-workspace-tools-menu a',
    )].some((link) => link.getAttribute("href") === "/admin/support")).toBe(true);
  });

  // SPEC: 如果账号只有一个低频工具权限，该工具就是工作区入口；渐进披露不能把唯一能力藏掉。
  it("uses a tool as the workspace entry when it is the only permitted destination", async () => {
    await mountShell(shellProps({
      initialSection: "support",
      permissions: ["support.request.read"],
    }));

    const workspaceHrefs = [...document.querySelectorAll<HTMLAnchorElement>("aside nav a")]
      .map((link) => link.getAttribute("href"));
    expect(workspaceHrefs).toContain("/admin/support");
    expect(document.querySelector('button[aria-controls="admin-workspace-section-menu"]')).toBeNull();
  });
});
