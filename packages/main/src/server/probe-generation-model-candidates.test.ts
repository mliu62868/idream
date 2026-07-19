import { describe, expect, it } from "vitest";
import {
  evaluateGenerationModelCandidateActivation,
  generationModelCandidateDefinitions,
  resolveGenerationModelCandidateKey,
} from "./probe-generation-model-candidates";

describe("generation model candidate authority", () => {
  it("pins the active default to the exact Redcraft ComfyUI route", () => {
    expect(
      generationModelCandidateDefinitions.find(
        (candidate) => candidate.key === "redcraft_krea2_default",
      ),
    ).toMatchObject({
      profileId: "seed-profile-image-default-v1",
      expectedRunner: "comfyui",
      expectedPipelineModel: "redcraft-krea2-comfyui",
      expectedWorkflowKey: "redcraft-krea2-txt2img",
      requireActive: true,
    });
  });

  it("accepts the historical Pornmaster key only as an input alias", () => {
    expect(
      resolveGenerationModelCandidateKey("pornmaster_zimage_default"),
    ).toBe("redcraft_krea2_default");
    expect(
      generationModelCandidateDefinitions.some(
        (candidate) => candidate.key === "pornmaster_zimage_default",
      ),
    ).toBe(false);
  });

  it.each([1, 99])(
    "rejects the active default when rolloutPercent is %i",
    (rolloutPercent) => {
      expect(
        evaluateGenerationModelCandidateActivation({
          requireActive: true,
          status: "active",
          enabled: true,
          rolloutPercent,
        }),
      ).toEqual({
        ready: false,
        blockedReasons: [
          `rolloutPercent is ${rolloutPercent}, expected 100`,
        ],
      });
    },
  );

  it("accepts the active default only when enabled at 100% rollout", () => {
    expect(
      evaluateGenerationModelCandidateActivation({
        requireActive: true,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
      }),
    ).toEqual({
      ready: true,
      blockedReasons: [],
    });
  });

  it("rejects a disabled default even at 100% rollout", () => {
    expect(
      evaluateGenerationModelCandidateActivation({
        requireActive: true,
        status: "active",
        enabled: false,
        rolloutPercent: 100,
      }),
    ).toEqual({
      ready: false,
      blockedReasons: ["profile is disabled"],
    });
  });
});
