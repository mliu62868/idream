// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// 外壳交互不依赖工作台数据，避免导航挂载用例向本地 Main 发出请求。
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.restoreAllMocks();
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

  function navButton(label: string, scope: ParentNode = document) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>("aside nav button")]
      .find((button) => button.textContent === label);
    if (!button) throw new Error(`Missing navigation button: ${label}`);
    return button;
  }

  function sidebarHrefs() {
    return [...document.querySelectorAll<HTMLAnchorElement>("aside nav a")]
      .map((link) => link.getAttribute("href"));
  }

  it("shows business groups immediately and expands without navigating to an arbitrary page", async () => {
    await mountShell(shellProps({ permissions: ["admin.approval.review", "billing.read"] }));
    expect([...document.querySelectorAll("aside nav button")].map((node) => node.textContent))
      .toEqual(["Customers & Support", "Revenue & Marketing", "System"]);
    expect(sidebarHrefs()).not.toContain("/admin/system/approvals");
    const before = window.location.href;
    await act(async () => navButton("System").click());
    expect(navButton("System").getAttribute("aria-expanded")).toBe("true");
    expect(sidebarHrefs()).toContain("/admin/system/approvals");
    expect(window.location.href).toBe(before);
    expect(document.querySelector('button[aria-controls="admin-workspace-section-menu"]')).toBeNull();
  });

  it("reveals operational tools in the sidebar while keeping routine pages directly visible", async () => {
    await mountShell(shellProps({
      initialSection: "ops/jobs",
      permissions: ["generation.job.read", "ops.queue.read"],
      preferences: { workMode: "support" },
    }));
    expect(navButton("Platform Operations").getAttribute("aria-expanded")).toBe("true");
    expect(sidebarHrefs()).toContain("/admin/ops/jobs");
    expect(sidebarHrefs()).toContain("/admin/ops/providers");
    expect(sidebarHrefs()).not.toContain("/admin/ops/jobs?view=dead-letter");
    await act(async () => navButton("Tools & diagnostics").click());
    expect(sidebarHrefs()).toContain("/admin/ops/jobs?view=dead-letter");
    expect(sidebarHrefs()).toContain("/admin/ops/providers?view=backends");
    expect(document.querySelectorAll('aside nav [aria-current="page"]')).toHaveLength(1);
  });

  it("reopens the current group and tools after a query-only route change", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => {}));
    const permissions: AdminPermissionKey[] = ["ops.queue.read", "generation.job.read"];
    try {
      await mountShell(shellProps({ initialSection: "ops/jobs", permissions }));
      await act(async () => navButton("Platform Operations").click());
      expect(navButton("Platform Operations").getAttribute("aria-expanded")).toBe("false");
      await act(async () => {
        root!.render(<AdminConsoleClient {...shellProps({ initialSection: "ops/jobs?view=dead-letter", permissions })} />);
      });
      expect(navButton("Platform Operations").getAttribute("aria-expanded")).toBe("true");
      expect(navButton("Tools & diagnostics").getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('aside nav [aria-current="page"]')?.textContent).toBe("Dead-letter");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps compatibility tools discoverable and opens their active deep links", async () => {
    await mountShell(shellProps({ initialSection: "support", permissions: ["case.read", "support.request.read"] }));
    expect(sidebarHrefs()).toContain("/admin/cases?view=mine");
    expect(sidebarHrefs()).toContain("/admin/support");
    expect(navButton("History & specialist tools").getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('aside nav [aria-current="page"]')?.textContent).toBe("Support Cases");
  });

  it("shows a tool-only account its actual page without a redundant tools disclosure", async () => {
    await mountShell(shellProps({ initialSection: "support", permissions: ["support.request.read"] }));
    expect(sidebarHrefs()).toEqual(["/admin/support"]);
    expect([...document.querySelectorAll("aside nav button")].map((node) => node.textContent))
      .toEqual(["Customers & Support"]);
  });

  it("keeps mobile navigation isolated, traps focus, and restores it on Escape", async () => {
    await mountShell(shellProps({ permissions: ["billing.read", "admin.approval.review"] }));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!;
    expect(trigger.className).toContain("min-[1200px]:hidden");
    expect(document.querySelector("main > div > aside")?.className).toContain("min-[1200px]:flex");
    await act(async () => trigger.click());
    const drawer = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Admin navigation"]')!;
    expect(drawer).not.toBeNull();
    expect(document.getElementById("admin-main-content")?.hasAttribute("inert")).toBe(true);
    const group = [...drawer.querySelectorAll<HTMLButtonElement>("nav button")]
      .find((node) => node.textContent === "Revenue & Marketing")!;
    await act(async () => group.click());
    expect([...drawer.querySelectorAll("a")].map((node) => node.getAttribute("href")))
      .toEqual(["/admin/customer-ops/billing", "/admin/growth/offers?view=pricing"]);
    const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const focusable = [...drawer.querySelectorAll<HTMLElement>("button, a[href]")];
    await act(async () => {
      focusable.at(-1)!.focus();
      focusable.at(-1)!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    });
    expect(document.activeElement).toBe(focusable[0]);
    await act(async () => {
      focusable[0].dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey: true }));
    });
    expect(document.activeElement).toBe(focusable.at(-1));
    await act(async () => drawer.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(document.querySelector('[role="dialog"][aria-label="Admin navigation"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.getElementById("admin-main-content")?.hasAttribute("inert")).toBe(false);
  });
});
