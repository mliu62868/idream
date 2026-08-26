import { describe, expect, it } from "vitest";
import {
  CONTENT_REPORT_REASONS,
  DEFAULT_CONTENT_REPORT_REASON,
  contentReportReasonSchema,
  isUnderageReportReason,
} from "./content-report";

describe("content report reasons", () => {
  // INTENT: 服务端的自动下架分支是子串匹配。把「哪个取值会命中」钉在契约层，
  // 否则一次无害的重命名就能静默关掉整条 priority 1 链路。
  it("keeps exactly one reason on the underage auto-takedown branch", () => {
    const underage = CONTENT_REPORT_REASONS.filter(isUnderageReportReason);
    expect(underage).toEqual(["underage_content"]);
  });

  it("rejects a free-form category and accepts every declared reason", () => {
    for (const reason of CONTENT_REPORT_REASONS) {
      expect(contentReportReasonSchema.parse(reason)).toBe(reason);
    }
    expect(contentReportReasonSchema.safeParse("whatever").success).toBe(false);
  });

  it("has a fallback reason inside the set", () => {
    expect(CONTENT_REPORT_REASONS).toContain(DEFAULT_CONTENT_REPORT_REASON);
  });
});
