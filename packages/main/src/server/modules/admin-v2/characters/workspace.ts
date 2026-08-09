import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import {
  characterVideoProductionRecipe,
  adminCommandStatusSchema,
  characterProjectDraftResumeSchema,
  characterQaRunSchema,
} from "@idream/shared/admin";
import { loadCharacterSoulSnapshot, requiredChatCanaryProfiles } from "@idream/shared";
import type { Prisma } from "@prisma/client";
import { inTransaction, prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { listCharacterPortfolioData } from "./portfolio";
import { collectReleaseMonitorFacts } from "./release-monitor";
import { toInputJson } from "../shared/prisma-json";
import { characterDraftSnapshots } from "./draft-content";
import { issueCharacterPreviewToken } from "./preview-token";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { evaluateReleaseReadiness } from "./readiness";
import { findOperationalGenerationRoute } from "./visual-authority";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  OPERATIONAL_USER_DATA_CLASS_SQL,
  operationalCharacterWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import { ACTIVE_CONTROL_PLANE_COMMAND_STATUSES } from "../shared/control-plane-command";
import { characterCommandCoordinationKey } from "./command-coordination";
import { loadCharacterIdentityBootstrapAuthority } from "./identity-bootstrap-authority";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { evaluateDraftAssetRouteAuthority } from "./draft-asset-route-authority";
import {
  generationRouteRuntimeCompatibility,
  generationSourceVariationAuthority,
  identityCalibrationGenerationModes,
} from "./generation-route-authority";
import {
  characterImageReadinessFingerprint,
  inspectCharacterImageGenerationSource,
} from "./image-readiness-authority";
import {
  evaluateEditorialReleaseAuthority,
} from "@/server/modules/ourdream/public-release-authority";
import {
  characterVoiceProfileDto,
  inspectConfiguredVoiceIdentityRuntime,
} from "./voice-identity";
import { loadCharacterMediaOperationsProjection } from "./character-media-operations";
import { characterReleaseExactAssetPackByPurpose } from "./character-release-contract";
import {
  type CharacterWorkspaceAnchor,
  characterWorkspaceAnchorLink,
  characterWorkspaceLink,
  characterWorkspaceTabLink,
} from "./character-deep-link";
import {
  getVoiceDefaultSettings,
  voiceIdForGender,
} from "@/server/modules/voice-defaults";
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";

const CHARACTER_VIDEO_HEALTH_WINDOW_DAYS = 7;

type SoulContentVersion = {
  id: string;
  version: number;
  personaSnapshot: Prisma.JsonValue;
};

function characterSoulWorkspaceProjection(
  versions: readonly SoulContentVersion[],
  servingVersion: SoulContentVersion | null,
) {
  const current = versions[0];
  if (!current) throw Errors.notFound("Character Soul content version not found");
  const loaded = loadCharacterSoulSnapshot(current.personaSnapshot);
  // SPEC: operator diffs answer "what will change in Serving?", not merely
  // "what changed since the last draft?".
  const previousRow = servingVersion;
  const previousLoaded = previousRow
    ? loadCharacterSoulSnapshot(previousRow.personaSnapshot)
    : null;
  const raw = record(current.personaSnapshot);
  return {
    valid: loaded.ok,
    current: {
      contentVersionId: current.id,
      version: current.version,
      schemaVersion:
        typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0,
      compilerVersion: loaded.ok
        ? loaded.snapshot.compiled.compilerVersion
        : null,
      fingerprint: loaded.ok ? loaded.snapshot.compiled.fingerprint : null,
      estimatedTokens: loaded.ok
        ? loaded.snapshot.compiled.estimatedTokens
        : null,
      soul: loaded.ok
        ? loaded.snapshot.soul as unknown as Record<string, unknown>
        : null,
      markdown: loaded.ok ? loaded.renderedMarkdown : null,
      systemPrompt: loaded.ok
        ? loaded.snapshot.compiled.systemPrompt
        : null,
      diagnostics: loaded.diagnostics,
    },
    previous: previousRow
      ? {
          contentVersionId: previousRow.id,
          version: previousRow.version,
          fingerprint: previousLoaded?.ok
            ? previousLoaded.snapshot.compiled.fingerprint
            : null,
        }
      : null,
    changedFields:
      loaded.ok && previousLoaded?.ok
        ? changedSoulFields(
            previousLoaded.snapshot.soul as unknown as Record<string, unknown>,
            loaded.snapshot.soul as unknown as Record<string, unknown>,
          )
        : [],
    requiredCanaryProfiles: requiredChatCanaryProfiles(process.env).map(
      ({ tier, profile }) => ({
        tier,
        provider: profile.provider,
        model: profile.model,
      }),
    ),
  };
}

function changedSoulFields(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  prefix = "soul",
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys].sort().flatMap((key) => {
    const before = previous[key];
    const after = current[key];
    const path = `${prefix}.${key}`;
    if (isPlainRecord(before) && isPlainRecord(after)) {
      return changedSoulFields(before, after, path);
    }
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadCharacterVideoGenerationEstimate() {
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      profileKey: characterVideoProductionRecipe.profileKey,
      mode: "video",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: { version: "desc" },
  });
  if (!profile || !isProductionLtxVideoProfile(profile)) {
    return {
      profileKey: characterVideoProductionRecipe.profileKey,
      estimatedCostDreamcoins: null,
      averageDurationMs: null,
      completedSampleCount: 0,
      windowDays: CHARACTER_VIDEO_HEALTH_WINDOW_DAYS,
    };
  }
  const since = new Date(
    Date.now() -
      CHARACTER_VIDEO_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );
  const [healthRows, estimatedCostDreamcoins] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        averageDurationMs: number | null;
        completedSampleCount: number;
      }>
    >`
      SELECT
        GREATEST(
          0,
          AVG(EXTRACT(EPOCH FROM (jobs."completedAt" - jobs."createdAt")) * 1000)
        )::float8 AS "averageDurationMs",
        count(*)::int AS "completedSampleCount"
      FROM "generation_jobs" jobs
      JOIN "users" owners ON owners.id = jobs."userId"
      WHERE jobs."createdAt" >= ${since}
        AND jobs."completedAt" IS NOT NULL
        AND jobs."mode" = 'video'
        AND jobs."profileId" = ${profile.profileKey}
        AND jobs."profileVersion" = ${profile.version}
        AND owners."dataClass" IN (${OPERATIONAL_USER_DATA_CLASS_SQL})
    `,
    generationCostDreamcoins(
      "video",
      characterVideoProductionRecipe.outputCount,
      profile.costMultiplier,
    ).catch(() => null),
  ]);
  const health = healthRows[0];
  return {
    profileKey: profile.profileKey,
    estimatedCostDreamcoins,
    averageDurationMs: health?.averageDurationMs ?? null,
    completedSampleCount: health?.completedSampleCount ?? 0,
    windowDays: CHARACTER_VIDEO_HEALTH_WINDOW_DAYS,
  };
}

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const characterPreviewAssetPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

type CharacterPreviewAssetPurpose = (typeof characterPreviewAssetPurposes)[number];

type CharacterPreviewAssetPackIds = Partial<Record<CharacterPreviewAssetPurpose, string>>;

function characterAssetPack(value: Prisma.JsonValue): CharacterPreviewAssetPackIds {
  const source = record(value);
  return Object.fromEntries(
    characterPreviewAssetPurposes.flatMap((purpose) => {
      const entry = source[purpose];
      if (typeof entry === "string") return [[purpose, entry]];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const assetId = (entry as Record<string, unknown>).assetId;
      return typeof assetId === "string" ? [[purpose, assetId]] : [];
    }),
  );
}

function releasePreviewAssetPackIds(
  release: { releasePlacementManifest: Prisma.JsonValue } | null,
): CharacterPreviewAssetPackIds {
  return release ? characterReleaseExactAssetPackByPurpose(release) : {};
}

type CharacterPreviewMediaAsset = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  deletedAt: Date | null;
  type: string;
  safetyStatus: string;
  characterId: string | null;
  metadata: Prisma.JsonValue;
};

