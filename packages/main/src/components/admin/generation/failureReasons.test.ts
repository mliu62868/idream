import { describe, it, expect } from "vitest";
import { resolveFailureReason } from "./failureReasons";

describe("resolveFailureReason", () => {
  it("maps a known code and keeps severity", () => {
    const r = resolveFailureReason("timeout");
    expect(r.severity).toBe("retry");
    expect(r.title).toBe("Generation timed out");
    expect(r.code).toBe("timeout");
  });
  it("is case- and whitespace-insensitive on the lookup key", () => {
    expect(resolveFailureReason("  MISSING_RUNTIME_COMPONENTS ").severity).toBe("engineering");
  });
  it("falls back for unknown codes but preserves the raw code", () => {
    const r = resolveFailureReason("weird_new_code");
    expect(r.title).toBe("Unknown error");
    expect(r.severity).toBe("engineering");
    expect(r.code).toBe("weird_new_code");
  });
  it("handles null/undefined without throwing", () => {
    expect(resolveFailureReason(null).title).toBe("Unknown error");
    expect(resolveFailureReason(undefined).code).toBe("");
  });
});
