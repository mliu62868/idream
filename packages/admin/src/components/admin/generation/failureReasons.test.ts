import { describe, it, expect } from "vitest";
import { hasAdminZh } from "@/components/admin/i18n";
import { FAILURE_REASON_COPY_KEYS, resolveFailureReason } from "./failureReasons";

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
  it("does not leak the prototype chain for special keys", () => {
    for (const key of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      const reason = resolveFailureReason(key);
      expect(reason.title).toBe("Unknown error");
      expect(reason.severity).toBe("engineering");
      expect(reason.code).toBe(key);
    }
  });

  it("translates a real generation-pipeline code into a title and a next action", () => {
    const reason = resolveFailureReason("provider_timeout");

    expect(reason.title).toBe("Provider did not answer in time");
    expect(reason.hint).toBe("Safe to retry");
    expect(reason.severity).toBe("retry");
    expect(reason.code).toBe("provider_timeout");
  });

  // SPEC: 结果未知 ≠ 失败。直接重试可能产出重复图，所以它必须是「先对账」而不是「可以重试」。
  it("tells the operator to reconcile, not retry, when the provider outcome is unknown", () => {
    const reason = resolveFailureReason("provider_outcome_unknown");

    expect(reason.severity).toBe("engineering");
    expect(reason.hint).toContain("Reconcile before retrying");
  });

  // SPEC: 额度用尽和迟到结果都不是故障，别把它们涂成红色让运营去追。
  it("marks non-faults as waiting rather than engineering", () => {
    for (const code of [
      "allowance_exhausted",
      "insufficient_dreamcoins_after_synthesis",
      "operator_cancelled",
      "stale_provider_outcome",
      "late_worker_failure",
      "preserve_on_replay",
    ]) {
      expect(resolveFailureReason(code).severity, code).toBe("waiting");
    }
  });

  // SPEC: title/hint 经 t(变量) 取值，逃得过 i18n-completeness 的字面量扫描。
  it("has a Chinese translation for every key the table can return", () => {
    expect(FAILURE_REASON_COPY_KEYS.filter((key) => !hasAdminZh(key))).toEqual([]);
  });
});
