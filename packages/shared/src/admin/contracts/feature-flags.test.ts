import { describe, expect, it } from "vitest";
import { featureFlagPatchSchema } from "./feature-flags";
import {
  generationModelProfileCreateRequestSchema,
  generationModelProfilePatchRequestSchema,
} from "./generation-ops";

describe("serving rollout inputs", () => {
  it("accepts only off (0) or full (100) because runtime never serves a partial rollout", () => {
    const flag = { reason: "rollout test", confirmation: "x:updated" };
    expect(featureFlagPatchSchema.safeParse({ ...flag, rolloutPercent: 100 }).success).toBe(true);
    expect(featureFlagPatchSchema.safeParse({ ...flag, rolloutPercent: 0 }).success).toBe(true);
    expect(featureFlagPatchSchema.safeParse({ ...flag, rolloutPercent: 50 }).success).toBe(false);
    expect(generationModelProfilePatchRequestSchema.safeParse({ rolloutPercent: 25 }).success).toBe(false);
    const create = generationModelProfileCreateRequestSchema.safeParse({
      profileKey: "p", label: "P", mode: "image", runner: "comfyui", pipelineModel: "m",
      allowedOrientations: ["1:1"], rolloutPercent: 99,
    });
    expect(create.success).toBe(false);
  });
});
