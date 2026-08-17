// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPageInfo } from "@idream/shared/admin";
import { canGoPrevious, listPageFromParams, listUrlSearch, syncListUrl } from "./section-kit";

describe("canGoPrevious", () => {
  // SPEC: contracts/common.ts —— hasPreviousPage 缺席意味着「这个 operation 还是单向的」，
  // 不是「你在第一页」。缺席时必须置灰。
  it("stays disabled when the authority never reported a backward direction", () => {
    expect(canGoPrevious({ endCursor: "c1", hasNextPage: true }, true)).toBe(false);
  });

  it("stays disabled when the operation does not accept a before parameter", () => {
    const pageInfo: AdminPageInfo = {
      endCursor: "c2",
      hasNextPage: true,
      startCursor: "c0",
      hasPreviousPage: true,
    };

    // content/* 经 paginateAdminKeyset 回了 hasPreviousPage/startCursor，但查询契约里没有
    // `before` —— 发过去会被 .strict() 挡成 400，所以按钮不能亮。
    expect(canGoPrevious(pageInfo, false)).toBe(false);
    expect(canGoPrevious(pageInfo, true)).toBe(true);
  });

  it("stays disabled when the authority claims a previous page but hands back no cursor", () => {
    expect(canGoPrevious(
      { endCursor: null, hasNextPage: false, hasPreviousPage: true, startCursor: null },
      true,
    )).toBe(false);
  });
});

describe("list URL state", () => {
  it("keeps the page out of the first-page URL and restores it from the query", () => {
    const params = new URLSearchParams({ limit: "25", search: "alex" });

    expect(listUrlSearch(params, 1)).toBe("?limit=25&search=alex");
    expect(listUrlSearch(params, 3)).toBe("?limit=25&search=alex&page=3");
    expect(listPageFromParams(new URLSearchParams("?page=3"))).toBe(3);
  });

  it("reads a missing or nonsensical page as the first page", () => {
    expect(listPageFromParams(new URLSearchParams(""))).toBe(1);
    expect(listPageFromParams(new URLSearchParams("?page=0"))).toBe(1);
    expect(listPageFromParams(new URLSearchParams("?page=-2"))).toBe(1);
    expect(listPageFromParams(new URLSearchParams("?page=later"))).toBe(1);
  });
});

describe("syncListUrl", () => {
  let pushState: ReturnType<typeof vi.spyOn>;
  let replaceState: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/generation/recipes");
    pushState = vi.spyOn(window.history, "pushState");
    replaceState = vi.spyOn(window.history, "replaceState");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // SPEC: 翻页是一次导航，后退必须回得来 —— 这五个列表页此前一律 replaceState。
  it("pushes a history entry when the cursor moves so Back returns to the previous page", () => {
    syncListUrl(new URLSearchParams({ limit: "25", cursor: "c1" }), 2);

    expect(pushState).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState.mock.calls[0]?.[2]).toBe("/admin/generation/recipes?limit=25&cursor=c1&page=2");
  });

  // INVARIANT: 搜索框每敲一个字符都留一条历史，等于把后退键废掉。
  it("replaces the entry when only the filters changed", () => {
    window.history.replaceState(null, "", "/admin/generation/recipes?limit=25&search=al");
    replaceState.mockClear();

    syncListUrl(new URLSearchParams({ limit: "25", search: "alex" }), 1);

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[2]).toBe("/admin/generation/recipes?limit=25&search=alex");
  });

  it("pushes when Back has landed on page 1 and the operator pages forward again", () => {
    window.history.replaceState(null, "", "/admin/generation/recipes?limit=25");
    replaceState.mockClear();

    syncListUrl(new URLSearchParams({ limit: "25", cursor: "c1" }), 2);

    expect(pushState).toHaveBeenCalledTimes(1);
  });
});
