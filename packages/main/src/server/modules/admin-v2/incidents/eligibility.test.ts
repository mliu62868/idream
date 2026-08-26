import { describe, expect, it } from "vitest";
import { eligibleOccurrenceIds } from "./eligibility";

// 实测抓自本地事故 cmt6zba3h…：两条 occurrence 的 Attempt 都是
// unknown / not_retryable / ambiguous_non_replayable —— 结果不确定，重放可能二次扣费或二次交付。
const AMBIGUOUS = [
  { id: "occ-a", capturedSpend: 0, refunded: 0, attempt: { status: "unknown", retryability: "not_retryable" } },
  { id: "occ-b", capturedSpend: 0, refunded: 0, attempt: { status: "unknown", retryability: "not_retryable" } },
] as never[];

describe("incident mitigation eligibility", () => {
  // SPEC: 结果不确定且被判定不可重试的 occurrence，绝不进重试集合。
  // INTENT: 事故的 recommendedActions 是建事故时写死的常量，一直推荐 retry_eligible；
  //         真正的判据在这里。两者对不上时，运营点下去只会拿到一句 400。
  it("never offers a retry for an ambiguous, not-retryable occurrence", () => {
    expect(eligibleOccurrenceIds("retry_eligible", AMBIGUOUS)).toEqual([]);
  });

  it("offers a retry once the attempt says it is retryable", () => {
    const retryable = [
      { id: "occ-a", capturedSpend: 0, refunded: 0, attempt: { status: "failed", retryability: "retryable" } },
      { id: "occ-b", capturedSpend: 0, refunded: 0, attempt: { status: "failed", retryability: "not_retryable" } },
    ] as never[];
    expect(eligibleOccurrenceIds("retry_eligible", retryable)).toEqual(["occ-a"]);
  });

  // SPEC: 只退还真正捕获过、且还没退过的那部分。
  it("only refunds occurrences whose captured spend is not yet refunded", () => {
    const ledgered = [
      { id: "occ-paid", capturedSpend: 8, refunded: 0, attempt: null },
      { id: "occ-done", capturedSpend: 8, refunded: 8, attempt: null },
    ] as never[];
    expect(eligibleOccurrenceIds("refund", ledgered)).toEqual(["occ-paid"]);
  });

  // pause_route / rollback 作用在路由而不是单条 occurrence 上，所以全部计入。
  it("treats route-level actions as covering every occurrence", () => {
    expect(eligibleOccurrenceIds("pause_route", AMBIGUOUS)).toEqual(["occ-a", "occ-b"]);
  });
});
