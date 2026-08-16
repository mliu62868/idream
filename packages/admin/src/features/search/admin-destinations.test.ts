import { describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { ALL_SECTION_ITEMS, navItems } from "@/components/admin/nav-config";
import { matchAdminDestinations } from "./admin-destinations";

const everything = new Set<AdminPermissionKey>(
  ALL_SECTION_ITEMS.flatMap((item) => item.read.allOf),
);

function ids(query: string, permissions: ReadonlySet<AdminPermissionKey> = everything) {
  return matchAdminDestinations(query, permissions).map((destination) => destination.id);
}

describe("admin destination search", () => {
  // SPEC: 同一份索引同时认中文和英文——界面语言不决定运营能打出什么。
  it("matches a destination by its Chinese label and by its English label", () => {
    expect(ids("死信")).toContain("generation/dead-letter");
    expect(ids("dead-letter")).toContain("generation/dead-letter");
    expect(ids("配置与灰度")).toContain("generation/config");
    expect(ids("Profiles")).toContain("generation/config");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(ids("  TAXONOMY ")).toContain("content/tags");
  });

  // SPEC: 子视图的英文名只存在于 ?view= 里，标签上看不到，所以 URL 也要进索引。
  it("matches the query-string name of a sub-view destination", () => {
    expect(ids("workflows")).toContain("generation/workflows");
    expect(ids("presets")).toContain("generation/presets");
  });

  it("matches a whole group by its name", () => {
    expect(ids("Character Studio")).toEqual(
      expect.arrayContaining(["content/official", "content/review-queue", "content/templates"]),
    );
    expect(ids("角色工作室").length).toBeGreaterThan(1);
  });

  // SPEC: 命中页名排在命中分组名/URL 之前；页名前缀命中又排在页名包含命中之前。
  it("ranks a page-name prefix above a page-name substring above a group hit", () => {
    // "Cases" 前缀命中；"Support Cases" / "Moderation Cases" 只是包含。
    expect(ids("case")[0]).toBe("cases");

    const ranked = matchAdminDestinations("character", everything, 20)
      .map((destination) => destination.id);
    // "Characters" 前缀命中，排最前；"Taxonomy" 只因为分组叫 Character Studio 才入选，排最后。
    expect(ranked[0]).toBe("content/official");
    expect(ranked.indexOf("content/tags")).toBeGreaterThan(ranked.indexOf("content/review-queue"));
  });

  // SPEC: 那三个不在侧栏、只能靠记 URL 到达的兼容目的地也必须搜得到。
  it("reaches the compatibility destinations that navigation does not list", () => {
    expect(navItems.some((item) => item.id === "moderation")).toBe(false);
    expect(ids("Moderation Cases")).toContain("moderation");
    expect(ids("审核工单")).toContain("moderation");
    expect(ids("Risk Cases")).toContain("risk");
    expect(ids("Support Cases")).toContain("support");
  });

  // SPEC: 无权限的目的地不进候选——否则 Enter 之后只会撞上「无此工作区权限」。
  it("never offers a destination the operator cannot read", () => {
    const queuedOnly = new Set<AdminPermissionKey>(["ops.queue.read"]);
    expect(ids("死信", queuedOnly)).toEqual(["generation/dead-letter"]);
    expect(ids("Taxonomy", queuedOnly)).toEqual([]);
    expect(matchAdminDestinations("a", new Set())).toEqual([]);
  });

  it("returns nothing for an empty query and caps how many it returns", () => {
    expect(matchAdminDestinations("", everything)).toEqual([]);
    expect(matchAdminDestinations("   ", everything)).toEqual([]);
    expect(matchAdminDestinations("a", everything).length).toBeLessThanOrEqual(6);
    expect(matchAdminDestinations("a", everything, 2)).toHaveLength(2);
  });

  it("carries the href and icon needed to render and follow the destination", () => {
    const [deadLetter] = matchAdminDestinations("死信", everything);
    expect(deadLetter.href).toBe("/admin/ops/jobs?view=dead-letter");
    expect(deadLetter.label).toBe("Dead-letter");
    expect(deadLetter.group).toBe("Platform Operations");
    expect(typeof deadLetter.icon).not.toBe("undefined");
  });
});
