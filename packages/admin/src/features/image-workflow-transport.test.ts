import { describe, expect, it } from "vitest";
import {
  characterIdentityBootstrapMutation,
  characterQaMutation,
  characterReleaseProposalMutation,
  characterReleaseReviewMutation,
  characterWorkspaceTabFromSearch,
  creativeRetryFailedMutation,
} from "./image-workflow-transport";

describe("image workflow browser transport", () => {
  it("restores the Character workspace tab from the URL and fails unknown values closed", () => {
    expect(characterWorkspaceTabFromSearch("?tab=assets")).toBe("assets");
    expect(characterWorkspaceTabFromSearch("?tab=voice")).toBe("voice");
    expect(characterWorkspaceTabFromSearch("?tab=release")).toBe("release");
    expect(characterWorkspaceTabFromSearch("?tab=made-up")).toBe("project");
    expect(characterWorkspaceTabFromSearch("")).toBe("project");
  });

  it("supplies idempotency for immutable QA and Release proposal mutations", () => {
    expect(characterIdentityBootstrapMutation(
      "character-1",
      2,
      "run-1",
      "item-1",
      "asset-1",
      "decision-1",
      "Use the reviewed first portrait as identity authority",
      "bootstrap-key",
    )).toMatchObject({
      path: "/api/v2/admin/characters/character-1/identity-bootstrap",
      options: {
        method: "POST",
        idempotencyKey: "bootstrap-key",
        ifMatch: 2,
        body: {
          entityVersion: 2,
          runId: "run-1",
          itemId: "item-1",
          assetId: "asset-1",
          reviewDecisionId: "decision-1",
          confirmation: "BOOTSTRAP IDENTITY character-1",
        },
      },
    });
    expect(characterQaMutation("character-1", 7, [], "qa reason", "qa-key")).toMatchObject({
      path: "/api/v2/admin/characters/character-1/qa-runs",
      options: {
        method: "POST",
        idempotencyKey: "qa-key",
        ifMatch: 7,
        body: { entityVersion: 7, checks: [], reason: "qa reason" },
      },
    });
    expect(characterReleaseProposalMutation(
      "character-1",
      8,
      "qa-1",
      "release reason",
      "character-1:propose-release",
      "release-key",
    )).toMatchObject({
      path: "/api/v2/admin/characters/character-1/releases",
      options: {
        method: "POST",
        idempotencyKey: "release-key",
        ifMatch: 8,
        body: {
          entityVersion: 8,
          qaRunId: "qa-1",
          reason: "release reason",
          confirmation: "character-1:propose-release",
        },
      },
    });
  });

  it("supplies retry-safe transport for Release review and exact confirmation for failed-item retry", () => {
    expect(characterReleaseReviewMutation(
      "character-1",
      "release-1",
      3,
      "approved",
      "reviewed",
      "character-1:release-1:approved",
      "review-key",
    )).toMatchObject({
      path: "/api/v2/admin/characters/character-1/releases/release-1/review",
      options: {
        method: "POST",
        idempotencyKey: "review-key",
        ifMatch: 3,
        body: {
          entityVersion: 3,
          decision: "approved",
          reason: "reviewed",
          confirmation: "character-1:release-1:approved",
        },
      },
    });
    expect(creativeRetryFailedMutation("run-1", 4, "retry-key")).toMatchObject({
      path: "/api/v2/admin/creative/runs/run-1/commands/retry-failed",
      options: {
        method: "POST",
        idempotencyKey: "retry-key",
        body: {
          entityVersion: 4,
          confirmation: "run-1:retry-failed",
        },
      },
    });
  });
});
