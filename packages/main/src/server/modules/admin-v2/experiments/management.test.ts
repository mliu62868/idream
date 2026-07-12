import { describe, expect, it } from "vitest";
import { knownExperimentSurfaceBlockers } from "./management";

describe("known experiment product surfaces", () => {
  it("requires the Community definition to match the exact implemented behavior", () => {
    expect(knownExperimentSurfaceBlockers({
      key: "community.character-ranking.v1",
      eligibility: {},
      variants: [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
    })).toEqual([
      "community_ranking_eligibility_must_match_runtime_surface",
      "community_ranking_variants_must_match_runtime_behavior",
    ]);
    expect(knownExperimentSurfaceBlockers({
      key: "community.character-ranking.v1",
      eligibility: { surface: "community.leaderboard" },
      variants: [{ key: "control", allocationBps: 5_000 }, { key: "relationship_first", allocationBps: 5_000 }],
    })).toEqual([]);
  });

  it("leaves unknown definitions fail-closed until a product surface integrates them", () => {
    expect(knownExperimentSurfaceBlockers({
      key: "future.surface.v1",
      eligibility: {},
      variants: [{ key: "control" }, { key: "treatment" }],
    })).toEqual([]);
  });
});