function previewAssetPackDto(
  assetIds: CharacterPreviewAssetPackIds,
  assets: ReadonlyMap<string, CharacterPreviewMediaAsset>,
  characterId: string,
) {
  return Object.fromEntries(characterPreviewAssetPurposes.map((purpose) => {
    const assetId = assetIds[purpose] ?? null;
    const asset = assetId ? assets.get(assetId) : null;
    const available = Boolean(
      asset &&
      asset.deletedAt === null &&
      asset.type === "image" &&
      asset.safetyStatus === "passed" &&
      asset.characterId === characterId &&
      isMediaAssetOperationalForAuthority(asset.metadata)
    );
    return [purpose, {
      assetId,
      imageUrl: available && asset
        ? asset.thumbnailUrl ?? asset.url
        : null,
      status: assetId === null
        ? "missing" as const
        : available
          ? "available" as const
          : "unavailable" as const,
    }];
  })) as Record<CharacterPreviewAssetPurpose, {
    assetId: string | null;
    imageUrl: string | null;
    status: "available" | "missing" | "unavailable";
  }>;
}

function characterAssetSelections(
  value: Prisma.JsonValue,
  currentRouteFingerprint: string | null,
) {
  const routeAuthority = evaluateDraftAssetRouteAuthority(
    value,
    currentRouteFingerprint,
  );
  const source = record(value);
  return Object.fromEntries(
    (["character_cover", "character_hero", "character_chat"] as const).flatMap((purpose) => {
      const raw = source[purpose];
      if (typeof raw === "string") {
        return [[purpose, {
          assetId: raw,
          runId: null,
          itemId: null,
          reviewDecisionId: null,
          generationJobId: null,
          bootstrapIdentity: false,
          generationRouteFingerprint: null,
          routeCurrent: routeAuthority.routeCurrentByPurpose[purpose] ?? false,
        }]];
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const entry = raw as Record<string, unknown>;
      if (typeof entry.assetId !== "string") return [];
      return [[purpose, {
        assetId: entry.assetId,
        runId: typeof entry.runId === "string" ? entry.runId : null,
        itemId: typeof entry.itemId === "string" ? entry.itemId : null,
        reviewDecisionId: typeof entry.reviewDecisionId === "string" ? entry.reviewDecisionId : null,
        generationJobId: typeof entry.generationJobId === "string" ? entry.generationJobId : null,
        bootstrapIdentity: entry.bootstrapIdentity === true,
        generationRouteFingerprint:
          typeof entry.generationRouteFingerprint === "string"
            ? entry.generationRouteFingerprint
            : null,
        routeCurrent: routeAuthority.routeCurrentByPurpose[purpose] ?? false,
      }]];
    }),
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return record(value);
}

async function findBootstrapGenerationProfile() {
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [{ publishedAt: "desc" }, { version: "desc" }, { profileKey: "asc" }],
    take: 40,
  });
  const ordered = [...profiles].sort((left, right) => {
    const entitlementDelta = Number(Boolean(left.requiredEntitlement)) - Number(Boolean(right.requiredEntitlement));
    return entitlementDelta || left.profileKey.localeCompare(right.profileKey);
  });
  for (const profile of ordered) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const capabilities = record(record(profile.runnerConfig).capabilities as Prisma.JsonValue | undefined);
    if (
      !workflow ||
      workflow.identity.mode !== "none" ||
      workflow.identity.maxReferences !== 0 ||
      !workflow.capabilities.includes("textToImage") ||
      capabilities.textToImage !== true
    ) {
      continue;
    }
    const allowedOrientations = strings(profile.allowedOrientations);
    return {
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      workflowKey,
      workflowVersion: workflow.version,
      orientation: allowedOrientations.includes("4:5")
        ? "4:5"
        : allowedOrientations[0] ?? "4:5",
    };
  }
  return null;
}

async function findRouteEvaluationGenerationProfiles(
  requiredReferenceRoles: readonly string[],
) {
  if (requiredReferenceRoles.length === 0) return [];
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [
      { publishedAt: "desc" },
      { version: "desc" },
      { profileKey: "asc" },
    ],
    take: 80,
  });
  const compatible: Array<{
    profileKey: string;
    profileVersion: number;
    label: string;
    workflowKey: string;
    workflowVersion: number;
    orientation: string;
    requiredEntitlement: string | null;
  }> = [];
  for (const profile of profiles) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const incompatibility = generationRouteRuntimeCompatibility({
      workflow,
      qualificationWorkflowVersion: workflow?.version ?? 0,
      profileCapabilities: record(profile.runnerConfig).capabilities,
      requiredReferenceCount: requiredReferenceRoles.length,
      requiredReferenceRoles,
    });
    if (incompatibility || !workflow) continue;
    const allowedOrientations = strings(profile.allowedOrientations);
    compatible.push({
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      workflowKey,
      workflowVersion: workflow.version,
      orientation: allowedOrientations.includes("4:5")
        ? "4:5"
        : allowedOrientations[0] ?? "4:5",
      requiredEntitlement: profile.requiredEntitlement,
    });
  }
  compatible.sort((left, right) =>
    Number(Boolean(left.requiredEntitlement)) -
      Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.profileVersion - left.profileVersion
  );
  return compatible.map((profile, index) => ({
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    label: profile.label,
    workflowKey: profile.workflowKey,
    workflowVersion: profile.workflowVersion,
    orientation: profile.orientation,
    recommended: index === 0,
  }));
}

async function findIdentityCalibrationGenerationProfiles() {
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [
      { publishedAt: "desc" },
      { version: "desc" },
      { profileKey: "asc" },
    ],
    take: 80,
  });
  const compatible: Array<{
    profileKey: string;
    profileVersion: number;
    label: string;
    modelId: string;
    workflowKey: string;
    workflowVersion: number;
    orientation: string;
    allowedOrientations: string[];
    modes: Array<"text_to_image" | "image_to_image">;
    requiredEntitlement: string | null;
  }> = [];
  for (const profile of profiles) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    if (!workflow) continue;
    const capabilities = record(
      record(profile.runnerConfig).capabilities as Prisma.JsonValue | undefined,
    );
    const modes = identityCalibrationGenerationModes({
      workflow,
      profileCapabilities: capabilities,
    });
    if (modes.length === 0) continue;
    const allowedOrientations = strings(profile.allowedOrientations);
    compatible.push({
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      modelId: profile.pipelineModel,
      workflowKey,
      workflowVersion: workflow.version,
      orientation: allowedOrientations.includes("4:5")
        ? "4:5"
        : allowedOrientations[0] ?? "4:5",
      allowedOrientations: allowedOrientations.length > 0
        ? allowedOrientations
        : ["4:5"],
      modes,
      requiredEntitlement: profile.requiredEntitlement,
    });
  }
  compatible.sort((left, right) =>
    Number(!left.modes.includes("text_to_image")) -
      Number(!right.modes.includes("text_to_image")) ||
    Number(Boolean(left.requiredEntitlement)) -
      Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.profileVersion - left.profileVersion
  );
  return compatible.map((profile, index) => ({
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    label: profile.label,
    modelId: profile.modelId,
    workflowKey: profile.workflowKey,
    workflowVersion: profile.workflowVersion,
    orientation: profile.orientation,
    allowedOrientations: profile.allowedOrientations,
    modes: profile.modes,
    recommended: index === 0,
  }));
}

type VisualAssetProjectionSource = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  deletedAt: Date | null;
  type: string;
  safetyStatus: string;
  characterId: string | null;
  metadata: Prisma.JsonValue;
};

function visualAssetAvailable(asset: VisualAssetProjectionSource, expectedCharacterId: string) {
  return asset.deletedAt === null &&
    asset.type === "image" &&
    asset.safetyStatus === "passed" &&
    isMediaAssetOperationalForAuthority(asset.metadata) &&
    asset.characterId === expectedCharacterId;
}

