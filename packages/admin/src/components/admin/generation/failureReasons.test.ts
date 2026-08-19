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
  // SPEC: 新登记的码都要能从生产代码里查到发出点；这里锁住它们的严重度分类，
  // 因为严重度决定运营是"重试"还是"找工程"还是"先对账"。
  // SPEC: 迟到的结果是「无需处理」，落库失败和结果未知是「需要工程介入」。
  // INTENT: 三者都不该说「可以安全重试」——provider_outcome_unknown 意味着那一次到底跑没跑
  //         不知道，直接重试可能产生第二次真实生成和第二次扣费。宁可让运营先去对账。
  it("never tells the operator to retry a job whose outcome is unknown", () => {
    expect(resolveFailureReason("stale_provider_outcome").severity).toBe("waiting");
    for (const code of ["terminal_record_persist_failed", "provider_outcome_unknown"]) {
      expect(resolveFailureReason(code).severity).toBe("engineering");
      expect(resolveFailureReason(code).title).not.toBe("Unknown error");
    }
  });

  it("tells the operator to adjust and regenerate for the quality code", () => {
    expect(resolveFailureReason("asset_quality_failed").severity).toBe("retry");
  });

  // SPEC: generation_failed 是「没有更具体的码」时的兜底，不是一个已知原因。
  // INTENT: 对一个未分类的失败说「可以安全重试」是猜的；让运营去打开任务看它自己的失败原因。
  it("sends the unclassified fallback to the job's own failure reason", () => {
    expect(resolveFailureReason("generation_failed").severity).toBe("engineering");
    expect(resolveFailureReason("generation_failed").hint).toContain("job");
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
