import { describe, expect, it } from "vitest";
import {
  characterProjectDraftPatchRequestSchema,
  creativeRunDetailSchema,
} from "./index";

describe("operator workspace contracts", () => {
  it("requires an optimistic version and an auditable reason for project autosave", () => {
    const result = characterProjectDraftPatchRequestSchema.safeParse({
      entityVersion: 3,
      phase: "qa",
      ownerId: null,
      audience: "People seeking a calm evening companion",
      companionNeed: "A predictable decompression ritual",
      hypothesis: "Warm direct openings increase qualified conversation",
      differentiation: "Quiet confidence without generic affirmation",
      targetPlacementKeys: ["feed_card"],
      successCriteria: ["QCE improves without D7 regression"],
      plannedLaunchAt: null,
      reason: "Autosave strategy step",
    });
    expect(result.success).toBe(true);
    expect(characterProjectDraftPatchRequestSchema.safeParse({
      ...(result.success ? result.data : {}),
      reason: "",
    }).success).toBe(false);
  });

  it("rejects a creative detail whose derived counts contradict its outcome", () => {
    const result = creativeRunDetailSchema.safeParse({
      id: "run-1",
      title: "Feed refresh",
      purpose: "feed",
      target: { type: "character", id: "character-1" },
      ownerId: null,
      dueAt: null,
      priority: "normal",
      lifecycleState: "active",
      workflowStage: "review",
      executionOutcome: "succeeded",
      reviewState: "pending",
      deploymentState: "unplaced",
      verificationState: "pending",
      counts: { generated: 1, failed: 3, reviewed: 0, approved: 0, placed: 0, total: 4 },
      version: 2,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      items: [],
    });
    expect(result.success).toBe(false);
  });
});
