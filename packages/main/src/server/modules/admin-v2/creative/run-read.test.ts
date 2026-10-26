import { beforeEach, describe, expect, it, vi } from "vitest";

const { findRun, findAttempts } = vi.hoisted(() => ({
  findRun: vi.fn(),
  findAttempts: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    contentProductionBatch: { findFirst: findRun },
    creativeReviewDecision: { findMany: async () => [] },
    generationAttempt: { findMany: findAttempts },
    generationTransportExecution: { findMany: async () => [] },
    dreamcoinLedger: { findMany: async () => [] },
    opsIncidentOccurrence: { findMany: async () => [] },
  },
}));

import { getCreativeRunDetail } from "./run-read";

const actor = { id: "creative-reader", role: "admin" as const };

function failedRun(purpose: "character_video" | "character_library") {
  return {
    id: "run-failed", title: "Failed character media", purpose,
    brief: "Keep the camera steady.", orientation: "16:9",
    targetType: "character", targetId: "character-1", ownerId: actor.id,
    profileId: null, profileVersion: null, recipeId: null, recipeVersion: null,
    dueAt: null, priority: "normal", lifecycleState: "open", workflowStage: "production",
    status: "failed", totalItems: 1, verificationState: "pending", version: 1,
    createdAt: new Date("2026-10-25T12:00:00Z"), updatedAt: new Date("2026-10-25T12:01:00Z"),
    items: [{
      id: "item-failed", itemIndex: 0, status: "failed", version: 1,
      jobId: "job-failed", mediaAsset: null, directionSnapshot: null, directionId: null, directionHash: null,
      job: {
        id: "job-failed", mode: purpose === "character_video" ? "video" : "image",
        status: "failed", errorCode: "provider_failed", costDreamcoins: 0,
        assets: [], sourceMeta: {}, negativePrompt: null, referenceAssetIds: [], seed: null,
      },
    }],
  };
}

describe("Creative Run failure guidance", () => {
  beforeEach(() => {
    findRun.mockReset();
    findAttempts.mockReset().mockResolvedValue([]);
  });

  it.each(["character_video", "character_library"] as const)(
    "uses media-neutral fallback guidance for a failed %s Run",
    async (purpose) => {
      findRun.mockResolvedValue(failedRun(purpose));
      const detail = await getCreativeRunDetail({ runId: "run-failed", actor });

      expect(detail.items[0].failure).toEqual({
        errorCode: "provider_failed",
        operatorGuidance: "This Run did not produce a reviewable output. Open the Run details to inspect the failure before deciding whether to retry.",
      });
    },
  );

  it("preserves the provider's specific failure guidance", async () => {
    findRun.mockResolvedValue(failedRun("character_video"));
    findAttempts.mockResolvedValue([{
      id: "attempt-failed", requestId: "job-failed", status: "failed",
      errorCode: "provider_unavailable", operatorGuidance: "Restore the pinned video provider before retrying.",
      retryability: "retryable", workflowKey: "video-workflow", workflowVersion: 1,
    }]);

    const detail = await getCreativeRunDetail({ runId: "run-failed", actor });

    expect(detail.items[0].failure).toEqual({
      errorCode: "provider_unavailable",
      operatorGuidance: "Restore the pinned video provider before retrying.",
    });
  });
});
