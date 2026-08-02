import { isDeepStrictEqual } from "node:util";
import { characterVideoProductionRecipe } from "@idream/shared";

export const PRODUCTION_LTX_VIDEO_PROFILE = {
  profileKey: characterVideoProductionRecipe.profileKey,
  runner: characterVideoProductionRecipe.runner,
  pipelineModel: characterVideoProductionRecipe.pipelineModel,
  workflowKey: characterVideoProductionRecipe.workflowKey,
  sourceModelPath: characterVideoProductionRecipe.sourceModelPath,
  modelFormat: characterVideoProductionRecipe.modelFormat,
  runnerConfig: {
    workflowVersion: characterVideoProductionRecipe.workflowVersion,
    capabilities: {
      textToImage: false,
      stableSeed: true,
      referenceImages: false,
      initImage: true,
      imageToVideo: true,
      audio: true,
      fps: characterVideoProductionRecipe.fps,
      maxDurationSeconds: characterVideoProductionRecipe.durationSeconds,
    },
  },
  defaultWidth: characterVideoProductionRecipe.width,
  defaultHeight: characterVideoProductionRecipe.height,
  allowedOrientations: [characterVideoProductionRecipe.orientation],
  steps: characterVideoProductionRecipe.steps,
  sampler: characterVideoProductionRecipe.sampler,
  scheduler: characterVideoProductionRecipe.scheduler,
  cfgScale: characterVideoProductionRecipe.cfgScale,
  requiredEntitlement: characterVideoProductionRecipe.requiredEntitlement,
  maxCount: characterVideoProductionRecipe.outputCount,
  concurrencyLimit: characterVideoProductionRecipe.concurrencyLimit,
  rolloutPercent: characterVideoProductionRecipe.rolloutPercent,
  version: characterVideoProductionRecipe.recipeVersion,
} as const;

type ProductionVideoProfileCandidate = {
  readonly mode: string;
  readonly profileKey: string;
  readonly runner: string;
  readonly pipelineModel: string;
  readonly workflowKey: string | null;
  readonly sourceModelPath: string | null;
  readonly convertedModelPath: string | null;
  readonly modelFormat: string;
  readonly runnerConfig: unknown;
  readonly defaultWidth: number;
  readonly defaultHeight: number;
  readonly allowedOrientations: unknown;
  readonly steps: number;
  readonly sampler: string;
  readonly scheduler: string;
  readonly cfgScale: number;
  readonly requiredEntitlement: string | null;
  readonly maxCount: number;
  readonly concurrencyLimit: number;
  readonly enabled: boolean;
  readonly rolloutPercent: number;
  readonly version: number;
  readonly status: string;
};

// INVARIANT: Main only advertises, quotes, or dispatches the exact route that
// the Gen worker accepts. Operator pricing and labels remain independently
// editable; execution-critical model, workflow, entitlement, and envelope do not.
export function isProductionLtxVideoProfile(
  profile: ProductionVideoProfileCandidate,
) {
  const authority = PRODUCTION_LTX_VIDEO_PROFILE;
  return (
    profile.mode === "video" &&
    profile.profileKey === authority.profileKey &&
    profile.runner === authority.runner &&
    profile.pipelineModel === authority.pipelineModel &&
    profile.workflowKey === authority.workflowKey &&
    profile.sourceModelPath === authority.sourceModelPath &&
    profile.convertedModelPath === null &&
    profile.modelFormat === authority.modelFormat &&
    isDeepStrictEqual(profile.runnerConfig, authority.runnerConfig) &&
    profile.defaultWidth === authority.defaultWidth &&
    profile.defaultHeight === authority.defaultHeight &&
    isDeepStrictEqual(
      profile.allowedOrientations,
      authority.allowedOrientations,
    ) &&
    profile.steps === authority.steps &&
    profile.sampler === authority.sampler &&
    profile.scheduler === authority.scheduler &&
    profile.cfgScale === authority.cfgScale &&
    profile.requiredEntitlement === authority.requiredEntitlement &&
    profile.maxCount === authority.maxCount &&
    profile.concurrencyLimit === authority.concurrencyLimit &&
    profile.enabled === true &&
    profile.rolloutPercent === authority.rolloutPercent &&
    profile.version === authority.version &&
    profile.status === "active"
  );
}