function visualAssetDto(asset: VisualAssetProjectionSource, role: string, expectedCharacterId: string, scores: { qualityScore?: number | null; identityScore?: number | null } = {}) {
  const available = visualAssetAvailable(asset, expectedCharacterId);
  return {
    mediaAssetId: asset.id,
    role,
    available,
    url: available ? asset.url : null,
    thumbnailUrl: available ? asset.thumbnailUrl : null,
    qualityScore: scores.qualityScore ?? null,
    identityScore: scores.identityScore ?? null,
  };
}

function videoSourceAssetDto(
  asset: VisualAssetProjectionSource,
  expectedCharacterId: string,
) {
  const available = visualAssetAvailable(asset, expectedCharacterId);
  return {
    mediaAssetId: asset.id,
    available,
    url: available ? asset.url : null,
    thumbnailUrl: available ? asset.thumbnailUrl : null,
  };
}

function visualPoolDtos(
  assetIds: readonly string[],
  role: "identity_anchor" | "identity_reference",
  assets: ReadonlyMap<string, {
    id: string;
    url: string;
    thumbnailUrl: string | null;
    deletedAt: Date | null;
    type: string;
    safetyStatus: string;
    characterId: string | null;
    metadata: Prisma.JsonValue;
  }>,
  expectedCharacterId: string,
) {
  return assetIds.map((mediaAssetId) => {
    const asset = assets.get(mediaAssetId);
    return asset ? visualAssetDto(asset, role, expectedCharacterId) : {
      mediaAssetId,
      role,
      available: false,
      url: null,
      thumbnailUrl: null,
      qualityScore: null,
      identityScore: null,
    };
  });
}

function projectDto(project: {
  id: string;
  characterId: string;
  ownerId: string | null;
  phase: string;
  audience: Prisma.JsonValue;
  hypothesis: string | null;
  differentiation: string | null;
  successCriteria: Prisma.JsonValue;
  draftImageAssetId: string | null;
  draftAssetPack: Prisma.JsonValue;
  plannedLaunchAt: Date | null;
  version: number;
  updatedAt: Date;
}, currentRouteFingerprint: string | null) {
  const audience = record(project.audience);
  const draftAssetRouteAuthority = evaluateDraftAssetRouteAuthority(
    project.draftAssetPack,
    currentRouteFingerprint,
  );
  return {
    id: project.id,
    characterId: project.characterId,
    ownerId: project.ownerId,
    phase: project.phase,
    audience: text(audience.audience),
    companionNeed: text(audience.companionNeed),
    hypothesis: project.hypothesis ?? "",
    differentiation: project.differentiation ?? "",
    targetPlacementKeys: strings(audience.targetPlacementKeys as Prisma.JsonValue | undefined),
    successCriteria: strings(project.successCriteria),
    productionPackage: text(audience.productionPackage),
    qaPlan: text(audience.qaPlan),
    draftImageAssetId: project.draftImageAssetId,
    draftAssetPackHash: canonicalSha256(project.draftAssetPack),
    draftAssetPack: characterAssetPack(project.draftAssetPack),
    draftAssetSelections: characterAssetSelections(
      project.draftAssetPack,
      currentRouteFingerprint,
    ),
    draftAssetRouteAuthority: {
      status: draftAssetRouteAuthority.status,
      currentRouteFingerprint: draftAssetRouteAuthority.currentRouteFingerprint,
      stalePurposes: draftAssetRouteAuthority.stalePurposes,
      missingPurposes: draftAssetRouteAuthority.missingPurposes,
      recoveryPurpose: draftAssetRouteAuthority.recoveryPurpose,
      qaReady: draftAssetRouteAuthority.qaReady,
      qaBlockers: draftAssetRouteAuthority.qaBlockers,
    },
    plannedLaunchAt: project.plannedLaunchAt?.toISOString() ?? null,
    version: project.version,
    updatedAt: project.updatedAt.toISOString(),
  };
}

function servingDto(serving: {
  characterId: string;
  state: string;
  currentReleaseId: string | null;
  scheduledReleaseId: string | null;
  scheduledAt: Date | null;
  version: number;
  updatedAt: Date;
} | null) {
  return serving ? {
    characterId: serving.characterId,
    state: serving.state,
    currentReleaseId: serving.currentReleaseId,
    scheduledReleaseId: serving.scheduledReleaseId,
    scheduledAt: serving.scheduledAt?.toISOString() ?? null,
    version: serving.version,
    updatedAt: serving.updatedAt.toISOString(),
  } : null;
}

function releaseDto(release: {
  id: string;
  projectId: string;
  revisionId: string;
  characterContentVersionId: string;
  visualProfileId: string | null;
  visualProfileVersion: number | null;
  referenceSetRevisionId: string | null;
  generationProvenance: Prisma.JsonValue;
  releasePlacementManifest: Prisma.JsonValue;
  snapshotHash: string;
  readiness: string;
  legacy: boolean;
  status: string;
  publishedAt: Date | null;
  supersedesId: string | null;
  rollbackOfReleaseId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...release,
    generationProvenance: record(release.generationProvenance),
    releasePlacementManifest: record(release.releasePlacementManifest),
    publishedAt: release.publishedAt?.toISOString() ?? null,
    createdAt: release.createdAt.toISOString(),
    updatedAt: release.updatedAt.toISOString(),
  };
}

function previewSnapshot(input: {
  character: { id: string; name: string; description: string; appearance: Prisma.JsonValue; advancedDetails: Prisma.JsonValue };
  content: {
    id: string;
    personaSnapshot: Prisma.JsonValue;
    openingSnapshot: Prisma.JsonValue;
    appearanceSnapshot: Prisma.JsonValue;
  } | null;
  releaseId: string | null;
  servingVersion: number | null;
  assetPack: ReturnType<typeof previewAssetPackDto>;
  label: "Live" | "Draft Preview";
}) {
  const persona = input.content ? record(input.content.personaSnapshot) : record(input.character.advancedDetails);
  const opening = input.content ? record(input.content.openingSnapshot) : {
    firstMessage: record(input.character.advancedDetails).firstMessage ?? null,
  };
  const appearance = input.content ? record(input.content.appearanceSnapshot) : record(input.character.appearance);
  const selectedAssetIds = characterPreviewAssetPurposes.flatMap((purpose) =>
    input.assetPack[purpose].assetId ? [input.assetPack[purpose].assetId] : []
  );
  const assetPackReady = characterPreviewAssetPurposes.every(
    (purpose) => input.assetPack[purpose].status === "available",
  ) && new Set(selectedAssetIds).size === characterPreviewAssetPurposes.length;
  const exactAssetPack = assetPackReady ? {
    character_cover: input.assetPack.character_cover.assetId!,
    character_hero: input.assetPack.character_hero.assetId!,
    character_chat: input.assetPack.character_chat.assetId!,
  } : null;
  const renderUrl = input.content && exactAssetPack
    ? new URL(
        `/internal-preview/characters/${encodeURIComponent(issueCharacterPreviewToken({
          characterId: input.character.id,
          contentVersionId: input.content.id,
          releaseId: input.releaseId,
          servingVersion: input.servingVersion,
          imageAssetId: exactAssetPack.character_cover,
          assetPack: exactAssetPack,
          label: input.label,
        }, env.BETTER_AUTH_SECRET))}`,
        env.BETTER_AUTH_URL,
      ).toString()
    : null;
  return {
    releaseId: input.releaseId,
    contentVersionId: input.content?.id ?? null,
    label: input.label,
    name: text(persona.name) || input.character.name,
    description: text(persona.description) || input.character.description,
    persona,
    opening,
    appearance,
    imageUrl: input.assetPack.character_cover.imageUrl,
    assetPack: input.assetPack,
    assetPackReady,
    renderUrl,
  };
}

function changedFields(
  live: ReturnType<typeof previewSnapshot> | null,
  draft: ReturnType<typeof previewSnapshot>,
) {
  if (!live) return ["new_release"];
  return (["name", "description", "persona", "opening", "appearance", "imageUrl", "assetPack"] as const)
    .filter((key) => JSON.stringify(live[key]) !== JSON.stringify(draft[key]));
}

