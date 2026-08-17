import { describe, expect, it } from "vitest";
import {
  CHARACTER_PORTFOLIO_DEFAULT_SORT,
  CHARACTER_PORTFOLIO_SORTS,
  characterPortfolioQuery,
  parseCharacterPortfolioUrl,
} from "./portfolio-query";

describe("Character Portfolio URL authority", () => {
  it("restores supported filters and cursor from a shareable canonical URL", () => {
    expect(parseCharacterPortfolioUrl(
      "?search=aurora%20sky&phase=launch_ready&servingState=paused&readiness=blocked&cursor=opaque",
    )).toEqual({
      search: "aurora sky",
      phase: "launch_ready",
      servingState: "paused",
      readiness: "blocked",
      cursor: "opaque",
    });
  });

  it("drops unknown finite states and keeps browser URLs free of transport defaults", () => {
    const restored = parseCharacterPortfolioUrl(
      "?search=needle&phase=unknown&servingState=broken&readiness=maybe",
    );
    expect(restored).toEqual({ search: "needle" });
    expect(characterPortfolioQuery(restored)).toBe("search=needle");
    expect(characterPortfolioQuery(restored, true)).toBe(
      "limit=25&sort=project_id_asc&search=needle",
    );
  });

  // SPEC: 「需要处理」要能分享和刷新——它是运营每天的入口，必须活在 URL 里而不是组件 state 里。
  it("round-trips the needs-attention entry point through the URL", () => {
    expect(parseCharacterPortfolioUrl("?attention=true")).toMatchObject({ attention: true });
    expect(characterPortfolioQuery({ search: "", attention: true })).toBe("attention=true");
    expect(parseCharacterPortfolioUrl("?attention=1").attention).toBeUndefined();
    expect(characterPortfolioQuery({ search: "" })).toBe("");
  });

  // SPEC: 排序键必须能分享和刷新 —— 它决定 keyset 游标的含义，跟筛选一样是查询的一部分。
  it("round-trips every sort the authority accepts and rejects the rest", () => {
    for (const sort of CHARACTER_PORTFOLIO_SORTS) {
      expect(parseCharacterPortfolioUrl(`?sort=${sort}`)).toMatchObject({ sort });
      expect(characterPortfolioQuery({ search: "", sort })).toBe(`sort=${sort}`);
    }
    // 契约会用 .strict() 挡下没见过的值；与其发出去换一个 400，不如在这里就退回默认。
    expect(parseCharacterPortfolioUrl("?sort=qce_desc").sort).toBeUndefined();
  });

  it("sends the contract default when the operator has not chosen a sort", () => {
    expect(characterPortfolioQuery({ search: "" }, true)).toBe(
      `limit=25&sort=${CHARACTER_PORTFOLIO_DEFAULT_SORT}`,
    );
    // 默认值不写进地址栏 —— 分享出去的链接只带运营真的选过的东西。
    expect(characterPortfolioQuery({ search: "" })).toBe("");
  });
});
