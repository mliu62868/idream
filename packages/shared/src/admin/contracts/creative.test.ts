import { describe, expect, it } from "vitest";
import {
  characterRouteEvaluationMatrixDirections,
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationOutputsPerDirection,
  characterRouteEvaluationSampleCount,
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
      targetType: "character",
      targetId: "character-1",
      sort: "updated_desc",
      limit: "20",
    })).toMatchObject({
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
