import { describe, expect, it } from "vitest";
import { adminBootstrapSchema } from "./bootstrap";

describe("Admin bootstrap contract", () => {
  it("parses the fail-closed SSR bootstrap payload", () => {
    expect(adminBootstrapSchema.parse({
      actor: { id: "admin-1", role: "admin" },
      permissions: ["dashboard.read"],
      canReadDashboard: true,
      devLogin: { enabled: false, accounts: [] },
      shellSignals: {
        environment: "production",
        dataClass: "customer",
        fixtureState: "excluded",
        productTimezone: "UTC",
        freshness: { state: "reported", label: "2026-07-11T12:00:00.000Z" },
      },
    })).toMatchObject({ canReadDashboard: true });
  });

  it("rejects bootstrap payloads without provenance", () => {
    expect(() => adminBootstrapSchema.parse({
      actor: null,
      permissions: [],
      canReadDashboard: false,
      devLogin: { enabled: false, accounts: [] },
    })).toThrow();
  });
});
