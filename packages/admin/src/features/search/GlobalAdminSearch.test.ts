import { describe, expect, it } from "vitest";
import type { GlobalAdminSearchResponse } from "@idream/shared/admin";
import {
  INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
  globalAdminSearchFailed,
  globalAdminSearchRecordsForQuery,
  globalAdminSearchSucceeded,
  globalAdminSearchUnavailableMessage,
} from "./GlobalAdminSearch";

const result: GlobalAdminSearchResponse["items"][number] = {
  kind: "customer",
  id: "user-1",
  title: "Amy",
  subtitle: "amy@example.test",
  href: "/admin/customers?customer=user-1",
  status: "active",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

describe("Global Admin Search authority state", () => {
  it("keeps the last good results when a later authority request fails", () => {
    const available = globalAdminSearchSucceeded(
      INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
      "amy",
      [result],
    );
    const unavailable = globalAdminSearchFailed(available);

    expect(unavailable).toEqual({
      availability: "unavailable",
      items: [result],
      lastGoodQuery: "amy",
    });
    expect(globalAdminSearchUnavailableMessage(unavailable)).toBe(
      'Search unavailable. Showing last successful results for "amy".',
    );
  });

  it("does not pretend an unavailable empty cache is a valid empty search", () => {
    const unavailable = globalAdminSearchFailed(
      INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
    );

    expect(unavailable.items).toEqual([]);
    expect(globalAdminSearchUnavailableMessage(unavailable)).toBe(
      "Search unavailable. No cached results are available.",
    );
  });

  it("distinguishes a cached empty result from no successful result", () => {
    const available = globalAdminSearchSucceeded(
      INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
      "nobody",
      [],
    );
    const unavailable = globalAdminSearchFailed(available);

    expect(globalAdminSearchUnavailableMessage(unavailable)).toBe(
      'Search unavailable. The last successful search for "nobody" returned no results.',
    );
  });
});

// SPEC: 导航候选每次击键立刻出，实体候选要等防抖 + 网络。两者同框之后，必须判这批记录
//       是否属于当前输入——否则上一次查询的结果会跟着新输入一起显示。
describe("record candidates belonging to the current query", () => {
  const available = globalAdminSearchSucceeded(
    INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
    "amy",
    [result],
  );

  it("keeps records only while the query they answered is still the query on screen", () => {
    expect(globalAdminSearchRecordsForQuery(available, "amy")).toEqual([result]);
    expect(globalAdminSearchRecordsForQuery(available, "  amy  ")).toEqual([result]);
    expect(globalAdminSearchRecordsForQuery(available, "amy w")).toEqual([]);
    expect(globalAdminSearchRecordsForQuery(available, "")).toEqual([]);
  });

  it("shows nothing while the first request for a query is still in flight", () => {
    expect(globalAdminSearchRecordsForQuery(INITIAL_GLOBAL_ADMIN_SEARCH_STATE, "amy")).toEqual([]);
  });

  // 降级是唯一的例外：横幅已经写明"显示上次成功的结果"，那是有意为之的旧数据。
  it("keeps the degraded last-good results the banner already explains", () => {
    const unavailable = globalAdminSearchFailed(available);
    expect(globalAdminSearchRecordsForQuery(unavailable, "amy w")).toEqual([result]);
  });
});
