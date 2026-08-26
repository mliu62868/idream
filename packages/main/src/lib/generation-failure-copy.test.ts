import { describe, expect, it } from "vitest";
import { generationFailureCopy } from "./generation-failure-copy";

describe("generationFailureCopy", () => {
  it("explains an auto-settled unknown outcome without claiming an operator did it", () => {
    const copy = generationFailureCopy("operator_confirmed_provider_failure");
    expect(copy).toContain("never returned a result");
    expect(copy).not.toContain("operator");
  });

  it("tells the reader their coins came back on every registered failure", () => {
    // 退款路径是通用的（local-pipeline 的终态对任何已扣费的 failed/blocked 都全额退），
    // 所以每一条登记过的失败文案都必须说这句 —— 少说一条就等于让用户以为钱没了。
    for (const code of [
      "provider_timeout",
      "stale_timeout",
      "operator_confirmed_provider_failure",
      "backend_error",
      "provider_failed",
      "unknown_model",
      "identity_calibration_route_incompatible",
      "age_under_18",
    ]) {
      expect(generationFailureCopy(code)).toContain("coins are back");
    }
  });

  it("falls back to the raw code rather than inventing a reason", () => {
    expect(generationFailureCopy("some_code_we_have_not_registered")).toBe(
      "some_code_we_have_not_registered",
    );
  });

  it("has nothing to say when there is no error code", () => {
    expect(generationFailureCopy(null)).toBeNull();
  });
});
