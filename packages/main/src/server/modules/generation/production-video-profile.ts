import { isDeepStrictEqual } from "node:util";

export const PRODUCTION_LTX_VIDEO_PROFILE = {
  profileKey: "profile_video_beta_v1",
  runner: "comfyui",
  pipelineModel: "ltx23-gtanimation-int4-convrot",
  workflowKey: "ltx23-gtanimation-i2v",
  sourceModelPath:
    "diffusion_models/ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors",
  modelFormat: "safetensors",
  runnerConfig: {
    workflowVersion: 1,
    capabilities: {
      textToImage: false,
      stableSeed: true,
      referenceImages: false,
      initImage: true,
      imageToVideo: true,
      audio: true,
      fps: 25,
      maxDurationSeconds: 4,
    },
  },
  defaultWidth: 768,
  defaultHeight: 1152,
  allowedOrientations: ["2:3"],
  steps: 13,
  sampler: "euler",
  scheduler: "manual_sigmas",
  cfgScale: 1,
  requiredEntitlement: "video_generation",
  maxCount: 1,
  concurrencyLimit: 1,
  rolloutPercent: 100,
  version: 1,
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
