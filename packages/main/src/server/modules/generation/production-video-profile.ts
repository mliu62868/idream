import { isDeepStrictEqual } from "node:util";
import {
  characterVideoProductionRecipe,
  characterVideoProductionRecipes,
  minimaxH3VideoProductionRecipe,
  redgraftLtx25VideoProductionRecipe,
  type CharacterVideoProductionRecipe,
} from "@idream/shared";
import { REDGRAFT_VIDEO_OPTIONS } from "@idream/shared/contracts";

function productionVideoProfile(recipe: CharacterVideoProductionRecipe) {
  return {
    profileKey: recipe.profileKey,
    runner: recipe.runner,
    pipelineModel: recipe.pipelineModel,
    workflowKey: recipe.workflowKey,
    sourceModelPath: recipe.sourceModelPath,
    modelFormat: recipe.modelFormat,
    runnerConfig: {
      workflowVersion: recipe.workflowVersion,
      capabilities: {
        textToImage: false,
        stableSeed: true,
        referenceImages: false,
        initImage: true,
        imageToVideo: true,
        audio: true,
        fps: recipe.fps,
        maxDurationSeconds: recipe.durationSeconds,
      },
      ...(recipe.explicitSelectionOnly
        ? { publicSelection: { explicitOnly: true } }
        : {}),
    },
    defaultWidth: recipe.width,
    defaultHeight: recipe.height,
    allowedOrientations: [recipe.orientation],
    steps: recipe.steps,
    sampler: recipe.sampler,
    scheduler: recipe.scheduler,
    cfgScale: recipe.cfgScale,
    requiredEntitlement: recipe.requiredEntitlement,
    maxCount: recipe.outputCount,
    concurrencyLimit: recipe.concurrencyLimit,
    rolloutPercent: recipe.rolloutPercent,
    version: recipe.recipeVersion,
  } as const;
}

export const PRODUCTION_H3_VIDEO_PROFILE = productionVideoProfile(
  minimaxH3VideoProductionRecipe,
);
export const PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE = productionVideoProfile(
  redgraftLtx25VideoProductionRecipe,
);

// The 480p publication uses v8 for the default and v9 for video options.
// Historical profiles retain their original dimensions and workflow pins.
export const PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE = {
  ...PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE,
  version: redgraftLtx25VideoProductionRecipe.optionsProfileVersion,
  allowedOrientations: [...REDGRAFT_VIDEO_OPTIONS.orientations],
  runnerConfig: { ...PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE.runnerConfig, videoOptions: REDGRAFT_VIDEO_OPTIONS },
} as const;

export function hasProductionVideoOptions(profile: ProductionVideoProfileCandidate) {
  return profileMatchesAuthority(profile, PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE);
}

const PRODUCTION_VIDEO_PROFILE_AUTHORITIES = characterVideoProductionRecipes.map(
  (recipe) => ({ recipe, profile: productionVideoProfile(recipe) }),
);

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
// SPEC: true for every published version of the default Character recipe
// (base and video-options publication). Derived from the recipe catalog so
// "is this the Character video route" never pins a profile version by hand.
export function isDefaultProductionVideoProfile(
  profile: ProductionVideoProfileCandidate,
) {
  return productionVideoRecipeForProfile(profile) === characterVideoProductionRecipe;
}

export function productionVideoRecipeForProfile(
  profile: ProductionVideoProfileCandidate,
): CharacterVideoProductionRecipe | null {
  if (hasProductionVideoOptions(profile)) return redgraftLtx25VideoProductionRecipe;
  return PRODUCTION_VIDEO_PROFILE_AUTHORITIES.find(
    ({ profile: authority }) => profileMatchesAuthority(profile, authority),
  )?.recipe ?? null;
}

export function isProductionVideoProfile(
  profile: ProductionVideoProfileCandidate,
) {
  return productionVideoRecipeForProfile(profile) !== null;
}

function profileMatchesAuthority(
  profile: ProductionVideoProfileCandidate,
  authority: Omit<ReturnType<typeof productionVideoProfile>, "runnerConfig" | "allowedOrientations" | "version"> & { runnerConfig: unknown; allowedOrientations: readonly string[]; version: number },
) {
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
