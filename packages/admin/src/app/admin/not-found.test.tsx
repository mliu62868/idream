import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/admin/growth/funnel" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

const { default: AdminNotFound } = await import("./not-found");

function render(path: string) {
  pathname.current = path;
  return renderToStaticMarkup(<AdminNotFound />);
}

// SPEC: 到这一页多半是 URL 打错或旧书签失效，所以它必须回答「我敲的是什么」和「我该去哪」。
// INTENT: 这一页原来只有一句硬编码中文加一个「返回今日工作」——运营在上面唯一能做的事就是
//         关掉它，或者回到起点重新一层层找。
describe("admin not-found — an exit, not a dead end", () => {
  it("shows the operator the URL that failed", () => {
    expect(render("/admin/growth/funnel")).toContain("/admin/growth/funnel");
  });

  it("offers the closest real destinations for a mistyped URL", () => {
    const markup = render("/admin/growth/funnel");

    expect(markup).toContain("You may be looking for");
    // funnel 只差一个字母就是那条导航项自己的 href。
    expect(markup).toContain("/admin/growth/funnels");
    expect(markup).toContain("Profile Diagnostics");
  });

  it("suggests destinations from a partial page name too", () => {
    const markup = render("/admin/taxonom");

    expect(markup).toContain("Taxonomy");
    expect(markup).toContain("/admin/characters/taxonomy");
  });

  it("still gives a way out when nothing resembles the URL", () => {
    const markup = render("/admin/zzzzqqq");

    expect(markup).not.toContain("You may be looking for");
    expect(markup).toContain('href="/admin/today"');
  });

  // SPEC: 这一页在 AdminI18nProvider 之外，但它说的必须是运营选的那门语言。
  // INTENT: 整页曾经硬编码中文，英文 locale 下直接露馅。
  it("carries no hardcoded copy in either language", async () => {
    const source = await import("node:fs/promises")
      .then((fs) => fs.readFile(new URL("./not-found.tsx", import.meta.url), "utf8"));

    expect(source).not.toMatch(/>[^<>{]*[一-鿿][^<>{]*</);
    expect(source).toContain("readAdminLocaleFromDocument");
    expect(source).toContain("translateAdmin");
    // 目的地匹配复用命令面板那一份，不另立第二套。
    expect(source).toContain("matchAdminDestinations");
  });
});
