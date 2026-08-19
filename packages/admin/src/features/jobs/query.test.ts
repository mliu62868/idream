import { describe, expect, it } from "vitest";
import {
  buildGenerationJobQuery,
  changedGenerationJobFilters,
  defaultGenerationJobQuery,
  isGenerationJobQueryFiltered,
  parseGenerationJobQuery,
} from "./query";

describe("Generation Jobs URL query", () => {
  it("round trips every visible control into the exact v2 API query", () => {
    const query = {
      search: "timeout",
      mode: "image" as const,
      legacyStatus: "failed",
      provider: "provider-alpha",
      sourceType: "creative_run",
      userId: "user-1",
      characterId: "character-1",
      sort: "cost_desc" as const,
      limit: 25,
      cursor: "opaque-cursor",
    };
    const encoded = buildGenerationJobQuery(query);
    expect(encoded).toBe("search=timeout&mode=image&legacyStatus=failed&provider=provider-alpha&sourceType=creative_run&userId=user-1&characterId=character-1&sort=cost_desc&limit=25&cursor=opaque-cursor");
    expect(parseGenerationJobQuery(new URLSearchParams(encoded))).toEqual(query);
  });

  it("fails closed to supported defaults for stale URL state", () => {
    expect(parseGenerationJobQuery(new URLSearchParams("mode=audio&sort=random&limit=999&clientRows=50"))).toEqual({
      search: "",
      mode: "image",
      legacyStatus: "",
      provider: "",
      sourceType: "",
      userId: "",
      characterId: "",
      sort: "created_desc",
      limit: 25,
      cursor: undefined,
    });
  });
});

describe("Generation Jobs active filters", () => {
  // SPEC: 默认 mode=image 不是中性值 —— 「非空即生效」会让每次打开页面都挂着一枚 Mode 芯片。
  it("treats the default query as unfiltered even though mode is not empty", () => {
    expect(changedGenerationJobFilters(defaultGenerationJobQuery)).toEqual([]);
    expect(isGenerationJobQueryFiltered(defaultGenerationJobQuery)).toBe(false);
  });

  it("names every condition the operator actually changed, in field order", () => {
    const query = parseGenerationJobQuery(new URLSearchParams("mode=video&legacyStatus=failed&userId=user-1&sort=cost_desc&cursor=page-2"));

    expect(changedGenerationJobFilters(query).map((filter) => [filter.key, filter.value])).toEqual([
      ["mode", "video"],
      ["legacyStatus", "failed"],
      ["userId", "user-1"],
      ["sort", "cost_desc"],
    ]);
    expect(isGenerationJobQueryFiltered(query)).toBe(true);
  });

  // 游标与页大小是位置与视图，不是筛选条件；它们归 Pagination 管，不该长出芯片。
  it("leaves paging state out of the chips", () => {
    const query = parseGenerationJobQuery(new URLSearchParams("cursor=page-2&limit=100"));

    expect(changedGenerationJobFilters(query)).toEqual([]);
  });

  it("hands back the patch that clears exactly one chip", () => {
    const query = parseGenerationJobQuery(new URLSearchParams("mode=video&userId=user-1"));

    expect(changedGenerationJobFilters(query)[0].reset).toEqual({ mode: defaultGenerationJobQuery.mode });
    expect(changedGenerationJobFilters(query)[1].reset).toEqual({ userId: "" });
  });
});
