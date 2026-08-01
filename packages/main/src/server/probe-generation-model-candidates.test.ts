import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateGenerationModelSourceSha256,
  evaluateGenerationModelCandidateActivation,
  evaluateGenerationModelCandidateSourceHash,
  generationModelCandidateDefinitions,
  resolveGenerationModelCandidateKey,
  shouldVerifyGenerationModelCandidateSourceHash,
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
      expectedPipelineModel: "redcraft-krea2-redmix3-fp8",
      expectedWorkflowKey: "redcraft-krea2-redmix3-txt2img",
      requireActive: true,
    });
  });

  it("tracks Dark Beast Klein as a quarantined Qwen comparison candidate", () => {
    expect(
      generationModelCandidateDefinitions.find(
        (candidate) => candidate.key === "darkbeast_flux2_klein_bfs",
      ),
    ).toMatchObject({
      profileId: "seed-profile-sdcpp-darkbeast-krea2-img2img-v1",
      expectedIntent: "image_edit_identity_source_comparison",
      expectedRunner: "comfyui",
      expectedPipelineModel: "darkbeast-flux2-klein-9b-bfs",
      expectedWorkflowKey: "darkbeast-flux2-klein-9b-multi-reference",
      expectedSourceSha256:
        "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
      minSampleCount: 1,
      requireActive: false,
      requireConsistency: true,
      requireVerification: true,
    });
  });

  it("tracks RedMix3 as a pinned BF16 conversion candidate", () => {
    expect(
      generationModelCandidateDefinitions.find(
        (candidate) => candidate.key === "redcraft_krea2_redmix3",
      ),
    ).toMatchObject({
      profileId: "seed-profile-redcraft-krea2-redmix3-v1",
      expectedIntent: "redmix3_text_to_image_comparison",
      expectedRunner: "comfyui",
      expectedPipelineModel: "redcraft-krea2-redmix3-fp8",
      expectedWorkflowKey: "redcraft-krea2-redmix3-txt2img",
      expectedSourceSha256:
        "F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA",
      minSampleCount: 1,
      requireActive: false,
      requireConsistency: false,
      requireVerification: true,
    });
  });

  it("requires the observed checkpoint hash to match the exact model version", () => {
    expect(
      evaluateGenerationModelCandidateSourceHash({
        expected:
          "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
        observed:
          "b20b6f2744e152fd3efa2638e88a5feab478c778ee25c81b183fd80e03a099c3",
      }),
    ).toEqual({ ready: true, blockedReason: null });
    expect(
      evaluateGenerationModelCandidateSourceHash({
        expected:
          "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
        observed:
          "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).toEqual({
      ready: false,
      blockedReason:
        "source SHA-256 is 0000000000000000000000000000000000000000000000000000000000000000, expected B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
    });
  });

  it("streams checkpoint bytes before applying the exact-version hash gate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "idream-model-hash-"));
    const checkpoint = path.join(dir, "candidate.safetensors");
    try {
      await writeFile(checkpoint, "wrong checkpoint");
      const observed =
        await calculateGenerationModelSourceSha256(checkpoint);
      expect(observed).toBe(
        "DB47A400472AE1A7E03D964B820F1EED8077EBD35763FC6430FFB72A136D1DA6",
      );
      expect(
        evaluateGenerationModelCandidateSourceHash({
          expected:
            "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
          observed,
        }),
      ).toMatchObject({ ready: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("always rechecks source integrity once a candidate has traffic exposure", () => {
    expect(
      shouldVerifyGenerationModelCandidateSourceHash({
        requireReady: false,
        status: "active",
        enabled: false,
        rolloutPercent: 0,
      }),
    ).toBe(true);
    expect(
      shouldVerifyGenerationModelCandidateSourceHash({
        requireReady: false,
        status: "draft",
        enabled: true,
        rolloutPercent: 0,
      }),
    ).toBe(true);
    expect(
      shouldVerifyGenerationModelCandidateSourceHash({
        requireReady: false,
        status: "draft",
        enabled: false,
        rolloutPercent: 1,
      }),
    ).toBe(true);
    expect(
      shouldVerifyGenerationModelCandidateSourceHash({
        requireReady: false,
        status: "draft",
        enabled: false,
        rolloutPercent: 0,
      }),
    ).toBe(false);
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
