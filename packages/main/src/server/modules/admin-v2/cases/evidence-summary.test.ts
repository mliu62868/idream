import { describe, expect, it } from "vitest";
import { caseEvidenceSummary } from "./evidence-summary";

describe("readable immutable Case evidence", () => {
  it("retains the actual message and subject rather than exposing source IDs", () => {
    expect(caseEvidenceSummary("support_request", { subject: "Double charge", description: "I paid twice.", userId: "private-user-id" })).toBe("Double charge\n\nI paid twice.");
  });
  it("explains billing evidence without exposing provider account identifiers", () => {
    expect(caseEvidenceSummary("dreamcoin_ledger", { delta: -20, balanceAfter: 40, reason: "image" })).toContain("-20；变动后余额：40");
    expect(caseEvidenceSummary("subscription_snapshot", { plan: { name: "Premium" }, status: "active", currentPeriodEnd: "2026-10-01", providerSubscriptionId: "secret-provider-id" })).toBe("订阅：Premium；状态：active；本期截止：2026-10-01。");
  });
  it("retains prior resolution notes and clearly identifies evidence without prose", () => {
    expect(caseEvidenceSummary("support_resolution", { resolutionNotes: "Refund completed." })).toBe("Refund completed.");
    expect(caseEvidenceSummary("case_resolution", { resolution: { summary: "Restored delivery." } })).toBe("Restored delivery.");
    expect(caseEvidenceSummary("unknown", {})).toContain("没有提供可阅读的说明");
  });
});
