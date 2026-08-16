// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_NAV_GROUPS_COOKIE,
  DEFAULT_ADMIN_SHELL_PREFERENCES,
  type AdminShellPreferences,
} from "@/components/admin/shell-preferences";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SPEC: 挂载时不给当前页的读权限——内容区落到"无此工作区权限"面板，于是这组测试只碰
//       外壳本身（顶栏、侧栏、账号菜单），不需要给任何工作台的取数打桩。
function shellProps(overrides: {
  permissions?: AdminPermissionKey[];
  preferences?: Partial<AdminShellPreferences>;
} = {}) {
  return {
    actor: { id: "operator-1", role: "admin" },
    initialAccess: true,
    initialPermissions: overrides.permissions ?? [],
    initialSection: "today",
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
  for (const name of [ADMIN_LOCALE_COOKIE, ADMIN_NAV_GROUPS_COOKIE]) {
    document.cookie = `${name}=; path=/; max-age=0`;
  }
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

  it("persists an expanded nav group to a cookie", async () => {
    await mountShell(shellProps({
      permissions: ["content.read"],
      preferences: { openNavGroups: [] },
    }));
    const groupToggle = [...document.querySelectorAll<HTMLButtonElement>("aside nav button")]
      .find((button) => button.textContent?.includes("Growth"));

    expect(groupToggle).toBeDefined();
    await act(async () => groupToggle!.click());

    expect(decodeURIComponent(document.cookie))
      .toContain(`${ADMIN_NAV_GROUPS_COOKIE}=["Growth"]`);
  });
});
