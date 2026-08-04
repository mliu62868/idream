import type { Prisma } from "@prisma/client";
import { assignWorkflowReferenceSlots } from "@idream/shared/gen-workflow";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import {
  isProductionLtxVideoProfile,
  PRODUCTION_LTX_VIDEO_PROFILE,
} from "@/server/modules/generation/production-video-profile";
import { isExecutableGenerationProfile } from "./generation-profile-catalog";

export type GenerationReferenceRouteRequirement = {
  readonly assetId: string;
  readonly role: "identity_anchor" | "identity_reference";
};

type GenerationReferenceProfile = {
  readonly profileKey: string;
  readonly version: number;
  readonly runner: string;
  readonly runnerConfig: Prisma.JsonValue | null;
  readonly workflowKey: string | null;
  readonly pipelineModel: string;
};

export async function generationReferenceRouteRequirements(
  visualProfileId: string,
): Promise<GenerationReferenceRouteRequirement[]> {
  const revision = await prisma.referenceSetRevision.findFirst({
    where: { visualProfileId, status: "active" },
    orderBy: { revision: "desc" },
    select: {
      references: {
        orderBy: { position: "asc" },
        select: { mediaAssetId: true, role: true },
      },
    },
  });
  return (
    revision?.references.map((reference) => ({
      assetId: reference.mediaAssetId,
      role: normalizedGenerationReferenceRole(reference.role),
    })) ?? []
  );
}

export function generationRequirementsFromManifest(
  value: unknown,
): GenerationReferenceRouteRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = jsonRecord(entry);
    const assetId = stringFromRecord(record, "mediaAssetId");
    const role = stringFromRecord(record, "role");
    if (
      !assetId ||
      !role ||
      role === "source_image" ||
      role === "look_reference"
    ) {
      return [];
    }
    return [
      {
        assetId,
        role: normalizedGenerationReferenceRole(role),
      },
    ];
  });
}

export function normalizedGenerationReferenceRole(
  role: string,
): GenerationReferenceRouteRequirement["role"] {
  return role === "primary_face" || role === "identity_anchor"
    ? "identity_anchor"
    : "identity_reference";
}

export function generationProfileReferenceIncompatibilities(input: {
  readonly profile: GenerationReferenceProfile;
  readonly workflowDescriptor: Awaited<
    ReturnType<typeof generationWorkflowDescriptor>
  >;
  readonly pinnedReferences: readonly GenerationReferenceRouteRequirement[];
  readonly sourceImageAssetId: string | null;
  readonly lookReferenceAssetId: string | null;
}) {
  const capabilities = generationModelCapabilities(
    input.profile.runnerConfig ?? {},
  );
  const reasons: string[] = [];
  if (
    (input.pinnedReferences.length > 0 || input.lookReferenceAssetId) &&
    !capabilities.referenceImages
  ) {
    reasons.push("profile_reference_images_unsupported");
  }
  if (input.sourceImageAssetId && !capabilities.initImage) {
    reasons.push("profile_source_image_unsupported");
  }
  const workflow = input.workflowDescriptor;
  const requiredRoles = [
    ...input.pinnedReferences.map((reference) => reference.role),
    ...(input.lookReferenceAssetId ? (["look_reference"] as const) : []),
    ...(input.sourceImageAssetId ? (["source_image"] as const) : []),
  ];
  if (!workflow && requiredRoles.length > 0) {
    reasons.push("workflow_descriptor_missing");
  }
  if (workflow) {
    if (
      requiredRoles.length > 0 &&
      (!workflow.capabilities.includes("referenceImages") ||
        workflow.identity.mode === "none")
    ) {
      reasons.push("workflow_reference_images_unsupported");
    }
    const acceptedRoles = new Set(workflow.identity.acceptedRoles);
    if (
      acceptedRoles.size > 0 &&
      requiredRoles.some((role) => !acceptedRoles.has(role))
    ) {
      reasons.push("workflow_reference_role_unsupported");
    }
    const slotAuthority = assignWorkflowReferenceSlots(workflow, requiredRoles);
    if (!slotAuthority.ok) {
      reasons.push(
        slotAuthority.reason === "reference_cardinality_mismatch"
          ? "workflow_reference_cardinality_mismatch"
          : "workflow_reference_slot_assignment_unsupported",
      );
    }
    if (
      input.lookReferenceAssetId &&
      !workflow.identity.supportsLookReference
    ) {
      reasons.push("workflow_look_reference_unsupported");
    }
    if (
      input.sourceImageAssetId &&
      (input.pinnedReferences.length > 0 ||
        Boolean(input.lookReferenceAssetId)) &&
      !workflow.identity.supportsSourceImageWithIdentity
    ) {
      reasons.push("workflow_source_with_identity_unsupported");
    }
  }
  return [...new Set(reasons)];
}

