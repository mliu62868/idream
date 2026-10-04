import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateGenerationModelSourceSha256,
  evaluateGenerationModelCandidateActivation,
  evaluateGenerationModelCandidateSourceHash,
  generationModelCandidateDefinitions,
  runGenerationModelCandidateProbe,
  shouldVerifyGenerationModelCandidateSourceHash,
} from "./probe-generation-model-candidates";

const probeDb = vi.hoisted(() => ({
  generationModelProfile: { findMany: vi.fn() },
  $disconnect: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({ prisma: probeDb }));

afterEach(() => vi.resetAllMocks());

describe("generation model candidate authority", () => {
  it("pins the active default to the exact REDQW21 ComfyUI route and source hash", () => {
    expect(generationModelCandidateDefinitions).toEqual([
      {
        key: "redqw21_default",
        profileKey: "profile_image_default_v1",
        expectedRunner: "comfyui",
        expectedPipelineModel: "redqw21",
        expectedWorkflowKey: "redqw21",
        expectedSourceSha256: "9830a9925759a4b69ea1346133d08917ec2390b8495ea7f0eb613f37e7c46647",
        minSampleCount: 1,
        requireActive: true,
        requireConsistency: false,
        requireVerification: false,
      },
    ]);
  });

  it("queries the active profile by key and reports its published row ID", async () => {
    probeDb.generationModelProfile.findMany.mockResolvedValue([
      {
        id: "published-redqw21-default-v4",
        profileKey: "profile_image_default_v1",
        label: "Default REDQW21",
        runner: "comfyui",
        pipelineModel: "redqw21",
        workflowKey: "redqw21",
        sourceModelPath: null,
        convertedModelPath: null,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
        runnerConfig: {
          diffusionModelSha256: generationModelCandidateDefinitions[0].expectedSourceSha256,
        },
        dryRunSummary: { sampleCount: 1 },
        mode: "image",
      },
    ]);
    const report = await runGenerationModelCandidateProbe({
      candidateKeys: ["redqw21_default"], report: null, requireReady: false,
    });
    expect(probeDb.generationModelProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profileKey: { in: ["profile_image_default_v1"] }, status: "active" },
      }),
    );
    expect(report.candidates[0]).toMatchObject({
      profileKey: "profile_image_default_v1",
      profileId: "published-redqw21-default-v4",
      found: true,
      pipelineModel: "redqw21",
    });
    expect(report.candidates[0].blockedReasons).not.toContain("configured source SHA-256 is missing");
  });

  it("reports a missing active profile without inventing a seed row ID", async () => {
    probeDb.generationModelProfile.findMany.mockResolvedValue([]);
    const report = await runGenerationModelCandidateProbe({
      candidateKeys: ["redqw21_default"], report: null, requireReady: false,
    });
    expect(report).toMatchObject({ ok: false });
    expect(report.candidates[0]).toMatchObject({
      profileKey: "profile_image_default_v1", profileId: null, found: false,
    });
  });

  it.each(["redcraft_krea2_default", "pornmaster_zimage_default"])(
    "rejects retired candidate key %s before querying profiles", async (key) => {
      const report = await runGenerationModelCandidateProbe({
        candidateKeys: [key], report: null, requireReady: false,
      });
      expect(report.error?.code).toBe("unknown_generation_model_candidate");
      expect(probeDb.generationModelProfile.findMany).not.toHaveBeenCalled();
    },
  );

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
