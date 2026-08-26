import { describe, expect, it } from "vitest";
import { collapseAuditRuns } from "./collapse-runs";

const batch = (targetId: string) => ({
  id: `audit-${targetId}`,
  action: "character.image_readiness.repaired",
  actorId: "system:editorial",
  reason: "Adopt the live editorial portrait as image-production input",
  targetType: "character_project",
  targetId,
});

describe("audit repeat collapsing", () => {
  // SPEC: 一次批量操作只在首屏占一行，其余同类的折起来。
  it("keeps the first row of a run and hides the rest", () => {
    const { visible, hidden } = collapseAuditRuns([
      batch("a"), batch("b"), batch("c"), batch("d"),
    ]);

    expect(visible.map((row) => row.targetId)).toEqual(["a"]);
    expect(hidden).toBe(3);
  });

  // SPEC: 只折叠**相邻**的。审计日志的价值在时间线上，同类但被别的事件隔开就是两件事。
  // INTENT: 按 key 分组会把中间那条别的事件挤走，"这件事发生在那件事之后"就读不出来了。
  it("does not merge two runs separated by a different event", () => {
    const other = { ...batch("x"), action: "case.decision.recorded", actorId: "operator-1" };
    const { visible, hidden } = collapseAuditRuns([
      batch("a"), batch("b"), other, batch("c"), batch("d"),
    ]);

    expect(visible.map((row) => row.action)).toEqual([
      "character.image_readiness.repaired",
      "case.decision.recorded",
      "character.image_readiness.repaired",
    ]);
    expect(hidden).toBe(2);
  });

  // SPEC: 只有「谁 / 做了什么 / 为什么 / 对哪一类目标」四项都相同才算同类。
  it("treats a different reason as a different event even for the same action", () => {
    const relabelled = { ...batch("b"), reason: "Manual repair after the operator review" };
    const { visible, hidden } = collapseAuditRuns([batch("a"), relabelled]);

    expect(visible).toHaveLength(2);
    expect(hidden).toBe(0);
  });

  // INVARIANT: 信息不全的记录不参与折叠 —— 那说明它本身有问题，不该被当成重复吞掉。
  it("never collapses records whose signature fields are all missing", () => {
    const blank = { id: "audit-blank", action: undefined };
    const { visible, hidden } = collapseAuditRuns([blank, blank, blank]);

    expect(visible).toHaveLength(3);
    expect(hidden).toBe(0);
  });

  it("returns an empty result for an empty page", () => {
    expect(collapseAuditRuns([])).toEqual({ visible: [], hidden: 0 });
  });
});