export function assertGenerationProfileCanDispatchReferences(input: {
  readonly profile: GenerationReferenceProfile;
  readonly workflowDescriptor: Awaited<
    ReturnType<typeof generationWorkflowDescriptor>
  >;
  readonly pinnedReferences: readonly GenerationReferenceRouteRequirement[];
  readonly sourceImageAssetId: string | null;
  readonly lookReferenceAssetId: string | null;
}) {
  const incompatibilities = generationProfileReferenceIncompatibilities(input);
  if (incompatibilities.length === 0) return;
  throw Errors.conflict(
    "Selected generation profile cannot preserve the complete pinned Character reference authority",
    {
      profileId: input.profile.profileKey,
      profileVersion: input.profile.version,
      pinnedReferenceAssetIds: input.pinnedReferences.map(
        (reference) => reference.assetId,
      ),
      sourceImageAssetId: input.sourceImageAssetId,
      lookReferenceAssetId: input.lookReferenceAssetId,
      incompatibilities,
    },
  );
}

export async function selectGenerationProfile(
  mode: "image" | "video",
  requested?: string,
  referenceRequirements?: {
    readonly pinnedReferences: readonly GenerationReferenceRouteRequirement[];
    readonly sourceImageAssetId: string | null;
    readonly lookReferenceAssetId: string | null;
  },
  requirePublicTextToImageProfile = false,
  accessibleEntitlements?: Readonly<Record<string, Prisma.JsonValue>>,
  requirePublicImageEditProfile = false,
) {
  const where: Prisma.GenerationModelProfileWhereInput = {
    mode,
    status: "active",
    enabled: true,
    ...(mode === "video"
      ? {
          profileKey: PRODUCTION_LTX_VIDEO_PROFILE.profileKey,
          runner: PRODUCTION_LTX_VIDEO_PROFILE.runner,
          pipelineModel: PRODUCTION_LTX_VIDEO_PROFILE.pipelineModel,
          workflowKey: PRODUCTION_LTX_VIDEO_PROFILE.workflowKey,
        }
      : {}),
    OR: requested
      ? [
          { profileKey: requested },
          { id: requested },
          { pipelineModel: requested },
        ]
      : undefined,
  };
  const queriedCandidates = await prisma.generationModelProfile.findMany({
    where,
    orderBy: requested
      ? [{ version: "desc" }]
      : [{ costMultiplier: "asc" }, { version: "desc" }],
  });
  const automaticCandidates = requested
    ? queriedCandidates
    : queriedCandidates.filter(
        (candidate) => !generationProfileIsExplicitSelectionOnly(candidate),
      );
  const eligibleCandidates =
    mode === "video"
      ? automaticCandidates.filter(
          (candidate) =>
            isProductionLtxVideoProfile(candidate) &&
            isExecutableGenerationProfile(candidate),
        )
      : requirePublicTextToImageProfile
        ? await filterPublicTextToImageGenerationProfiles(automaticCandidates)
        : requirePublicImageEditProfile
          ? (
              await projectPublicImageEditGenerationProfiles(
                automaticCandidates,
              )
            ).map(({ profile }) => profile)
          : automaticCandidates.filter(isExecutableGenerationProfile);
  const accessibleCandidates =
    !requested && accessibleEntitlements
      ? eligibleCandidates.filter(
          (candidate) =>
            !candidate.requiredEntitlement ||
            Boolean(accessibleEntitlements[candidate.requiredEntitlement]),
        )
      : eligibleCandidates;
  const gatedCandidates =
    !requested && accessibleEntitlements
      ? eligibleCandidates.filter(
          (candidate) => !accessibleCandidates.includes(candidate),
        )
      : [];
  if (referenceRequirements) {
    for (const candidateGroup of [accessibleCandidates, gatedCandidates]) {
      for (const candidate of candidateGroup) {
        const workflowDescriptor = await generationWorkflowDescriptor(
          candidate.workflowKey ?? candidate.pipelineModel,
        );
        if (
          generationProfileReferenceIncompatibilities({
            profile: candidate,
            workflowDescriptor,
            ...referenceRequirements,
          }).length === 0
        ) {
          return candidate;
        }
      }
    }
    if (eligibleCandidates.length === 0) {
      if (requested) {
        throw Errors.conflict("Requested generation profile is unavailable", {
          mode,
          requestedProfile: requested,
        });
      }
      throw Errors.unavailable(
        "No active generation model profile is configured",
        { mode, reason: "no_active_model" },
      );
    }
    throw Errors.conflict(
      requested
        ? "The selected generation profile cannot preserve pinned Character references"
        : "No active generation profile can preserve pinned Character references",
      {
        requestedProfile: requested ?? null,
        pinnedReferenceAssetIds: referenceRequirements.pinnedReferences.map(
          (reference) => reference.assetId,
        ),
        sourceImageAssetId: referenceRequirements.sourceImageAssetId,
        lookReferenceAssetId: referenceRequirements.lookReferenceAssetId,
      },
    );
  }
  const requestedProfile = requested ? eligibleCandidates[0] : null;
  if (requested && !requestedProfile) {
    throw Errors.conflict("Requested generation profile is unavailable", {
      mode,
      requestedProfile: requested,
    });
  }
  const fallbackProfile =
    requestedProfile ??
    accessibleCandidates[0] ??
    gatedCandidates[0] ??
    eligibleCandidates[0];
  if (!fallbackProfile) {
    throw Errors.unavailable(
      "No active generation model profile is configured",
      { mode, reason: "no_active_model" },
    );
  }
  return fallbackProfile;
}

