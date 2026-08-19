import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { navItems } from "./nav-config";

// SPEC: 导航里的每个目的地都必须落到它自己的路由，不能被同级的动态段吃掉。
//
// INTENT: admin 用一个可选 catch-all (`app/admin/[[...section]]`) 兜住大多数页面，少数页面另建
// 显式路由只为给准确的标题。问题出在两者之间：Next 的匹配优先级是「同深度的动态段 > 外层
// catch-all」，所以 `/admin/characters/starters` 会被 `app/admin/characters/[id]` 抢走，而不是
// 落到 catch-all。页面内容照常渲染（nav-config 的 CANONICAL_LIST_SECTIONS 先于 `{id}` 兜底解析），
// 于是这个 bug 只在浏览器标题里露头——「角色起始模板」和「分类法」两个页面都自称
// 「Character Detail」。没有任何测试会发现它。
//
// INVARIANT: 若某个 nav href 的某一层没有字面目录、却存在同级动态段目录，就是被吃掉了，必须为它
// 建显式 page.tsx。三者都没有 ⇒ 由 catch-all 接管，是设计内的。
const APP_ADMIN = join(process.cwd(), "src", "app", "admin");

function dynamicSiblings(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // `[[...x]]` 是可选 catch-all，本来就该兜底；只有 `[x]` / `[...x]` 才会抢占同级路径。
    .filter((name) => name.startsWith("[") && !name.startsWith("[["));
}

function swallowedByDynamicSegment(href: string) {
  const path = href.split("?")[0].replace(/^\/admin\/?/, "");
  if (!path) return null;
  const segments = path.split("/");
  let directory = APP_ADMIN;
  for (const segment of segments) {
    const literal = join(directory, segment);
    if (!existsSync(literal)) {
      const swallowing = dynamicSiblings(directory);
      return swallowing.length > 0
        ? { href, missing: literal, swallowedBy: swallowing }
        : null;
    }
    directory = literal;
  }
  return existsSync(join(directory, "page.tsx"))
    ? null
    : { href, missing: join(directory, "page.tsx"), swallowedBy: [] };
}

describe("admin navigation route coverage", () => {
  it("never lets a dynamic segment swallow a navigable destination", () => {
    const swallowed = navItems
      .map((item) => swallowedByDynamicSegment(item.href))
      .filter((entry) => entry !== null);

    expect(swallowed).toEqual([]);
  });
});
