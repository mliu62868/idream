import { describe, it, expect } from "vitest";
import { resolveFailureReason } from "./failureReasons";

describe("resolveFailureReason", () => {
  it("maps a known code and keeps severity", () => {
    const r = resolveFailureReason("timeout");
    expect(r.severity).toBe("retry");
    expect(r.title).toBe("Generation timed out");
    expect(r.hint).toBe("Safe to retry");
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
  // SPEC: 新登记的码都要能从生产代码里查到发出点；这里锁住它们的严重度分类，
  // 因为严重度决定运营是"重试"还是"找工程"还是"先对账"。
  it("classifies the reconciliation codes as waiting rather than retry", () => {
    for (const code of ["stale_provider_outcome", "terminal_record_persist_failed", "provider_outcome_unknown"]) {
      expect(resolveFailureReason(code).severity).toBe("waiting");
      expect(resolveFailureReason(code).title).not.toBe("Unknown error");
    }
  });

  it("tells the operator to adjust and regenerate for quality and empty-result codes", () => {
    expect(resolveFailureReason("asset_quality_failed").severity).toBe("retry");
    expect(resolveFailureReason("generation_failed").severity).toBe("retry");
  });

  it("does not leak the prototype chain for special keys", () => {
    for (const key of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      const reason = resolveFailureReason(key);
      expect(reason.title).toBe("Unknown error");
      expect(reason.severity).toBe("engineering");
      expect(reason.code).toBe(key);
    }
  });
});
