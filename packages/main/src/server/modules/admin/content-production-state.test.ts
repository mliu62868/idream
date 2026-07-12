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
  it("derives exactly one execution outcome for every child-fact combination up to five items", () => {
    const factKinds = ["success", "failed", "active"] as const;
    for (let total = 0; total <= 5; total += 1) {
      const combinationCount = factKinds.length ** total;
      for (let encoded = 0; encoded < combinationCount; encoded += 1) {
        let cursor = encoded;
        const kinds = Array.from({ length: total }, () => {
          const kind = factKinds[cursor % factKinds.length];
          cursor = Math.floor(cursor / factKinds.length);
          return kind;
        });
        const items = kinds.map((kind, index) => kind === "success"
          ? successfulItem(index)
          : kind === "failed"
            ? failedItem(index)
            : {
                id: `active-${index}`,
                status: "queued",
                job: { id: `job-active-${index}`, status: "queued", errorCode: null, costDreamcoins: 0 },
                asset: null,
                placements: [],
              });
        const state = deriveCreativeRunState({
          legacyStatus: "completed",
          expectedItemCount: total,
          items,
          ledgerEntries: [],
        });
        const successful = kinds.filter((kind) => kind === "success").length;
        const failed = kinds.filter((kind) => kind === "failed").length;
        const active = kinds.filter((kind) => kind === "active").length;
        const expectedOutcome = total === 0
          ? "pending"
          : active > 0
            ? "running"
            : successful === total
              ? "succeeded"
              : successful > 0
                ? "partially_succeeded"
                : "failed";

        expect(state.executionOutcome, JSON.stringify({ kinds, state }, null, 2)).toBe(expectedOutcome);
        expect(state.counts).toMatchObject({ generated: successful, failed, total });
        expect(state.counts.generated + state.counts.failed).toBeLessThanOrEqual(total);
      }
    }
  });

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
