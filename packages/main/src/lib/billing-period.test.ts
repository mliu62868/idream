import { describe, expect, it } from "vitest";
import { billingPeriodEnd } from "./billing-period";

describe("billing period authority", () => {
  it("uses calendar months and years from the immutable offer period", () => {
    const start = new Date("2026-07-16T12:34:56.789Z");
    expect(billingPeriodEnd(start, "monthly").toISOString()).toBe(
      "2026-08-16T12:34:56.789Z",
    );
    expect(billingPeriodEnd(start, "yearly").toISOString()).toBe(
      "2027-07-16T12:34:56.789Z",
    );
  });

  it("clamps month-end dates without rolling into the following month", () => {
    expect(
      billingPeriodEnd(
        new Date("2025-01-31T00:00:00.000Z"),
        "monthly",
      ).toISOString(),
    ).toBe("2025-02-28T00:00:00.000Z");
    expect(
      billingPeriodEnd(
        new Date("2024-02-29T00:00:00.000Z"),
        "yearly",
      ).toISOString(),
    ).toBe("2025-02-28T00:00:00.000Z");
  });
});
