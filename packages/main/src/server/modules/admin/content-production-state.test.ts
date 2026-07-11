import { describe, expect, it } from "vitest";
import { deriveCreativeRunState } from "./content-production-state";

function failedItem(index: number) {
  return {
    id: `failed-${index}`,
    status: "failed",
    job: {
      id: `job-failed-${index}`,
      status: "failed",
      errorCode: "provider_timeout",
      costDreamcoins: 5,
    },
    asset: null,
    placements: [],
  };
}

function successfulItem(index: number, status = "generated") {
  return {
    id: `success-${index}`,
    status,
    job: {
      id: `job-success-${index}`,
      status: "completed",
      errorCode: null,
      costDreamcoins: 5,
    },
    asset: {
      id: `asset-${index}`,
      safetyStatus: "passed",
      deletedAt: null,
    },
    placements: status === "published"
      ? [{ status: "published", verificationState: "passed" as const }]
      : [],
  };
}

describe("deriveCreativeRunState", () => {
  it("derives 0/4 as failed even when the legacy batch says completed", () => {
    const state = deriveCreativeRunState({
      legacyStatus: "completed",
      expectedItemCount: 4,
      items: [0, 1, 2, 3].map(failedItem),
      ledgerEntries: [],
    });

    expect(state.executionOutcome).toBe("failed");
    expect(state.counts).toMatchObject({ generated: 0, failed: 4, total: 4 });
    expect(state.legacyState).toBe("completed");
  });

  it("derives 1/4 as partially_succeeded without letting review or settlement overwrite execution", () => {
    const state = deriveCreativeRunState({
      legacyStatus: "completed",
      expectedItemCount: 4,
      items: [successfulItem(0, "approved"), failedItem(1), failedItem(2), failedItem(3)],
      ledgerEntries: [
        { sourceId: "job-success-0", reason: "generation_spend", delta: -5 },
        { sourceId: "job-failed-1", reason: "generation_spend", delta: -5 },
        { sourceId: "job-failed-2", reason: "generation_spend", delta: -5 },
        { sourceId: "job-failed-3", reason: "generation_spend", delta: -5 },
        { sourceId: "job-failed-1", reason: "refund", delta: 5 },
        { sourceId: "job-failed-2", reason: "refund", delta: 5 },
        { sourceId: "job-failed-3", reason: "refund", delta: 5 },
      ],
    });

    expect(state).toMatchObject({
      executionOutcome: "partially_succeeded",
      reviewState: "complete",
      deploymentState: "unplaced",
      settlementView: "partially_refunded",
    });
    expect(state.retryEligibility.eligibleItemIds).toEqual([]);
  });

  it("derives 4/4 as succeeded and never marks successful items retry-eligible", () => {
    const state = deriveCreativeRunState({
      legacyStatus: "completed",
      expectedItemCount: 4,
      items: [0, 1, 2, 3].map((index) => successfulItem(index, "published")),
      ledgerEntries: [0, 1, 2, 3].map((index) => ({
        sourceId: `job-success-${index}`,
        reason: "generation_spend",
        delta: -5,
      })),
    });

    expect(state).toMatchObject({
      executionOutcome: "succeeded",
      reviewState: "complete",
      deploymentState: "placed",
      verificationState: "passed",
      settlementView: "captured",
      counts: { generated: 4, failed: 0, reviewed: 4, approved: 4, placed: 4, total: 4 },
    });
    expect(state.retryEligibility).toEqual({ eligibleItemIds: [], eligibleCount: 0 });
  });
});
