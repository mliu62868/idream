import { describe, expect, it } from "vitest";
import { adminBootstrapSchema } from "./bootstrap";

describe("Admin bootstrap contract", () => {
  it("parses the fail-closed SSR bootstrap payload", () => {
    expect(adminBootstrapSchema.parse({
      actor: { id: "admin-1", role: "admin" },
      permissions: ["dashboard.read"],
      canReadDashboard: true,
      canCreateCharacters: false,
      devLogin: { enabled: false, accounts: [] },
      shellSignals: {
        environment: "production",
        dataClass: "customer",
        fixtureState: "excluded",
        productTimezone: "UTC",
        freshness: { state: "reported", label: "2026-07-11T12:00:00.000Z" },
      },
    })).toMatchObject({ canReadDashboard: true, canCreateCharacters: false });
  });

  it("rejects bootstrap payloads without provenance", () => {
    expect(() => adminBootstrapSchema.parse({
      actor: null,
      permissions: [],
      canReadDashboard: false,
      canCreateCharacters: false,
      devLogin: { enabled: false, accounts: [] },
    })).toThrow();
  });

  it("requires authoritative Character creation eligibility rather than guessing from permission keys", () => {
    const result = adminBootstrapSchema.safeParse({
      actor: { id: "scoped-producer", role: "user" }, permissions: ["character.project.write"],
      canReadDashboard: false, devLogin: { enabled: false, accounts: [] },
      shellSignals: { environment: "test", dataClass: "fixture", fixtureState: "included",
        productTimezone: "UTC", freshness: { state: "reported", label: "2026-10-03T12:00:00.000Z" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["canCreateCharacters"]);
  });
});
