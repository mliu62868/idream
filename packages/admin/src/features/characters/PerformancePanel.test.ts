import { describe, expect, it } from "vitest";
import { characterNoDataDiagnosis } from "./PerformancePanel";

describe("Character performance diagnosis", () => {
  // SPEC: 零观测要给运营一个动作，不是一个状态。窗口没走完 = 等；窗口走完了还是零 = 查投放。
  it("turns zero observations into either wait or investigate", () => {
    expect(characterNoDataDiagnosis({
      qualityState: "no_data", maturity: "immature", window: "7d",
    })).toMatchObject({ alert: false });
    expect(characterNoDataDiagnosis({
      qualityState: "no_data", maturity: "insufficient_data", window: "7d",
    })).toMatchObject({ alert: true });
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
