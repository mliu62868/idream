import { describe, expect, it } from "vitest";
import { ACTIONABLE_REPORT_TARGET_TYPES, canActionReportTarget } from "./actionable-targets";

describe("actionable moderation targets", () => {
  // SPEC: 清单必须与 moderation-effect.ts 的三个分支逐字一致。
  it("mirrors the three branches the enforcement authority implements", () => {
    expect([...ACTIONABLE_REPORT_TARGET_TYPES]).toEqual(["character", "media", "feed_item"]);
  });

  it.each(["character", "media", "feed_item"])("can action %s", (targetType) => {
    expect(canActionReportTarget(targetType)).toBe(true);
  });

  // INTENT: 实测本地 open 队列 9 条里 3 条是 chat_message。点「处置」会让整个事务回滚，
  //         审核员敲完确认串写完原因只拿到一个 400，队列一动不动。
  it.each(["chat_message", "collection", "user_profile", "product_feedback", ""])(
    "cannot action %s",
    (targetType) => {
      expect(canActionReportTarget(targetType)).toBe(false);
    },
  );
});
