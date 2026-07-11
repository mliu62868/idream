import { describe, expect, it } from "vitest";
import { deriveAdminShellSignals } from "./shell-signals";

describe("admin bootstrap provenance signals", () => {
  it("does not infer production data class or fixture absence when provenance is unset", () => {
    expect(deriveAdminShellSignals({ NODE_ENV: "production" })).toEqual({
      environment: "production",
      dataClass: "unknown",
      fixtureState: "unknown",
      productTimezone: "UTC",
      freshness: { state: "unavailable", label: "No source watermark (legacy v1)" },
    });
  });

  it("uses explicit provenance inputs", () => {
    expect(deriveAdminShellSignals({
      ADMIN_ENVIRONMENT: "staging",
      ADMIN_DATA_CLASS: "internal",
      ADMIN_FIXTURES_ENABLED: "true",
      ADMIN_PRODUCT_TIMEZONE: "America/Los_Angeles",
      ADMIN_DATA_FRESHNESS_AT: "2026-07-11T08:30:00.000Z",
    })).toEqual({
      environment: "staging",
      dataClass: "internal",
      fixtureState: "included",
      productTimezone: "America/Los_Angeles",
      freshness: { state: "reported", label: "2026-07-11T08:30:00.000Z" },
    });
  });
});
