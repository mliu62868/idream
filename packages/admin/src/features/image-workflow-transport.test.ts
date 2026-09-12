import { describe, expect, it } from "vitest";
import {
  characterIdentityBootstrapMutation,
  characterReleaseCreateMutation,
  characterWorkspaceTabFromSearch,
  creativeRetryFailedMutation,
} from "./image-workflow-transport";

describe("image workflow browser transport", () => {
  it("restores the Character workspace tab from the URL and fails unknown values closed", () => {
    expect(characterWorkspaceTabFromSearch("?tab=assets")).toBe("assets");
    expect(characterWorkspaceTabFromSearch("?tab=video")).toBe("video");
    expect(characterWorkspaceTabFromSearch("?tab=voice")).toBe("voice");
    expect(characterWorkspaceTabFromSearch("?tab=release")).toBe("release");
    expect(characterWorkspaceTabFromSearch("?tab=made-up")).toBe("project");
    expect(characterWorkspaceTabFromSearch("")).toBe("project");
  });

  it("replays the durable key for identity bootstrap and leaves Release creation to the key ledger", () => {
    expect(
      characterIdentityBootstrapMutation(
        "character-1",
        2,
        "run-1",
        "item-1",
        "asset-1",
        "decision-1",
        "Use the reviewed first portrait as identity authority",
        "bootstrap-key",
      ),
    ).toMatchObject({
      operationId: "POST /api/v2/admin/characters/:id/identity-bootstrap",
      options: {
        path: { id: "character-1" },
        replayIdempotencyKey: "bootstrap-key",
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
    expect(
      characterReleaseCreateMutation(
        "character-1",
        8,
        "release reason",
        "character-1:publish",
      ),
    ).toMatchObject({
      operationId: "POST /api/v2/admin/characters/:id/releases",
      options: {
        path: { id: "character-1" },
        ifMatch: 8,
        body: {
          entityVersion: 8,
          reason: "release reason",
          confirmation: "character-1:publish",
        },
      },
    });
  });

  it("supplies exact confirmation for failed-item retry", () => {
    expect(creativeRetryFailedMutation("run-1", 4, "retry-key")).toMatchObject({
      operationId: "POST /api/v2/admin/creative/runs/:id/commands/retry-failed",
      options: {
        path: { id: "run-1" },
        replayIdempotencyKey: "retry-key",
        body: {
          entityVersion: 4,
          confirmation: "run-1:retry-failed",
        },
      },
    });
  });
});
