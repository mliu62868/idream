// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AdminNavigation } from "./AdminNavigation";
import { ALL_SECTION_ITEMS, navGroupsForPermissions } from "./nav-config";
import { ADMIN_WORK_MODES } from "./shell-preferences";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 检查真实目录能否展开到每个已授权目的地，而非仅验证配置中存在这些记录。
it.each(ADMIN_WORK_MODES)("makes every authorized page reachable in %s mode", async (mode) => {
  const host = document.createElement("nav");
  document.body.append(host);
  const root = createRoot(host);
  const permissions = new Set(ALL_SECTION_ITEMS.flatMap((item) => item.read.allOf));
  const groups = navGroupsForPermissions(permissions, mode);
  const found = new Set<string>();
  const collect = () => {
    for (const link of host.querySelectorAll("a")) found.add(link.getAttribute("href")!);
  };
  try {
    await act(async () => root.render(<AdminNavigation activeItem={ALL_SECTION_ITEMS[0]} groups={groups} />));
    collect();
    for (const { group } of groups.filter(({ group }) => group !== "Today")) {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === group)!;
      await act(async () => button.click());
      const tools = [...host.querySelectorAll("button")].find((node) =>
        node.textContent === "Tools & diagnostics" || node.textContent === "History & specialist tools");
      if (tools) await act(async () => tools.click());
      collect();
    }
    expect(found).toEqual(new Set(ALL_SECTION_ITEMS.map((item) => item.href)));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("brings a deep-linked tool into the navigation viewport without scrolling the document", async () => {
  const host = document.createElement("nav");
  document.body.append(host);
  const root = createRoot(host);
  const permissions = new Set(ALL_SECTION_ITEMS.flatMap((item) => item.read.allOf));
  const activeItem = ALL_SECTION_ITEMS.find((item) => item.id === "generation/dead-letter")!;
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 56, 248, 400));
  vi.spyOn(HTMLAnchorElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLAnchorElement) {
      return new DOMRect(0, 800 - host.scrollTop, 220, 44);
    });
  try {
    await act(async () => root.render(
      <AdminNavigation activeItem={activeItem} groups={navGroupsForPermissions(permissions, "admin")} />,
    ));
    const current = host.querySelector('[aria-current="page"]')!;
    expect(current.textContent).toBe("Dead-letter");
    expect(current.getBoundingClientRect().bottom).toBeLessThanOrEqual(host.getBoundingClientRect().bottom);
    expect(host.scrollTop).toBeGreaterThan(0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    host.remove();
  }
});
