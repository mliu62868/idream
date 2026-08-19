import { describe, expect, it } from "vitest";
import { adminShellSignalChips, deriveAdminShellSignals } from "./shell-signals";

describe("admin shell provenance signals", () => {
  it("does not infer production data class or fixture absence when provenance is unset", () => {
    expect(deriveAdminShellSignals({ NODE_ENV: "production" })).toEqual({
      environment: "production",
      dataClass: "unknown",
      fixtureState: "unknown",
      productTimezone: "UTC",
      freshness: { state: "unavailable", label: "No source watermark (legacy v1)" },
    });
  });

  it("shows explicit environment, data class, fixture, timezone, and freshness inputs", () => {
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

  it("keeps only environment and timezone when nothing else is provisioned", () => {
    expect(adminShellSignalChips(deriveAdminShellSignals({ NODE_ENV: "development" }))).toEqual([
      { key: "environment", label: "Environment", value: "local" },
      { key: "timezone", label: "Product timezone", value: "UTC" },
    ]);
  });

  it("adds each provenance chip once its input is provisioned", () => {
    const chips = adminShellSignalChips(deriveAdminShellSignals({
      ADMIN_ENVIRONMENT: "production",
      ADMIN_DATA_CLASS: "customer",
      ADMIN_FIXTURES_ENABLED: "false",
      ADMIN_DATA_FRESHNESS_AT: "2026-07-11T08:30:00.000Z",
    }));
    expect(chips.map((chip) => chip.key)).toEqual([
      "environment",
      "data-class",
      "fixtures",
      "timezone",
      "freshness",
    ]);
  });
});
