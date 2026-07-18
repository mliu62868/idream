import { describe, expect, it } from "vitest";
import {
  characterProjectDraftPatchRequestSchema,
  creativeRunDetailSchema,
} from "./index";

describe("operator workspace contracts", () => {
  const reviewContext = {
    brief: "Create one clear customer-ready campaign image.",
    orientation: "16:9",
    profile: { key: "profile-1", version: 1, label: "Campaign image" },
    recipe: { key: "recipe-1", version: 1, label: "Freeplay" },
    referenceAssetCount: 0,
  };

  it("requires an optimistic version and an auditable reason for project autosave", () => {
    const result = characterProjectDraftPatchRequestSchema.safeParse({
      entityVersion: 3,
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
    expect(characterProjectDraftPatchRequestSchema.safeParse({
      ...(result.success ? result.data : {}),
      phase: "launch_ready",
    }).success).toBe(false);
  });

  it("rejects a creative detail whose derived counts contradict its outcome", () => {
    const result = creativeRunDetailSchema.safeParse({
      id: "run-1",
      title: "Feed refresh",
      purpose: "feed",
      reviewContext,
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
      settlementView: "not_required",
      retryEligibility: { eligibleItemIds: [], eligibleCount: 0 },
      legacyState: "completed",
      counts: { generated: 1, failed: 3, reviewed: 0, approved: 0, placed: 0, total: 4 },
      version: 2,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      items: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts settlement and frozen retry evidence on a truthful creative detail", () => {
    const result = creativeRunDetailSchema.safeParse({
      id: "run-2",
      title: "Campaign review",
      purpose: "campaign",
      reviewContext,
      target: { type: "campaign", id: "campaign-1" },
      ownerId: null,
      dueAt: null,
      priority: "normal",
      lifecycleState: "active",
      workflowStage: "brief",
      executionOutcome: "pending",
      reviewState: "not_ready",
      deploymentState: "unplaced",
      verificationState: "pending",
      settlementView: "not_required",
      retryEligibility: { eligibleItemIds: [], eligibleCount: 0 },
      legacyState: "draft",
      counts: { generated: 0, failed: 0, reviewed: 0, approved: 0, placed: 0, total: 0 },
      version: 1,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      items: [],
    });
    expect(result.success).toBe(true);
  });
});
