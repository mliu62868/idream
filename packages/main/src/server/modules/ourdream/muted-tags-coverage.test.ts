import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mutedTagExclusionWhere, normalizeMutedTagSlugs } from "./public-content-audience";

// SPEC: 用户静音一个标签后，所有面向他的公开角色列表都不再推该标签的角色。
// INTENT: 这条过滤原先只写在 explore 的 listCharacters 里。实测静音 `elf` 之后
//         /api/v1/characters 从 16 条降到 15 条，而 /api/v1/feed 与
//         /api/v1/community/leaderboard 照旧返回那个角色 —— 用户显式表达的偏好
//         在三个面上被无视。缺陷的形状是「只有一个面施加了过滤」，所以守卫也盯这个。

describe("muted tag exclusion", () => {
  it("is inert when the viewer muted nothing", () => {
    expect(mutedTagExclusionWhere([])).toBeUndefined();
  });

  it("excludes characters carrying any muted tag", () => {
    expect(mutedTagExclusionWhere(["elf", "slow-burn"])).toEqual({
      tags: { some: { tag: { slug: { in: ["elf", "slow-burn"] } } } },
    });
  });

  // INVARIANT: 读取端与写入端必须用同一套 slug 规则，否则存进去的读不出来。
  it("normalises the same way the write path does", () => {
    expect(normalizeMutedTagSlugs(["Slow Burn", "slow burn", "  ELF  ", ""])).toEqual([
      "slow-burn",
      "elf",
    ]);
  });

  it("caps the stored set so preferences cannot grow without bound", () => {
    const many = Array.from({ length: 200 }, (_, index) => `tag-${index}`);
    expect(normalizeMutedTagSlugs(many)).toHaveLength(80);
  });
});

describe("every public character surface applies it", () => {
  // 这四个面各自组装 where，没有共同的调用点可以断言，所以退一步守住
  // 「都引用了同一个 helper」——漏接一个面时这条会红。
  const SURFACES = [
    ["explore (listCharacters)", "service.ts"],
    ["feed / community / creator profile", "discovery.ts"],
  ] as const;

  for (const [label, file] of SURFACES) {
    it(`wires the shared exclusion into ${label}`, () => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).toContain("mutedTagSlugsForUser");
    });
  }

  it("applies it to each of the three discovery surfaces, not just one", () => {
    const source = readFileSync(new URL("./discovery.ts", import.meta.url), "utf8");
    // feed、community、creatorProfile 各一次。
    const uses = source.match(/mutedTagExclusionWhere\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });
});
