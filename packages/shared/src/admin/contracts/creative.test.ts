import { describe, expect, it } from "vitest";
import {
  characterRouteEvaluationMatrixDirections,
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationOutputsPerDirection,
  characterRouteEvaluationSampleCount,
  characterVideoProductionRecipe,
  creativePlacementWithdrawalRequestSchema,
  creativePlacementWithdrawalResultSchema,
  creativeRunCreateOptionsSchema,
  creativeRunCreateRequestSchema,
  creativeRunQuerySchema,
} from "./creative";

describe("Creative Run create contract", () => {
  const request = {
    purpose: "feed" as const,
    targetType: "none" as const,
    profileId: "portrait-v2",
    presetIds: [],
    count: 4,
    brief: "Create an explicit feed direction with four candidates.",
    consistencyMode: "balanced" as const,
    priority: "high" as const,
    reason: "Launch the approved operator brief",
  };

  it("owns the complete pinned Character video execution recipe", () => {
    expect(characterVideoProductionRecipe).toMatchObject({
      recipeVersion: 1,
      runner: "comfyui",
      pipelineModel: "ltx23-gtanimation-int4-convrot",
      workflowKey: "ltx23-gtanimation-i2v",
      workflowVersion: 1,
      sourceModelPath:
        "diffusion_models/ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors",
      checkpointFilename:
        "ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors",
      modelFormat: "safetensors",
      width: 768,
      height: 1152,
      fps: 25,
      durationSeconds: 4,
      steps: 13,
      sampler: "euler",
      scheduler: "manual_sigmas",
      cfgScale: 1,
    });
  });

  it("accepts an explicit, bounded brief", () => {
    expect(creativeRunCreateRequestSchema.parse(request)).toMatchObject(request);
  });

  it("rejects missing target identity and client-authored lifecycle state", () => {
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      targetType: "campaign",
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      lifecycleState: "closed",
    }).success).toBe(false);
  });

  it("accepts bounded persisted directions and rejects fan-out above the Run limit", () => {
    const direction = {
      id: "direction-1",
      title: "Intimate close-up",
      scenePrompt: "A quiet close portrait with an emotionally readable gesture.",
      mood: "warm",
      setting: "window seat",
      outfit: "soft knitwear",
      camera: "85mm close portrait",
      lighting: "soft directional light",
    };
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      count: 1,
      directions: [direction],
      outputsPerDirection: 4,
    }).success).toBe(true);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      count: 1,
      directions: Array.from({ length: 12 }, (_, index) => ({ ...direction, id: `direction-${index}` })),
      outputsPerDirection: 3,
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      outputsPerDirection: 2,
    }).success).toBe(false);
  });

  it("reserves the 40-sample limit for Character identity route evaluation", () => {
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      purpose: "model_eval",
      targetType: "character",
      targetId: "character-1",
      count: characterRouteEvaluationSampleCount,
      referenceAssetIds: [],
      directions: characterRouteEvaluationMatrixDirections,
      outputsPerDirection: characterRouteEvaluationOutputsPerDirection,
      routeEvaluationMatrixKey: characterRouteEvaluationMatrixKey("realistic"),
    }).success).toBe(true);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      count: 40,
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      purpose: "model_eval",
      targetType: "none",
      count: 40,
    }).success).toBe(false);
  });

  it("rejects model evaluation requests that mutate or repeat the canonical matrix", () => {
    const evaluationRequest = {
      ...request,
      purpose: "model_eval" as const,
      targetType: "character" as const,
      targetId: "character-1",
      count: characterRouteEvaluationSampleCount,
      referenceAssetIds: [],
      directions: characterRouteEvaluationMatrixDirections,
      outputsPerDirection: characterRouteEvaluationOutputsPerDirection,
      routeEvaluationMatrixKey: characterRouteEvaluationMatrixKey("realistic"),
    };
    expect(creativeRunCreateRequestSchema.safeParse({
      ...evaluationRequest,
      directions: characterRouteEvaluationMatrixDirections.map(
        (direction, index) => index === 0
          ? { ...direction, scenePrompt: `${direction.scenePrompt} Mutated.` }
          : direction,
      ),
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...evaluationRequest,
      directions: characterRouteEvaluationMatrixDirections.map(
        () => characterRouteEvaluationMatrixDirections[0],
      ),
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...evaluationRequest,
      outputsPerDirection: 3,
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...evaluationRequest,
      routeEvaluationMatrixKey: undefined,
    }).success).toBe(false);
  });

  it("accepts a focused candidate as an additional character reference", () => {
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      purpose: "character_hero",
      targetType: "character",
      targetId: "character-1",
      referenceAssetIds: ["approved-candidate-1"],
    }).success).toBe(true);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      purpose: "character_hero",
      targetType: "character",
      targetId: "character-1",
      referenceAssetIds: Array.from({ length: 5 }, (_, index) => `candidate-${index}`),
    }).success).toBe(false);
  });

  it("requires one pinned source image for a Character video Run", () => {
    const videoRequest = {
      ...request,
      purpose: "character_video" as const,
      targetType: "character" as const,
      targetId: "character-1",
      profileId: "profile_video_beta_v1",
      referenceAssetIds: ["character-source-1"],
      orientation: "2:3",
      count: 1,
      brief: "A subtle natural smile and direct eye contact with a steady camera.",
    };
    expect(creativeRunCreateRequestSchema.safeParse(videoRequest).success).toBe(true);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...videoRequest,
      referenceAssetIds: [],
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...videoRequest,
      referenceAssetIds: ["source-1", "source-2"],
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...videoRequest,
      count: 2,
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...videoRequest,
      targetType: "none",
      targetId: undefined,
    }).success).toBe(false);
  });

  it("rejects reference assets for generic text-to-image Runs", () => {
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      targetType: "none",
      targetId: undefined,
      referenceAssetIds: ["generic-reference-1"],
    }).success).toBe(false);
  });

  it("keeps generic image creation targetless until a reviewed artifact is placed", () => {
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      targetType: "character",
      targetId: "character-1",
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse(request).success).toBe(true);
  });

  it("makes first-portrait bootstrap an explicit, character-cover-only mode", () => {
    expect(creativeRunCreateRequestSchema.parse({
      title: "Mara first identity portrait",
      purpose: "character_cover",
      targetType: "character",
      targetId: "character-1",
      profileId: "redcraft-krea2",
      bootstrapIdentity: true,
      brief: "A definitive first portrait that will establish the identity authority.",
      reason: "Create the reviewed first identity anchor",
    }).bootstrapIdentity).toBe(true);
    expect(creativeRunCreateRequestSchema.safeParse({
      purpose: "character_hero",
      targetType: "character",
      targetId: "character-1",
      profileId: "redcraft-krea2",
      bootstrapIdentity: true,
      brief: "A hero image cannot establish the first identity.",
      reason: "Invalid bootstrap",
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      purpose: "character_cover",
      targetType: "none",
      profileId: "redcraft-krea2",
      brief: "A direct API call cannot bypass the dedicated Character workflow.",
      reason: "Invalid targetless character create",
    }).success).toBe(false);
  });

  it("freezes text-to-image and image-to-image identity calibration snapshots", () => {
    const calibrationBase = {
      ...request,
      purpose: "identity_calibration" as const,
      targetType: "character" as const,
      targetId: "character-1",
      referenceAssetIds: [],
    };
    expect(creativeRunCreateRequestSchema.parse({
      ...calibrationBase,
      identityExperiment: {
        mode: "text_to_image",
        negativePrompt: "different face, watermark",
        seedStrategy: "locked",
        baseSeed: "184732",
        strength: 0.65,
      },
    }).identityExperiment).toMatchObject({
      mode: "text_to_image",
      seedStrategy: "locked",
      baseSeed: "184732",
    });
    expect(creativeRunCreateRequestSchema.parse({
      ...calibrationBase,
      identityExperiment: {
        mode: "image_to_image",
        negativePrompt: "different face, watermark",
        seedStrategy: "reuse_source",
        sourceAssetId: "candidate-1",
        strength: 0.55,
      },
    }).identityExperiment).toMatchObject({
      mode: "image_to_image",
      sourceAssetId: "candidate-1",
      seedStrategy: "reuse_source",
    });
  });

  it("rejects ambiguous identity calibration mode, source, and seed combinations", () => {
    const calibrationBase = {
      ...request,
      purpose: "identity_calibration" as const,
      targetType: "character" as const,
      targetId: "character-1",
      referenceAssetIds: [],
    };
    expect(creativeRunCreateRequestSchema.safeParse(calibrationBase).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...calibrationBase,
      identityExperiment: {
        mode: "text_to_image",
        negativePrompt: "",
        seedStrategy: "reuse_source",
        sourceAssetId: "candidate-1",
      },
    }).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...calibrationBase,
      identityExperiment: {
        mode: "image_to_image",
        negativePrompt: "",
        seedStrategy: "locked",
      },
    }).success).toBe(false);
  });

  it("projects only friendly, compatible create options", () => {
    expect(creativeRunCreateOptionsSchema.parse({
      purposes: [{
        value: "campaign",
        label: "Campaign",
        description: "A verified campaign candidate.",
        defaultOrientation: "16:9",
        runtimePlacementSupported: true,
      }],
      profiles: [{
        profileKey: "campaign-image-v1",
        profileVersion: 1,
        label: "Campaign image",
        workflowKey: "txt2img",
        workflowVersion: 1,
        allowedOrientations: ["16:9"],
        recommended: true,
      }],
      readiness: { ready: true, blocker: null },
      characterAssetStudioHref: "/admin/characters",
    }).readiness.ready).toBe(true);
  });

  it("accepts a recent-first character-scoped studio query", () => {
    expect(creativeRunQuerySchema.parse({
      purpose: "character_video",
      targetType: "character",
      targetId: "character-1",
      sort: "updated_desc",
      limit: "20",
    })).toMatchObject({
      purpose: "character_video",
      targetType: "character",
      targetId: "character-1",
      sort: "updated_desc",
      limit: 20,
    });
  });

  it("keeps staged placement withdrawal versioned and terminally overridden", () => {
    expect(creativePlacementWithdrawalRequestSchema.parse({
      entityVersion: 6,
      reason: "Withdraw the staged candidate before changing review authority",
    })).toEqual({
      entityVersion: 6,
      reason: "Withdraw the staged candidate before changing review authority",
    });
    expect(creativePlacementWithdrawalResultSchema.parse({
      runId: "run-1",
      placementId: "placement-1",
      verificationState: "overridden",
      runVersion: 7,
    })).toEqual({
      runId: "run-1",
      placementId: "placement-1",
      verificationState: "overridden",
      runVersion: 7,
    });
    expect(creativePlacementWithdrawalResultSchema.safeParse({
      runId: "run-1",
      placementId: "placement-1",
      verificationState: "passed",
      runVersion: 7,
    }).success).toBe(false);
  });
});
