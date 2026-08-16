import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "@/features/operations/WorkspaceUi";
import { statusTone, STATUS_TONE_CLASS } from "./status-tone";
import { StatusPill } from "./StatusPill";

describe("statusTone", () => {
  it("maps live/positive states to success", () => {
    for (const s of ["approved", "active", "published", "succeeded", "ready", "completed", "live", "delivered"]) {
      expect(statusTone(s)).toBe("success");
    }
  });
  it("maps waiting states to pending", () => {
    for (const s of ["draft", "pending", "in_review", "queued", "paused", "new", "triaged", "waiting"]) {
      expect(statusTone(s)).toBe("pending");
    }
  });
  it("maps real failures to danger — red is reserved for errors", () => {
    for (const s of ["failed", "rejected", "removed", "blocked", "critical", "urgent", "overridden"]) {
      expect(statusTone(s)).toBe("danger");
    }
  });
  it("maps in-flight states to info", () => {
    for (const s of ["running", "processing", "generating", "dispatching", "monitoring", "verifying"]) {
      expect(statusTone(s)).toBe("info");
    }
  });
  it("is case-insensitive and defaults to neutral", () => {
    expect(statusTone("APPROVED")).toBe("success");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone("whatever")).toBe("neutral");
  });

  // 合并前 WorkspaceUi 私有表的四档：它认识的词一个都不能丢。
  it("keeps every word the merged WorkspaceUi table used to recognise", () => {
    for (const s of ["passed", "resolved", "closed"]) expect(statusTone(s)).toBe("success");
    for (const s of ["critical", "urgent", "failed", "overridden"]) expect(statusTone(s)).toBe("danger");
    for (const s of ["high", "detected", "overdue", "pending", "mitigating"]) expect(statusTone(s)).toBe("pending");
  });

  // 拼写分裂是真的：jobs 契约用 cancelled，billing 与 approvals 筛选器用 canceled。
  it("recognises both spellings of cancel", () => {
    expect(statusTone("cancelled")).toBe("neutral");
    expect(statusTone("canceled")).toBe("neutral");
  });

  it("no longer sends unrecognised words to the informational blue", () => {
    expect(STATUS_TONE_CLASS[statusTone("whatever")]).not.toContain("--ad-blue");
    expect(STATUS_TONE_CLASS.info).toContain("--ad-blue");
  });
});

describe("one status word, one colour, every page", () => {
  function toneClassOf(html: string) {
    return (Object.entries(STATUS_TONE_CLASS) as Array<[string, string]>)
      .filter(([, classes]) => classes.split(" ").every((token) => html.includes(token)))
      .map(([tone]) => tone);
  }

  // SPEC: 这条用例锁住合并的全部意义 —— StatusPill 与 StatusBadge 形状不同，但对同一个状态词
  //   必须给出同一个色档。合并前 active 在 Placements 页是绿的、在 Cases 页是蓝的。
  it.each([
    "active", "approved", "succeeded", "failed", "pending", "running",
    "archived", "resolved", "detected", "in_review", "superseded", "provider_queued",
  ])("renders %s in the same tone in StatusPill and StatusBadge", (status) => {
    const pillTones = toneClassOf(renderToStaticMarkup(<StatusPill status={status} />));
    const badgeTones = toneClassOf(renderToStaticMarkup(<StatusBadge value={status} />));
    expect(pillTones).toEqual([statusTone(status)]);
    expect(badgeTones).toEqual([statusTone(status)]);
  });

  // 旧的四档 tone 名还留在十几个调用点上，必须映射到同一张色表。
  it.each([
    ["good", "success"],
    ["warn", "pending"],
    ["bad", "danger"],
    ["neutral", "neutral"],
  ] as const)("maps the legacy %s tone onto %s", (legacy, expected) => {
    const html = renderToStaticMarkup(<StatusBadge tone={legacy} value="whatever" />);
    expect(toneClassOf(html)).toEqual([expected]);
  });
});
