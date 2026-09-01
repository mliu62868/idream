import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";
import { ADMIN_WORKSPACES, navItems } from "./nav-config";

// Keys this redesign introduced that aren't derived from nav-config (in-page
// tab/section labels, not sidebar nav items) — each must still have a zh translation.
const OWNED_KEYS = ["Batch production", "Generate for character", "Character", "Visual Identity"];

describe("admin i18n — redesigned nav has zh", () => {
  it("translates every key this refactor owns", () => {
    for (const key of OWNED_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});

// SPEC: 工作模式可以改变哪些目的地常驻，但所有目的地和分组都必须有真实中文翻译。
// INTENT: 直接遍历导航权威，避免为测试保留已经从产品中删除的 daily/folded 导出模型。
describe("admin i18n — every navigation destination has zh", () => {
  it("translates every workspace header", () => {
    for (const group of ADMIN_WORKSPACES) expect(hasAdminZh(group)).toBe(true);
  });

  it("translates every destination label", () => {
    for (const item of navItems) expect(hasAdminZh(item.label)).toBe(true);
  });
});
