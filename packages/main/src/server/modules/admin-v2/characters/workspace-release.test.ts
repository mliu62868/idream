import { describe, expect, it } from "vitest";
import { characterWorkspaceLastFailedPublish } from "./workspace-release";

const occurredAt = new Date("2026-11-26T10:00:02.000Z");
const pack = { character_cover: "a-cover", character_hero: "a-hero", character_chat: "a-chat" };
type Input = Parameters<typeof characterWorkspaceLastFailedPublish>[0];

function input(overrides: Partial<Input> = {}): Input {
  return {
    latestRelease: { id: "candidate-1", status: "withdrawn", characterContentVersionId: "content-2" },
    latestReleasePack: pack,
    draftContentVersionId: "content-2",
    draftPack: { ...pack },
    withdrawal: {
      occurredAt,
      toState: {
        releaseStatus: "withdrawn",
        automatic: true,
        failureCode: "release_validation_failed",
        blockers: ["release_asset_source_authority"],
      },
    },
    validationRuns: [{ id: "run-1", releaseId: "candidate-1" }],
    checks: [
      { validationRunId: "run-1", checkKey: "release_asset_source_authority", result: "failed" },
      { validationRunId: "run-1", checkKey: "opening_complete", result: "passed" },
    ],
    ...overrides,
  };
}

describe("characterWorkspaceLastFailedPublish", () => {
  it("returns the recorded failure of an automatically withdrawn candidate that still matches the draft", () => {
    expect(characterWorkspaceLastFailedPublish(input())).toEqual({
      releaseId: "candidate-1",
      failureCode: "release_validation_failed",
      blockers: ["release_asset_source_authority"],
      failedAt: occurredAt.toISOString(),
    });
  });

  it("explains a projection failure that left no failed checks", () => {
    expect(characterWorkspaceLastFailedPublish(input({
      withdrawal: { occurredAt, toState: { automatic: true, failureCode: "release_projection_invalid", blockers: [] } },
      checks: [{ validationRunId: "run-1", checkKey: "opening_complete", result: "passed" }],
    }))).toEqual({
      releaseId: "candidate-1",
      failureCode: "release_projection_invalid",
      blockers: [],
      failedAt: occurredAt.toISOString(),
    });
  });

  it("does not present a manually discarded candidate as a failed publish", () => {
    expect(characterWorkspaceLastFailedPublish(input({
      withdrawal: { occurredAt, toState: { releaseStatus: "withdrawn", releaseVersion: 3 } },
    }))).toBeNull();
    expect(characterWorkspaceLastFailedPublish(input({ withdrawal: null }))).toBeNull();
  });

  it("drops the evidence once the draft content or any display image changed", () => {
    expect(characterWorkspaceLastFailedPublish(input({ draftContentVersionId: "content-3" }))).toBeNull();
    expect(characterWorkspaceLastFailedPublish(input({ draftPack: { ...pack, character_chat: "a-new" } }))).toBeNull();
    expect(characterWorkspaceLastFailedPublish(input({ draftPack: { character_cover: "a-cover", character_hero: "a-hero" } }))).toBeNull();
  });

  it("ignores a release that is not withdrawn", () => {
    expect(characterWorkspaceLastFailedPublish(input({ latestRelease: null }))).toBeNull();
    expect(characterWorkspaceLastFailedPublish(input({
      latestRelease: { id: "candidate-1", status: "published", characterContentVersionId: "content-2" },
    }))).toBeNull();
  });
});
