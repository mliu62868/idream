import { describe, expect, it } from "vitest";
import { ALL_SECTION_ITEMS } from "./nav-config";
import { ADMIN_SECTION_IDS, adminRouteExists, matchAdminRoute } from "./nav-routes";

describe("admin route layer", () => {
  // SPEC: proxy 判"存在"、页面判"解析得出导航项"，两者必须一致。
  // INTENT: 任何一边多出一个 id，就又回到了 proxy 说 200 / 页面渲 404（或反过来）的分裂。
  //         多出来的 id 是编译错误（NavItem["id"] 取自 AdminSectionId），少了的由这条拦。
  it("keeps the proxy's id list and the navigation items in exact lockstep", () => {
    expect([...ADMIN_SECTION_IDS].sort())
      .toEqual(ALL_SECTION_ITEMS.map((item) => item.id).sort());
  });

  // SPEC: 每一个导航项自己的 href 都必须解析得回它自己。
  it("resolves every published href back to its own section", () => {
    for (const item of ALL_SECTION_ITEMS) {
      const href = item.href.replace(/^\/admin\/?/, "");
      expect(matchAdminRoute(href)?.sectionId, item.href).toBe(item.id);
      if (item.legacyHref && item.legacyHref !== "/admin") {
        const legacy = item.legacyHref.replace(/^\/admin\/?/, "");
        expect(matchAdminRoute(legacy)?.sectionId, item.legacyHref).toBe(item.id);
      }
    }
  });

  // SPEC: 认不出就是 null —— proxy 靠这个把状态码定成 404。
  it("refuses unknown paths so the proxy can answer 404", () => {
    expect(adminRouteExists("definitely-not-a-route")).toBe(false);
    expect(adminRouteExists("nope/deeper")).toBe(false);
    expect(adminRouteExists("characters/review/extra/deep")).toBe(false);
    expect(adminRouteExists("")).toBe(false);
    expect(adminRouteExists("today")).toBe(true);
    expect(adminRouteExists("characters/char-1")).toBe(true);
    expect(adminRouteExists("ops/recipes?view=presets")).toBe(true);
    // 别名与隐藏兼容项都算存在，不能被 proxy 当成拼错的 URL 拦掉。
    expect(adminRouteExists("generation/models")).toBe(true);
    expect(adminRouteExists("moderation")).toBe(true);
  });

  it("keeps sub-views attached to the query string that distinguishes them", () => {
    expect(matchAdminRoute("ops/jobs?view=dead-letter")?.sectionId).toBe("generation/dead-letter");
    expect(matchAdminRoute("ops/jobs")?.sectionId).toBe("generation/jobs");
    expect(matchAdminRoute("growth/merchandising?view=announcements")?.sectionId).toBe("announcements");
    expect(matchAdminRoute("characters/new")?.view).toEqual({ kind: "new" });
    expect(matchAdminRoute("cases/case-1")?.view).toEqual({ kind: "detail", id: "case-1" });
  });
});
