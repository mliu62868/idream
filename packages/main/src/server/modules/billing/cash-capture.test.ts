import { describe, expect, it } from "vitest";
import { canonicalCaptureAmount } from "./cash-capture";

describe("native-currency cash amount identity", () => {
  it("preserves exact native precision while treating formatting differences as the same receipt", () => {
    expect(canonicalCaptureAmount("000.00005500")).toBe("0.000055");
    expect(canonicalCaptureAmount("1000000000000000000000.000000000000000001")).toBe("1000000000000000000000.000000000000000001");
    expect(canonicalCaptureAmount("1.00")).toBe("1");
  });
  it.each(["0", "0.000", "-0.001", "1e-8", "NaN", " 1.0", "1."])("rejects nonpositive or nondecimal receipt %s", (amount) => {
    expect(canonicalCaptureAmount(amount)).toBeNull();
  });
});