export async function selectRecipe(
  mode: "image" | "video",
  useCase: "character" | "freeplay",
) {
  const recipe = await prisma.generationRecipe.findFirst({
    where: { mode, useCase, status: "active" },
    orderBy: { version: "desc" },
  });
  if (!recipe) {
    throw Errors.unavailable(
      "No active generation prompt recipe is configured",
      { mode, useCase, reason: "no_active_recipe" },
    );
  }
  return recipe;
}

type PublicTextToImageGenerationProfile = {
  readonly mode: string;
  readonly runner: string;
  readonly runnerConfig: Prisma.JsonValue | null;
  readonly workflowKey: string | null;
  readonly pipelineModel: string;
  readonly allowedOrientations: Prisma.JsonValue;
  readonly maxCount: number;
  readonly rolloutPercent: number;
};

async function isPublicTextToImageGenerationProfile(
  profile: PublicTextToImageGenerationProfile,
) {
  if (
    profile.mode !== "image" ||
    !isExecutableGenerationProfile(profile)
  ) {
    return false;
  }

  const configuredCapabilities = jsonRecord(
    jsonRecord(profile.runnerConfig).capabilities,
  );
  const configuredTextToImage = configuredCapabilities.textToImage;
  if (configuredTextToImage === false) return false;

  const workflow = await generationWorkflowDescriptor(
    profile.workflowKey ?? profile.pipelineModel,
  );
  if (workflow) {
    return (
      workflow.capabilities.includes("textToImage") &&
      !workflow.inputs.some((input) => input.type === "image")
    );
  }
  return configuredTextToImage === true;
}

export async function filterPublicTextToImageGenerationProfiles<
  T extends PublicTextToImageGenerationProfile,
>(profiles: readonly T[]): Promise<T[]> {
  const eligibility = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      eligible: await isPublicTextToImageGenerationProfile(profile),
    })),
  );
  return eligibility.flatMap(({ profile, eligible }) =>
    eligible ? [profile] : [],
  );
}

export type PublicImageEditReferenceMode =
  | "source_only"
  | "identity_source";

function generationProfilePublicSelection(profile: {
  readonly runnerConfig: Prisma.JsonValue | null;
}) {
  return jsonRecord(jsonRecord(profile.runnerConfig).publicSelection);
}

function generationProfileIsExplicitSelectionOnly(profile: {
  readonly runnerConfig: Prisma.JsonValue | null;
}) {
  return generationProfilePublicSelection(profile).explicitOnly === true;
}

export async function projectPublicImageEditGenerationProfiles<
  T extends PublicTextToImageGenerationProfile,
>(profiles: readonly T[]) {
  const projections = await Promise.all(
    profiles.map(async (profile) => {
      const publicSelection = generationProfilePublicSelection(profile);
      if (
        publicSelection.surface !== "generator_image_edit" ||
        profile.mode !== "image" ||
        !isExecutableGenerationProfile(profile) ||
        !generationModelCapabilities(profile.runnerConfig ?? {}).initImage
      ) {
        return null;
      }
      const workflow = await generationWorkflowDescriptor(
        profile.workflowKey ?? profile.pipelineModel,
      );
      if (
        !workflow ||
        !workflow.capabilities.includes("img2img") ||
        !workflow.inputs.some(
          (input) =>
            input.type === "image" &&
            "referenceRoles" in input &&
            input.referenceRoles?.includes("source_image"),
        )
      ) {
        return null;
      }
      const referenceMode: PublicImageEditReferenceMode =
        workflow.identity.supportsSourceImageWithIdentity
          ? "identity_source"
          : "source_only";
      return { profile, referenceMode, workflowDescriptor: workflow };
    }),
  );
  return projections.flatMap((projection) =>
    projection ? [projection] : [],
  );
}

function generationModelCapabilities(runnerConfig: Prisma.JsonValue) {
  const config = jsonRecord(runnerConfig);
  const capabilities = jsonRecord(config.capabilities);
  return {
    textToImage: booleanFromRecord(capabilities, "textToImage", true),
    stableSeed: booleanFromRecord(capabilities, "stableSeed", true),
    referenceImages: booleanFromRecord(
      capabilities,
      "referenceImages",
      false,
    ),
    initImage: booleanFromRecord(capabilities, "initImage", false),
    lora: booleanFromRecord(capabilities, "lora", false),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function booleanFromRecord(
  value: Record<string, unknown>,
  key: string,
  fallback: boolean,
) {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}
