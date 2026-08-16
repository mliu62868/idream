import { describe, expect, it } from "vitest";
import { statusTone, STATUS_TONE_CLASS } from "./status-tone";

describe("statusTone", () => {
  it("maps live/positive states to success", () => {
    for (const s of ["approved", "active", "published", "succeeded", "ready"]) {
      expect(statusTone(s)).toBe("success");
    }
  });
  it("maps waiting states to pending", () => {
    for (const s of ["draft", "pending", "in_review", "queued", "paused"]) {
      expect(statusTone(s)).toBe("pending");
    }
  });
  it("maps real failures to danger — red is reserved for errors", () => {
    for (const s of ["failed", "rejected", "removed", "blocked"]) {
      expect(statusTone(s)).toBe("danger");
    }
  });
  it("maps in-flight states to info", () => {
    for (const s of ["running", "processing", "generating"]) {
      expect(statusTone(s)).toBe("info");
    }
  });
  it("is case-insensitive and defaults to neutral", () => {
    expect(statusTone("APPROVED")).toBe("success");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone("whatever")).toBe("neutral");
  });

  // SPEC: 队列侧（案件 / 事件）原来自带一份私有词表，合并后一个词都不能丢。
  it("keeps every word the operational queue used to colour on its own", () => {
    for (const s of ["passed", "resolved", "closed"]) expect(statusTone(s)).toBe("success");
    for (const s of ["critical", "urgent", "overridden"]) expect(statusTone(s)).toBe("danger");
    for (const s of ["high", "detected", "overdue", "mitigating"]) expect(statusTone(s)).toBe("pending");
  });

  // SPEC: 未知状态是灰色。队列那份私有表把它染成蓝色，于是同一个 active 在两个页面颜色不同。
  it("paints an unknown status grey rather than blue", () => {
    expect(STATUS_TONE_CLASS[statusTone("partially_succeeded")]).toBe(STATUS_TONE_CLASS.neutral);
    expect(STATUS_TONE_CLASS.neutral).not.toContain("--ad-blue");
    expect(STATUS_TONE_CLASS[statusTone("active")]).toContain("--ad-green");
  });
});