// SPEC: 生图（打磨）闸 ≠ 发布闸。这里只保留「没有它就画不出图」的条件。
// INTENT: 密封 hash（*_unsealed）是内容的派生缓存，它的价值是发布时锁住身份，对生成一张
// 草稿图没有意义；却曾要求运营「铸一个新版本」才能继续——用改数据的手段去修一个只需重算的
// 值。发布链仍在 readiness.ts 里检查这两项，打磨阶段不再被它拦住。
const VISUAL_BLOCKER_CODES = [
  "visual_identity_missing", "visual_anchor_missing", "visual_traits_incomplete",
  "reference_set_not_active", "reference_assets_unavailable",
  "generation_route_unqualified", "generation_route_stale",
] as const;
type VisualBlockerCode = (typeof VISUAL_BLOCKER_CODES)[number];

function isVisualBlockerCode(code: string): code is VisualBlockerCode {
  return (VISUAL_BLOCKER_CODES as readonly string[]).includes(code);
}

// SPEC: blocker 的 deepLink 直达能完成该动作的控件，不是 Visual 页首。
// INTENT: 「哪类阻塞该去哪解决」是运营流程知识，属于本投影；具体落在哪个 tab、哪个 DOM id 由
// character-deep-link 一张表拥有。此前这条链接是三方拼出来的：readiness.ts 给一个 base（其中
// 路线类指向 /admin/ops/profiles 这个完全不同的页面），这里再 String.replace 修 tab、拼锚点——
// 于是「路线未合格」的链接是 /admin/ops/profiles?characterId=…#route-qualification-workbench，
// 落在 Profiles & Rollout 页上挂一个永远匹配不上的片段。现在 base 也由锚点表给。
// INVARIANT: 每个 VisualBlockerCode 都有目标锚点——漏一个是编译错误，不靠测试兜。
const VISUAL_BLOCKER_ANCHORS: Readonly<
  Record<VisualBlockerCode, CharacterWorkspaceAnchor>
> = {
  visual_identity_missing: "visual_identity_version",
  visual_anchor_missing: "visual_identity_version",
  visual_traits_incomplete: "visual_identity_version",
  reference_set_not_active: "visual_reference_set",
  reference_assets_unavailable: "visual_reference_set",
  generation_route_unqualified: "route_qualification_workbench",
  generation_route_stale: "route_qualification_workbench",
};

export function visualBlockerDeepLink(
  characterId: string,
  code: string,
): string {
  return isVisualBlockerCode(code)
    ? characterWorkspaceAnchorLink(characterId, VISUAL_BLOCKER_ANCHORS[code])
    : characterWorkspaceTabLink(characterId, "visual");
}

