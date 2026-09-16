import { GENERATION_ROUTE_STALE_REASONS } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { translateAdmin } from "@/components/admin/i18n-dictionary";
import { ROUTE_STALE_REASON_COPY, routeStaleReasonCopy } from "./route-stale-reason";

// SPEC: 这张表是服务端词表在前端的第二处实现，必须逐项对齐。
// INTENT: 键集已经由 TS 穷举守住（少一个编译不过），所以这里钉的是编译器管不到的三件事：
//         多出来的键、缺失的中文、以及「谁能收口」有没有被悄悄改成运营做不到的动作。
describe("generation route stale reason copy", () => {
  it("covers the authority's vocabulary exactly", () => {
    expect(Object.keys(ROUTE_STALE_REASON_COPY).sort())
      .toEqual([...GENERATION_ROUTE_STALE_REASONS].sort());
  });

  // 这三行文案会出现在中文后台的角色工作台里，漏一条就原样漏出英文。
  it("has Chinese for every cause and recovery", () => {
    for (const reason of GENERATION_ROUTE_STALE_REASONS) {
      const { cause, recovery } = ROUTE_STALE_REASON_COPY[reason];
      expect(translateAdmin("zh", cause), `${reason} cause 缺中文`).not.toBe(cause);
      expect(translateAdmin("zh", recovery), `${reason} recovery 缺中文`).not.toBe(recovery);
    }
  });

  // SPEC: 标成 operations 的前提是运营真有一条能走通的动作。
  // INTENT: 这六条的收口动作都是「发一个新 Release」——发布时 findOperationalGenerationRoute
  //         会重新绑定当下合格的线路。反过来，「把 profile 重新启用」不是合法的下一步：
  //         非草稿 profile 的 PATCH 只接受 enabled:false，写进文案就是指着一个不存在的按钮。
  it("only tells operations to do the thing that actually works", () => {
    const operations = GENERATION_ROUTE_STALE_REASONS.filter(
      (reason) => ROUTE_STALE_REASON_COPY[reason].owner === "operations",
    );
    expect(operations).toHaveLength(6);
    for (const reason of operations) {
      expect(ROUTE_STALE_REASON_COPY[reason].recovery).toContain("Publish a new Release");
      expect(ROUTE_STALE_REASON_COPY[reason].recovery).not.toMatch(/re-?enabl(e|ing) the profile/i);
    }
  });

  // SPEC: 不认识的原因不编下一步。
  it("falls back without inventing a cause", () => {
    expect(routeStaleReasonCopy("some_future_reason")).toMatchObject({ owner: "engineering" });
    expect(routeStaleReasonCopy(undefined).cause).toBe("This route no longer meets its qualification.");
  });
});
