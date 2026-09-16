import { describe, expect, it } from "vitest";
import { exploreListingEligibility } from "./merchandising";

// SPEC: 列表下发给运营的挂牌资格，必须和写入路径拒绝请求的条件是同一套。
// INTENT: 后台过去对每一行都画出「取消公开列出 / 设为私密」，只看写权限。实测：暂停角色点
//         任一个都返回 409，官方角色的「设为私密」更是永远返回 409（下线要走 Serving 命令）。
//         把结论抽成这个纯函数后，列表投影和 setCharacterVisibility 共用它，这里钉住真值表。

const live = {
  id: "char-1",
  source: "official",
  status: "approved",
  visibility: "public",
  servingState: "live",
  currentReleaseStatus: "published",
};

describe("Explore listing eligibility", () => {
  it("lets a live official Character change its listing but never go private here", () => {
    expect(exploreListingEligibility(live)).toEqual({
      canUnlist: true,
      canMakePrivate: false,
      blockedReason: "private_needs_serving_command",
      repairDeepLink: "/admin/characters/char-1?tab=release",
    });
  });

  it.each([
    ["paused serving", { servingState: "paused" }],
    ["archived status", { status: "archived" }],
    ["already private", { visibility: "private" }],
    ["no current release", { currentReleaseStatus: null }],
    ["withdrawn release", { currentReleaseStatus: "withdrawn" }],
  ])("blocks both listing actions when the official Character is %s", (_label, patch) => {
    const eligibility = exploreListingEligibility({ ...live, ...patch });
    expect(eligibility.canUnlist).toBe(false);
    expect(eligibility.canMakePrivate).toBe(false);
    expect(eligibility.blockedReason).toBe("character_not_live");
    expect(eligibility.repairDeepLink).toBe("/admin/characters/char-1?tab=release");
  });

  it("leaves customer-created Characters under the plain visibility permission", () => {
    expect(
      exploreListingEligibility({ ...live, source: "user", servingState: null, currentReleaseStatus: null }),
    ).toEqual({
      canUnlist: true,
      canMakePrivate: true,
      blockedReason: null,
      repairDeepLink: null,
    });
  });
});