export async function getCharacterWorkspace(characterId: string) {
  const [character, project, serving, activeCommand, activeLooks, voiceProfiles, contentVersions] = await Promise.all([
    prisma.character.findFirst({
      where: operationalCharacterWhere({ id: characterId, deletedAt: null }),
      include: { imageAsset: true, stats: true },
    }),
    prisma.characterProject.findFirst({ where: { characterId }, orderBy: { updatedAt: "desc" } }),
    prisma.characterServing.findUnique({
      where: { characterId },
      include: {
        currentRelease: {
          select: { characterContentVersionId: true },
        },
      },
    }),
    prisma.controlPlaneCommand.findFirst({
      where: {
        coordinationKey: characterCommandCoordinationKey(characterId),
        status: { in: [...ACTIVE_CONTROL_PLANE_COMMAND_STATUSES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.characterLook.findMany({
      where: {
        characterId,
        status: { in: ["active", "needs_rebase"] },
      },
      select: {
        id: true,
        ownerId: true,
        label: true,
        status: true,
        visualProfileId: true,
        referenceAssetId: true,
        rebasedFromLookId: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    prisma.characterVoiceProfile.findMany({
      where: { characterId },
      include: {
        referenceAsset: true,
        previewAsset: true,
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: 20,
    }),
    prisma.characterContentVersion.findMany({
      where: { characterId },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: 1,
    }),
  ]);
  if (!character || !project) throw Errors.notFound("Character Project not found");
  if (!contentVersions[0]) {
    throw Errors.notFound("Character Soul content version not found");
  }
  const servingContentVersionId = serving?.currentRelease?.characterContentVersionId ?? null;
  const servingContentVersion = servingContentVersionId
    ? await prisma.characterContentVersion.findFirst({
        where: { id: servingContentVersionId, characterId },
        select: { id: true, version: true, personaSnapshot: true },
      })
    : null;
  const soul = characterSoulWorkspaceProjection(contentVersions, servingContentVersion);
  const activeVoiceProfile =
    voiceProfiles.find((profile) => profile.status === "active") ?? null;
  const candidateVoiceProfile =
    voiceProfiles.find(
      (profile) =>
        profile.status === "candidate" && profile.provider === "fish_audio",
    ) ?? null;
  const usableActiveVoiceProfile =
    activeVoiceProfile?.provider === "fish_audio" &&
    activeVoiceProfile.providerVoiceId === character.voiceId
      ? activeVoiceProfile
      : null;
  const [voiceRuntime, voiceDefaults] = await Promise.all([
    inspectConfiguredVoiceIdentityRuntime(),
    getVoiceDefaultSettings(),
  ]);
  const releases = await prisma.characterRelease.findMany({
    where: { projectId: project.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const activeIdentity = await prisma.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  const activeReferenceSet = activeIdentity ? await prisma.referenceSetRevision.findFirst({
    where: { visualProfileId: activeIdentity.id, status: "active" },
    include: { references: { include: { mediaAsset: true }, orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  }) : null;
  const bootstrapAuthority = await loadCharacterIdentityBootstrapAuthority(prisma, characterId);
  // SPEC: 可选图池 = 这个角色当前所有可用的图，判据与 publishCharacterReferenceSet 的写入
  // 校验完全一致（归属本角色 / 未删除 / 是图片 / 安全通过）。
  // INTENT: 「哪些图能当参考图」是事实不是状态，不需要 anchorAssetIds 或 ReferenceCandidate
  // 再存一份——存了反而把新生成的好图挡在外面。取最近 60 张，够运营挑；已在参考集里的图
  // 由 activeReferenceSet.references 自带，不依赖这个池。
  const visualAsOf = new Date();
  const [
    visualPoolAssets,
    videoSourceAssets,
    routeQualifications,
    qualifiedRoute,
    bootstrapProfile,
    routeEvaluationProfiles,
    identityCalibrationProfiles,
    characterImageReferenceCount,
    videoGenerationEstimate,
    mediaOperations,
  ] = await Promise.all([
    prisma.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        deletedAt: null,
        type: "image",
        safetyStatus: "passed",
        characterId,
      }),
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    prisma.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        deletedAt: null,
        type: "image",
        safetyStatus: "passed",
        characterId,
      }),
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    activeIdentity ? prisma.generationRouteQualification.findMany({
      where: { style: activeIdentity.style },
      orderBy: { evaluatedAt: "desc" },
      take: 20,
    }) : Promise.resolve([]),
    activeIdentity ? findOperationalGenerationRoute(prisma, {
      style: activeIdentity.style,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
      at: visualAsOf,
      requiredReferenceCount: activeReferenceSet?.references.length ?? 0,
      requiredReferenceRoles:
        activeReferenceSet?.references.map((reference) => reference.role) ?? [],
    }) : Promise.resolve(null),
    bootstrapAuthority.allowed ? findBootstrapGenerationProfile() : Promise.resolve(null),
    activeIdentity && activeReferenceSet
      ? findRouteEvaluationGenerationProfiles(
          activeReferenceSet.references.map((reference) => reference.role),
        )
      : Promise.resolve([]),
    findIdentityCalibrationGenerationProfiles(),
    character.imageAsset?.characterId === null
      ? prisma.character.count({ where: { imageAssetId: character.imageAsset.id } })
      : Promise.resolve(0),
    loadCharacterVideoGenerationEstimate(),
    loadCharacterMediaOperationsProjection(characterId),
  ]);
  const projectedRouteQualifications = qualifiedRoute &&
      !routeQualifications.some((qualification) => qualification.id === qualifiedRoute.id)
    ? [qualifiedRoute, ...routeQualifications]
    : routeQualifications;
  const qualificationProfileKey = (profileKey: string, version: number) =>
    `${profileKey}\u0000${version}`;
  const [workflowEntries, routeProfiles] = await Promise.all([
    Promise.all([...new Set(projectedRouteQualifications.map((qualification) => qualification.workflowKey))]
      .map(async (workflowKey) => {
        const descriptor = await generationWorkflowDescriptor(workflowKey);
        return [workflowKey, descriptor] as const;
      })),
    projectedRouteQualifications.length > 0
      ? prisma.generationModelProfile.findMany({
          where: {
            OR: projectedRouteQualifications.map((qualification) => ({
              profileKey: qualification.generationProfileKey,
              version: qualification.generationProfileVersion,
            })),
          },
          select: {
            profileKey: true,
            version: true,
            runnerConfig: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const workflowByKey = new Map(workflowEntries);
  const routeProfileByKey = new Map(routeProfiles.map((profile) => [
    qualificationProfileKey(profile.profileKey, profile.version),
    profile,
  ]));
  const releaseIds = releases.map((release) => release.id);
  const validationRuns = await prisma.releaseValidationRun.findMany({
    where: { releaseId: { in: releaseIds } },
    orderBy: { startedAt: "desc" },
  });
  const latestValidationIds = Array.from(new Set(releaseIds.flatMap((releaseId) => {
    const latest = validationRuns.find((run) => run.releaseId === releaseId);
    return latest ? [latest.id] : [];
  })));
  const draftPreviewAssetPackIds = characterAssetPack(project.draftAssetPack);
  const previewAssetIds = [...new Set([
    ...Object.values(draftPreviewAssetPackIds),
    ...releases.flatMap((release) => Object.values(releasePreviewAssetPackIds(release))),
  ])];
  const [checks, monitors, contents, qaRuns, releaseImageAssets] = await Promise.all([
    prisma.releaseCheckResult.findMany({ where: { validationRunId: { in: latestValidationIds } } }),
    prisma.releaseMonitor.findMany({ where: { releaseId: { in: releaseIds } }, orderBy: { startedAt: "desc" } }),
    prisma.characterContentVersion.findMany({
      where: { characterId },
      orderBy: { version: "desc" },
    }),
    prisma.characterQaRun.findMany({
      where: { characterId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    prisma.mediaAsset.findMany({ where: { id: { in: previewAssetIds } } }),
  ]);
  const characterImageAvailable = character.imageAsset !== null &&
    character.imageAsset.deletedAt === null &&
    character.imageAsset.type === "image" &&
    character.imageAsset.safetyStatus === "passed" &&
    isMediaAssetOperationalForAuthority(character.imageAsset.metadata) &&
    (
      character.imageAsset.characterId === characterId ||
      (character.imageAsset.characterId === null && characterImageReferenceCount === 1)
    );
  const characterImageGenerationSource = character.imageAsset
    ? await inspectCharacterImageGenerationSource(character.imageAsset)
    : null;
  const imageUrl = characterImageAvailable
    ? character.imageAsset?.thumbnailUrl ?? character.imageAsset?.url ?? null
    : null;
  const previewAssetById = new Map(releaseImageAssets.map((asset) => [asset.id, asset]));
  const currentRelease = serving?.state === "live"
    ? releases.find((release) => release.id === serving.currentReleaseId) ?? null
    : null;
  const candidateRelease = releases.find((release) => !["published", "superseded", "withdrawn"].includes(release.status)) ?? null;
  const liveContent = contents.find((content) => content.id === currentRelease?.characterContentVersionId) ?? null;
  const draftContent = contents.find((content) => content.id === candidateRelease?.characterContentVersionId) ?? contents[0] ?? null;
  const live = currentRelease ? previewSnapshot({
    character,
    content: liveContent,
    releaseId: currentRelease.id,
    servingVersion: serving?.version ?? null,
    assetPack: previewAssetPackDto(
      releasePreviewAssetPackIds(currentRelease),
      previewAssetById,
      characterId,
    ),
    label: "Live",
  }) : null;
  const draft = previewSnapshot({
    character,
    content: draftContent,
    releaseId: candidateRelease?.id ?? null,
    servingVersion: null,
    assetPack: previewAssetPackDto(
      draftPreviewAssetPackIds,
      previewAssetById,
      characterId,
    ),
    label: "Draft Preview",
  });
  const portfolio = await listCharacterPortfolioData(prisma, {
    limit: 1,
    search: characterId,
    sort: "project_id_asc",
  }, { authorizedDraftAssetCharacterIds: [characterId] });
  const performance = portfolio.items.find((item) => item.characterId === characterId)?.performance ?? [];
  const portfolioItem = portfolio.items.find((item) => item.characterId === characterId) ?? null;
  if (!portfolioItem) {
    throw new Error(`Character production journey missing for ${characterId}`);
  }
  const poolAssetById = new Map(visualPoolAssets.map((asset) => [asset.id, asset]));
  // visual.anchors 承载的是**可选图池**（前端 referenceCandidates = anchors ∪ references）。
  // 现在池 = 角色当前所有可用图，运营因此能把任何一张审核通过的新图选进参考集——
  // 这正是原先被 anchorAssetIds 挡住的事。已在参考集里的图由 references 提供，两者去重后展示。
  const anchors = activeIdentity
    ? visualPoolDtos(
        visualPoolAssets.map((asset) => asset.id),
        "identity_anchor",
        poolAssetById,
        characterId,
      )
    : [];
  const references = activeReferenceSet
    ? activeReferenceSet.references.map((reference) =>
        visualAssetDto(reference.mediaAsset, reference.role, characterId, reference)
      )
    : [];
  const visualReadiness = evaluateReleaseReadiness({
    snapshotHash: "visual-workbench",
    currentSnapshotHash: "visual-workbench",
    validatedPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    currentPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    content: { personaComplete: true, openingComplete: true },
    visualIdentity: activeIdentity ? {
      version: activeIdentity.version,
      anchorCount: anchors.filter((asset) => asset.available).length,
      requiredTraitsPresent: [
        activeIdentity.faceTraits,
        activeIdentity.hairTraits,
        activeIdentity.bodyTraits,
        activeIdentity.signatureTraits,
      ].some((traits) => Object.keys(jsonObject(traits)).length > 0),
      snapshotSealed: activeIdentity.immutableHash !== null
        && activeIdentity.immutableHash === characterVisualProfileSnapshotHash(activeIdentity),
    } : null,
    referenceSet: activeReferenceSet ? {
      revision: activeReferenceSet.revision,
      status: activeReferenceSet.status,
      snapshotSealed: activeReferenceSet.snapshotHash !== null
        && activeReferenceSet.snapshotHash === referenceSetSnapshotHash(activeReferenceSet),
      availableReferenceCount: activeReferenceSet.references.length > 0 &&
        activeReferenceSet.references.every((item) => visualAssetAvailable(item.mediaAsset, characterId))
          ? activeReferenceSet.references.length
          : 0,
    } : null,
    routeQualification: qualifiedRoute ? { status: qualifiedRoute.result, stale: false } : null,
    characterQa: { status: "passed" },
  });
  // SPEC: 生图（打磨）闸 ≠ 发布闸。这里只保留「没有它就画不出图」的条件。
  // INTENT: 密封 hash（*_unsealed）是内容的派生缓存，它的价值是发布时锁住身份，对生成一张
  // 草稿图没有意义；却曾要求运营「铸一个新版本」才能继续——用改数据的手段去修一个只需重算的
  // 值。发布链仍在 readiness.ts 里检查这两项，打磨阶段不再被它拦住。
  const visualBlockers = visualReadiness.blockers.filter((blocker) =>
    isVisualBlockerCode(blocker.code)
  );
  const currentReleaseForImageReadiness = serving?.currentReleaseId
    ? releases.find((release) => release.id === serving.currentReleaseId) ?? null
    : null;
  const imageReadinessFingerprint = characterImageReadinessFingerprint({
    characterId: character.id,
    characterImageAssetId: character.imageAssetId,
    sourceAsset: characterImageGenerationSource?.authority ?? null,
    projectId: project.id,
    projectVersion: project.version,
    draftImageAssetId: project.draftImageAssetId,
    draftAssetPack: project.draftAssetPack,
    serving: serving ? {
      currentReleaseId: serving.currentReleaseId,
      scheduledReleaseId: serving.scheduledReleaseId,
      version: serving.version,
    } : null,
    currentRelease: currentReleaseForImageReadiness ? {
      id: currentReleaseForImageReadiness.id,
      version: currentReleaseForImageReadiness.version,
      snapshotHash: currentReleaseForImageReadiness.snapshotHash,
    } : null,
    activeIdentity: activeIdentity ? {
      id: activeIdentity.id,
      version: activeIdentity.version,
      immutableHash: activeIdentity.immutableHash,
    } : null,
    activeReferenceSet: activeReferenceSet ? {
      id: activeReferenceSet.id,
      revision: activeReferenceSet.revision,
      snapshotHash: activeReferenceSet.snapshotHash,
    } : null,
  });
  const hasDraftAssetWork =
    project.draftImageAssetId !== null ||
    Object.keys(characterAssetPack(project.draftAssetPack)).length > 0;
  const hasCandidateRelease = releases.some((release) =>
    ["draft", "validating", "in_review", "approved"].includes(release.status)
  );
  const identityBlockerCodes = new Set([
    "visual_identity_missing",
    "visual_anchor_missing",
    "visual_traits_incomplete",
  ]);
  const referenceBlockerCodes = new Set([
    "reference_set_not_active",
    "reference_assets_unavailable",
  ]);
  const routeBlockerCodes = new Set([
    "generation_route_unqualified",
    "generation_route_stale",
  ]);
  const identityBlocked = visualBlockers.some((blocker) =>
    identityBlockerCodes.has(blocker.code)
  );
  const referencesBlocked = visualBlockers.some((blocker) =>
    referenceBlockerCodes.has(blocker.code)
  );
  const routeBlocked = visualBlockers.some((blocker) =>
    routeBlockerCodes.has(blocker.code)
  );
  const automaticLivePortraitRepairEligible = Boolean(
    characterImageAvailable &&
    character.imageAssetId &&
    serving?.state === "live" &&
    currentReleaseForImageReadiness?.legacy === true &&
    currentReleaseForImageReadiness.status === "published" &&
    serving?.currentReleaseId === currentReleaseForImageReadiness.id &&
    serving.scheduledReleaseId === null &&
    !hasDraftAssetWork &&
    !hasCandidateRelease &&
    activeIdentity === null &&
    activeReferenceSet === null &&
    activeLooks.length === 0 &&
    characterImageGenerationSource?.materializable === true
  );
  const editorialAuthority =
    automaticLivePortraitRepairEligible &&
      currentReleaseForImageReadiness &&
      character.imageAssetId
      ? await evaluateEditorialReleaseAuthority(prisma, {
          releaseId: currentReleaseForImageReadiness.id,
          projectionState: "live",
        })
      : null;
  const canAdoptLivePortrait = Boolean(
    automaticLivePortraitRepairEligible &&
    editorialAuthority?.valid === true &&
    editorialAuthority.characterId === characterId &&
    editorialAuthority.assetId === character.imageAssetId,
  );
  const imageReadinessState =
    visualBlockers.length === 0
      ? "ready" as const
      : bootstrapAuthority.allowed
        ? "bootstrap_required" as const
        : !identityBlocked && !referencesBlocked && routeBlocked
          ? "route_pending" as const
          : canAdoptLivePortrait
            ? "repairable" as const
            : "manual_review_required" as const;
  return {
    character: {
      id: character.id,
      name: character.name,
      age: character.age,
      description: character.description,
      gender: character.gender,
      style: character.style,
      visibility: character.visibility,
      legacyStatus: character.status,
      imageUrl,
      updatedAt: character.updatedAt.toISOString(),
    },
    project: projectDto(project, qualifiedRoute?.routeFingerprint ?? null),
    soul,
    journey: portfolioItem.journey,
    mediaOperations,
    visual: {
      activeIdentity: activeIdentity ? {
        id: activeIdentity.id,
        version: activeIdentity.version,
        status: activeIdentity.status,
        style: activeIdentity.style,
        identityPrompt: activeIdentity.identityPrompt,
        negativeIdentityPrompt: activeIdentity.negativeIdentityPrompt,
        traits: {
          face: jsonObject(activeIdentity.faceTraits),
          hair: jsonObject(activeIdentity.hairTraits),
          body: jsonObject(activeIdentity.bodyTraits),
          signature: jsonObject(activeIdentity.signatureTraits),
          style: jsonObject(activeIdentity.styleTraits),
        },
        immutableHash: activeIdentity.immutableHash,
        evidenceState: activeIdentity.evidenceState,
        defaultSeed: activeIdentity.defaultSeed,
        anchorAssetIds: strings(activeIdentity.anchorAssetIds),
        createdFrom: activeIdentity.createdFrom,
        createdAt: activeIdentity.createdAt.toISOString(),
      } : null,
      anchors,
      references,
      videoSources: videoSourceAssets.map((asset) =>
        videoSourceAssetDto(asset, characterId)
      ),
      videoGenerationEstimate,
      activeReferenceSet: activeReferenceSet ? {
        id: activeReferenceSet.id,
        revision: activeReferenceSet.revision,
        status: activeReferenceSet.status,
        selectorVersion: activeReferenceSet.selectorVersion,
        snapshotHash: activeReferenceSet.snapshotHash,
        createdFrom: activeReferenceSet.createdFrom,
        createdAt: activeReferenceSet.createdAt.toISOString(),
        references: activeReferenceSet.references.map((item) => visualAssetDto(item.mediaAsset, item.role, characterId, item)),
      } : null,
      looks: activeLooks.map((look) => ({
        ...look,
        status: look.status === "needs_rebase" ? "needs_rebase" as const : "active" as const,
        updatedAt: look.updatedAt.toISOString(),
      })),
      routeQualifications: projectedRouteQualifications.map((qualification) => {
        const workflow = workflowByKey.get(qualification.workflowKey) ?? null;
        const routeProfile = routeProfileByKey.get(qualificationProfileKey(
          qualification.generationProfileKey,
          qualification.generationProfileVersion,
        ));
        const profileCapabilities = record(
          record(routeProfile?.runnerConfig).capabilities as Prisma.JsonValue | undefined,
        );
        return {
          id: qualification.id,
          routeFingerprint: qualification.routeFingerprint,
          generationProfileKey: qualification.generationProfileKey,
          generationProfileVersion: qualification.generationProfileVersion,
          workflowKey: qualification.workflowKey,
          workflowVersion: qualification.workflowVersion,
          style: qualification.style,
          matrixKey: qualification.matrixKey,
          sampleCount: qualification.sampleCount,
          passCount: qualification.passCount,
          identityMatch: qualification.identityMatch,
          result: qualification.result,
          evidence: record(qualification.evidence),
          policyVersion: qualification.policyVersion,
          evaluatedAt: qualification.evaluatedAt.toISOString(),
          expiresAt: qualification.expiresAt?.toISOString() ?? null,
          stale: qualification.result === "qualified" && qualification.id !== qualifiedRoute?.id,
          identityContract: workflow
            ? {
                maxReferences: workflow.identity.maxReferences,
                acceptedRoles: workflow.identity.acceptedRoles,
                supportsLookReference:
                  workflow.identity.supportsLookReference,
                supportsSourceImageWithIdentity:
                  workflow.identity.supportsSourceImageWithIdentity,
              }
            : undefined,
          profileCapabilities: routeProfile
            ? {
                referenceImages: profileCapabilities.referenceImages === true,
                initImage: profileCapabilities.initImage === true,
              }
            : undefined,
          sourceVariationAuthority: generationSourceVariationAuthority({
            routeFingerprint: qualification.routeFingerprint,
            routeQualified: qualification.id === qualifiedRoute?.id,
            workflow,
            qualificationWorkflowVersion: qualification.workflowVersion,
            profileCapabilities,
            canonicalReferenceRoles:
              activeReferenceSet?.references.map((reference) => reference.role) ?? [],
            sourceReferenceCount: 1,
          }),
        };
      }),
      routeEvaluation: {
        ready: routeEvaluationProfiles.length > 0,
        blocker: !activeIdentity
          ? "Create and seal a Visual Identity before evaluating an image route."
          : !activeReferenceSet || activeReferenceSet.references.length === 0
            ? "Publish a sealed Reference Set before evaluating an image route."
            : routeEvaluationProfiles.length === 0
              ? "No active reference-capable image profile can consume this Reference Set."
              : null,
        sampleMinimum: 40,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        profiles: routeEvaluationProfiles,
      },
      identityCalibration: {
        profiles: identityCalibrationProfiles,
        blocker: identityCalibrationProfiles.length === 0
          ? "No active image route supports identity calibration."
          : null,
      },
      identityBootstrap: {
        state: bootstrapAuthority.state,
        allowed: bootstrapAuthority.allowed,
        nextIdentityVersion: bootstrapAuthority.nextVersion,
        blockers: bootstrapAuthority.blockers,
        profile: bootstrapProfile,
      },
      imageReadiness: {
        state: imageReadinessState,
        fingerprint: imageReadinessFingerprint,
        steps: {
          identity: identityBlocked
            ? canAdoptLivePortrait ? "action_required" : "blocked"
            : "complete",
          references: referencesBlocked
            ? canAdoptLivePortrait ? "action_required" : "blocked"
            : "complete",
          route: routeBlocked ? "platform_pending" : "complete",
        },
        repair: canAdoptLivePortrait && character.imageAssetId
          ? {
              kind: "adopt_live_portrait",
              sourceAssetId: character.imageAssetId,
            }
          : null,
        nextDeepLink: imageReadinessState === "route_pending"
          ? characterWorkspaceAnchorLink(
              characterId,
              "route_qualification_workbench",
            )
          : characterWorkspaceTabLink(characterId, "assets"),
      },
      readiness: {
        ready: visualBlockers.length === 0,
        qualificationPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        blockers: visualBlockers.map((blocker) => ({
          ...blocker,
          deepLink: visualBlockerDeepLink(characterId, blocker.code),
        })),
        productionDeepLink: characterWorkspaceTabLink(characterId, "assets"),
      },
    },
    voice: {
      ...voiceRuntime,
      currentVoiceId: character.voiceId,
      effectiveVoiceId:
        usableActiveVoiceProfile?.providerVoiceId ??
        voiceIdForGender(voiceDefaults, character.gender),
      authoritySource: usableActiveVoiceProfile
        ? "character_clone"
        : "system_default",
      systemDefaults: voiceDefaults,
      activeProfile: usableActiveVoiceProfile
        ? characterVoiceProfileDto(usableActiveVoiceProfile)
        : null,
      candidateProfile: candidateVoiceProfile
        ? characterVoiceProfileDto(candidateVoiceProfile)
        : null,
      history: voiceProfiles.map(characterVoiceProfileDto),
    },
    serving: servingDto(serving),
    activeCommand: activeCommand ? adminCommandStatusSchema.parse({
      commandId: activeCommand.id,
      requestId: activeCommand.requestId,
      commandType: activeCommand.commandType,
      target: { type: activeCommand.targetType, id: activeCommand.targetId },
      status: activeCommand.status,
      verificationState: activeCommand.status === "verifying" ? "verifying" : "pending",
      needsReconciliation: activeCommand.needsReconciliation,
      createdAt: activeCommand.createdAt.toISOString(),
      updatedAt: activeCommand.updatedAt.toISOString(),
    }) : null,
    releases: releases.map((release) => {
      const validation = validationRuns.find((run) => run.releaseId === release.id);
      return {
        release: releaseDto(release),
        checks: validation ? checks.filter((check) => check.validationRunId === validation.id).map((check) => ({
          checkKey: check.checkKey,
          result: check.result,
          evidence: record(check.evidence),
          checkedAt: check.checkedAt.toISOString(),
        })) : [],
        monitors: monitors.filter((monitor) => monitor.releaseId === release.id).map((monitor) => ({
          id: monitor.id,
          window: monitor.window,
          status: monitor.status,
          baseline: record(monitor.baseline),
          observed: record(monitor.observed),
          verification: record(monitor.verification),
          startedAt: monitor.startedAt.toISOString(),
          finishedAt: monitor.finishedAt?.toISOString() ?? null,
        })),
      };
    }),
    qaRuns: qaRuns.map((run) => characterQaRunSchema.parse({
      ...run,
      checks: run.checks,
      createdAt: run.createdAt.toISOString(),
    })),
    preview: { live, draft, changedFields: changedFields(live, draft) },
    performance,
    portfolio: {
      latestDecision: portfolioItem?.latestDecision ?? null,
      changeMarkers: portfolioItem?.changeMarkers ?? [],
    },
  };
}

export async function getCharacterProjectDraftForResume(characterId: string) {
  const [character, project, content, visualAuthority] = await Promise.all([
    prisma.character.findFirst({
      where: operationalCharacterWhere({ id: characterId, deletedAt: null }),
    }),
    prisma.characterProject.findFirst({ where: { characterId }, orderBy: { updatedAt: "desc" } }),
    prisma.characterContentVersion.findFirst({ where: { characterId }, orderBy: { version: "desc" } }),
    prisma.characterVisualProfile.findFirst({
      where: { characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: {
        style: true,
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            references: {
              orderBy: { position: "asc" },
              select: { role: true },
            },
          },
        },
      },
    }),
  ]);
  if (!character || !project || !content) throw Errors.notFound("Character Project draft not found");
  const activeReferences =
    visualAuthority?.referenceSetRevisions[0]?.references ?? [];
  const qualifiedRoute = visualAuthority
    ? await findOperationalGenerationRoute(prisma, {
        style: visualAuthority.style,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: activeReferences.length,
        requiredReferenceRoles:
          activeReferences.map((reference) => reference.role),
      })
    : null;
  const projectView = projectDto(project, qualifiedRoute?.routeFingerprint ?? null);
  const persona = record(content.personaSnapshot);
  const loadedSoul = loadCharacterSoulSnapshot(content.personaSnapshot);
  const soul = loadedSoul.ok ? loadedSoul.snapshot.soul : null;
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  return characterProjectDraftResumeSchema.parse({
    authority: {
      characterId,
      projectId: project.id,
      projectVersion: project.version,
      deepLink: characterWorkspaceLink(characterId),
    },
    draft: {
      positioning: {
        audience: projectView.audience,
        companionNeed: projectView.companionNeed,
        hypothesis: projectView.hypothesis,
        differentiation: projectView.differentiation,
      },
      persona: {
        name: soul?.identity.name || text(persona.name) || character.name,
        age: soul?.identity.age ?? (typeof persona.age === "number" ? persona.age : character.age),
        gender: soul?.identity.gender || text(persona.gender) || character.gender,
        relationshipArchetype: soul?.identity.relationshipArchetype || text(persona.relationshipArchetype) || character.relationship,
        characterPromise: soul?.identity.characterPromise || text(persona.characterPromise) || character.description,
        personality: soul?.innerLife.personality ?? text(persona.personality),
        values: soul?.innerLife.values,
        wants: soul?.innerLife.wants,
        fears: soul?.innerLife.fears,
        contradictions: soul?.innerLife.contradictions,
        tone: soul?.voice.tone ?? text(persona.tone),
        cadence: soul?.voice.cadence,
        vocabulary: soul?.voice.vocabulary,
        voiceHabits: soul?.voice.habits,
        voiceAvoid: soul?.voice.avoid,
        backstory: soul?.innerLife.backstory ?? text(persona.backstory),
        firstMessage: text(opening.firstMessage),
        exampleDialogue: soul
          ? soul.dialogue.positive.map((example) => example.assistant)
          : strings(persona.exampleDialogue as Prisma.JsonValue | undefined),
        interaction: soul?.interaction,
        canon: soul?.canon,
        negativeDialogue: soul?.dialogue.negative,
      },
      visualDirection: {
        identityAnchor: text(appearance.identityAnchor),
        stableTraits: strings(appearance.stableTraits as Prisma.JsonValue | undefined),
        style: text(appearance.style) || character.style,
        referenceDirection: text(appearance.referenceDirection),
      },
      commercialIntent: {
        ownerId: projectView.ownerId,
        plannedLaunchAt: projectView.plannedLaunchAt,
        targetPlacementKeys: projectView.targetPlacementKeys,
        successCriteria: projectView.successCriteria,
        productionPackage: projectView.productionPackage,
        qaPlan: projectView.qaPlan,
      },
    },
  });
}

export async function updateCharacterProjectDraft(input: {
  readonly characterId: string;
  readonly expectedVersion: number;
  readonly actor: AdminActor;
  readonly ownerId: string | null;
  readonly audience: string;
  readonly companionNeed: string;
  readonly hypothesis: string;
  readonly differentiation: string;
  readonly targetPlacementKeys: readonly string[];
  readonly successCriteria: readonly string[];
  readonly productionPackage: string;
  readonly qaPlan: string;
  readonly plannedLaunchAt: string | null;
  readonly content?: {
    readonly persona: CharacterDraftPersona;
    readonly visualDirection: CharacterDraftVisualDirection;
  };
  readonly reason: string;
  readonly requestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    const character = await tx.character.findFirst({
      where: operationalCharacterWhere({
        id: input.characterId,
        deletedAt: null,
      }),
      select: { id: true },
    });
    if (!character) throw Errors.notFound("Character Project not found");
    const project = await tx.characterProject.findFirst({ where: { characterId: input.characterId } });
    if (!project) throw Errors.notFound("Character Project not found");
    const visualAuthority = await tx.characterVisualProfile.findFirst({
      where: { characterId: input.characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: {
        style: true,
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            references: {
              orderBy: { position: "asc" },
              select: { role: true },
            },
          },
        },
      },
    });
    const activeReferences =
      visualAuthority?.referenceSetRevisions[0]?.references ?? [];
    const qualifiedRoute = visualAuthority
      ? await findOperationalGenerationRoute(tx, {
          style: visualAuthority.style,
          policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          at: new Date(),
          requiredReferenceCount: activeReferences.length,
          requiredReferenceRoles:
            activeReferences.map((reference) => reference.role),
        })
      : null;
    const currentRouteFingerprint = qualifiedRoute?.routeFingerprint ?? null;
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: input.expectedVersion },
      data: {
        ownerId: input.ownerId,
        audience: toInputJson({
          audience: input.audience,
          companionNeed: input.companionNeed,
          targetPlacementKeys: input.targetPlacementKeys,
          productionPackage: input.productionPackage,
          qaPlan: input.qaPlan,
        }),
        hypothesis: input.hypothesis,
        differentiation: input.differentiation,
        successCriteria: toInputJson(input.successCriteria),
        plannedLaunchAt: input.plannedLaunchAt ? new Date(input.plannedLaunchAt) : null,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      const current = await tx.characterProject.findUniqueOrThrow({ where: { id: project.id } });
      throw Errors.conflict("Character Project changed in another session", {
        currentVersion: current.version,
        current: projectDto(current, currentRouteFingerprint),
      });
    }
    const updated = await tx.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    let contentVersion: { id: string; version: number; contentHash: string } | null = null;
    let revision: { id: string; revision: number } | null = null;
    if (input.content) {
      const snapshots = characterDraftSnapshots(input.content);
      const latestContent = await tx.characterContentVersion.findFirst({
        where: { characterId: input.characterId },
        orderBy: { version: "desc" },
      });
      if (!latestContent || latestContent.contentHash !== snapshots.contentHash) {
        const latestRevision = await tx.characterRevision.findFirst({
          where: { projectId: project.id },
          orderBy: { revision: "desc" },
        });
        const createdContent = await tx.characterContentVersion.create({
          data: {
            characterId: input.characterId,
            version: (latestContent?.version ?? 0) + 1,
            contentHash: snapshots.contentHash,
            personaSnapshot: toInputJson(snapshots.personaSnapshot),
            openingSnapshot: toInputJson(snapshots.openingSnapshot),
            appearanceSnapshot: toInputJson(snapshots.appearanceSnapshot),
            sourceType: "admin_character_project_autosave",
            sourceId: project.id,
            createdById: input.actor.id,
          },
        });
        const createdRevision = await tx.characterRevision.create({
          data: {
            projectId: project.id,
            revision: (latestRevision?.revision ?? 0) + 1,
            characterContentVersionId: createdContent.id,
            projectSnapshot: toInputJson({
              project: projectDto(updated, currentRouteFingerprint),
              contentHash: snapshots.contentHash,
            }),
            createdById: input.actor.id,
          },
        });
        contentVersion = {
          id: createdContent.id,
          version: createdContent.version,
          contentHash: createdContent.contentHash,
        };
        revision = { id: createdRevision.id, revision: createdRevision.revision };
      } else {
        contentVersion = {
          id: latestContent.id,
          version: latestContent.version,
          contentHash: latestContent.contentHash,
        };
      }
    }
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.project.draft_saved",
        targetType: "character_project",
        targetId: project.id,
        reason: input.reason,
        before: toInputJson(projectDto(project, currentRouteFingerprint)),
        after: toInputJson({
          project: projectDto(updated, currentRouteFingerprint),
          contentVersion,
          revision,
        }),
        requestId: input.requestId,
      },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "draft_saved",
        actorId: input.actor.id,
        body: "Saved Character Project draft",
        metadata: toInputJson({ projectVersion: updated.version, contentVersion, revision }),
        idempotencyKey: `character_project_draft_saved:${input.requestId}`,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.project.draft_saved.v2",
        aggregateType: "character_project",
        aggregateId: project.id,
        payload: toInputJson({
          projectId: project.id,
          characterId: input.characterId,
          version: updated.version,
          contentVersion,
          revision,
          occurredAt: updated.updatedAt.toISOString(),
        }),
      },
    });
    return projectDto(updated, currentRouteFingerprint);
  });
}

export async function refreshCharacterReleaseMonitor(input: {
  readonly characterId: string;
  readonly releaseId: string;
  readonly expectedVersion: number;
  readonly window: "24h" | "72h";
  readonly actor?: { readonly id: string; readonly role: string };
  readonly requestId?: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
  const character = await tx.character.findFirst({
    where: operationalCharacterWhere({
      id: input.characterId,
      deletedAt: null,
    }),
    select: { id: true },
  });
  const project = await tx.characterProject.findFirst({
    where: { characterId: input.characterId },
  });
  const release = await tx.characterRelease.findUnique({
    where: { id: input.releaseId },
  });
  if (!character || !project || !release || release.projectId !== project.id) {
    throw Errors.notFound("Character Release not found");
  }
  if (release.version !== input.expectedVersion) {
    throw Errors.conflict("Character Release changed before monitor refresh", {
      currentVersion: release.version,
    });
  }
  const result = await collectReleaseMonitorFacts(tx, {
    releaseId: release.id,
    window: input.window,
  });
  const response = {
    releaseId: release.id,
    window: input.window,
    status: result.monitor.status,
    mature: result.mature,
    recommendation: result.recommendation,
    observed: result.observed,
  };
  await tx.adminAuditLog.create({ data: {
    actorId: input.actor?.id ?? "system",
    actorRole: input.actor?.role ?? "system",
    action: "character.release.monitor.refreshed",
    targetType: "character_release",
    targetId: release.id,
    reason: `Refresh ${input.window} release monitor`,
    after: toInputJson(response),
    requestId: input.requestId,
  } });
  await tx.mainOutboxEvent.create({ data: {
    eventType: "character.release.monitor.refreshed.v2",
    aggregateType: "character_release",
    aggregateId: release.id,
    payload: toInputJson(response),
  } });
  return response;
  };
  return inTransaction(db, execute);
}
