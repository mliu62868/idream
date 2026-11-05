import { describe, expect, it } from "vitest";
import {
  characterNoDataDiagnosis,
  performanceRateLabel,
  releaseComparisonLabel,
} from "./PerformancePanel";

describe("Character performance diagnosis", () => {
  // SPEC: 窗口没走完 = 等。窗口走完了，只有权威判定真的零流量才派人查投放；
  //       有人聊但没走曝光入口时只陈述事实，不制造排查任务。
  it("sends operators to placements only on genuine zero traffic", () => {
    const closed = { qualityState: "no_data", maturity: "insufficient_data", window: "7d" };
    expect(characterNoDataDiagnosis({ ...closed, maturity: "immature" }, { noTraffic: true })).toMatchObject({ alert: false });
    expect(characterNoDataDiagnosis(closed, { noTraffic: true })).toMatchObject({
      alert: true,
      message: expect.stringContaining("event delivery"),
    });
    const quiet = characterNoDataDiagnosis(closed);
    expect(quiet).toMatchObject({ alert: false });
    expect(quiet?.message).not.toContain("event delivery");
  });

  // SPEC: 没有证据时说数据不足，不写 0% 或 N/A。
  it("labels missing rates as insufficient data, and a real zero as zero", () => {
    expect(performanceRateLabel(null)).toBe("Insufficient data");
    expect(performanceRateLabel(0)).toBe("0.0%");
  });

  it("only states deltas that have a denominator", () => {
    const marker = { qceRateDelta: 0.125, sameCharacterD7Delta: null } as Parameters<typeof releaseComparisonLabel>[0];
    expect(releaseComparisonLabel(marker)).toBe("QCE +12.5");
    expect(releaseComparisonLabel({ ...marker, sameCharacterD7Delta: -0.02 })).toBe("QCE +12.5 · D7 -2.0");
  });

  it("stays silent when the metric is not a no-data metric", () => {
    expect(characterNoDataDiagnosis({
      qualityState: "invalid", maturity: "insufficient_data", window: "7d",
    })).toBeNull();
    expect(characterNoDataDiagnosis({
      qualityState: "certified", maturity: "mature", window: "28d",
    })).toBeNull();
  });
});
