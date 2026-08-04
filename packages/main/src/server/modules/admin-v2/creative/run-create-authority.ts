import type { Prisma } from "@prisma/client";
import { characterVideoProductionRecipe } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/lib/request-json";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { characterReferenceAuthorityFrom } from "@/server/modules/admin-v2/characters/reference-authority";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
import type { CreativeRunCreateInput } from "./run-create";

export async function resolveProductionProfile(
  profileId: string,
  version?: number,
  mode: "image" | "video" = "image",
) {
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      mode,
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
      version,
      OR: [{ id: profileId }, { profileKey: profileId }],
    },
    orderBy: { version: "desc" },
  });
  if (!profile) {
    throw Errors.badRequest(
      `Production Studio requires an active ${mode} profile`,
    );
  }
  if (mode === "video" && !isProductionLtxVideoProfile(profile)) {
    throw Errors.conflict(
      "Production Studio only accepts the exact pinned Character video profile",
      { profileId, version: version ?? null },
    );
  }
  return profile;
}

export async function resolveProductionRecipe(
  recipeId: string | undefined,
  targetType: string,
  version?: number,
  mode: "image" | "video" = "image",
) {
  const useCase = targetType === "character" ? "character" : "freeplay";
  const recipe = await prisma.generationRecipe.findFirst({
    where: recipeId
      ? {
          mode,
          status: "active",
          version,
          OR: [{ id: recipeId }, { recipeKey: recipeId }],
        }
      : {
          mode,
          status: "active",
          useCase,
        },
    orderBy: { version: "desc" },
  });
  if (!recipe) {
    throw Errors.badRequest(
      `Production Studio requires an active ${mode} prompt recipe`,
    );
  }
  return recipe;
}

export async function resolveProductionTarget(targetType: string, targetId?: string) {
  if (targetType === "none" || !targetId) return null;
  if (targetType === "character") {
    const [character, content] = await Promise.all([
      prisma.character.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          name: true,
          age: true,
          gender: true,
          style: true,
          description: true,
        },
      }),
      prisma.characterContentVersion.findFirst({
        where: { characterId: targetId },
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          personaSnapshot: true,
          appearanceSnapshot: true,
        },
      }),
    ]);
    if (!character) throw Errors.badRequest("Target character not found");
    const persona = jsonRecord(content?.personaSnapshot);
    const appearance = jsonRecord(content?.appearanceSnapshot);
    const name = stringFromRecord(persona, "name") ?? character.name;
    const age = numberFromRecord(persona, "age") ?? character.age;
    const gender = stringFromRecord(persona, "gender") ?? character.gender;
    const style = stringFromRecord(appearance, "style") ?? character.style;
    const description =
      stringFromRecord(persona, "characterPromise") ??
      stringFromRecord(persona, "description") ??
      character.description;
    const identityTraits = [
      stringFromRecord(appearance, "identityAnchor"),
      ...jsonStringArray(appearance.stableTraits),
    ].filter((value): value is string => Boolean(value));
    return {
      type: "character",
      id: character.id,
      label: name,
      detail: `${age}, ${gender}, ${style}. ${description}`,
      visualIdentity: {
        age,
        gender,
        style,
        traits: identityTraits,
        artDirection:
          stringFromRecord(appearance, "referenceDirection") ?? null,
      },
      contentVersionId: content?.id ?? null,
      contentVersion: content?.version ?? null,
    };
  }
  if (targetType === "template") {
    const template = await prisma.characterTemplate.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, summary: true, gender: true, style: true },
    });
    if (!template) throw Errors.badRequest("Target template not found");
    return {
      type: "template",
      id: template.id,
      label: template.name,
      detail: [template.summary, template.gender, template.style].filter(Boolean).join(", "),
      visualIdentity: null,
    };
  }
  return {
    type: targetType,
    id: targetId,
    label: targetId,
    detail: "",
    visualIdentity: null,
  };
}

export async function resolveProductionVisualProfile(
  db: Pick<Prisma.TransactionClient, "characterVisualProfile">,
  targetType: string,
  targetId?: string,
) {
  if (targetType !== "character" || !targetId) return null;
  return db.characterVisualProfile.findFirst({
    where: { characterId: targetId, status: "active" },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      style: true,
      identityPrompt: true,
      negativeIdentityPrompt: true,
      faceTraits: true,
      hairTraits: true,
      bodyTraits: true,
      signatureTraits: true,
      styleTraits: true,
      defaultSeed: true,
      anchorAssetIds: true,
      immutableHash: true,
      evidenceState: true,
      // 运营生图的 payload 锚点要和付费主链路同口径：由 active Reference Set 的 role 现算。
      referenceSetRevisions: {
        where: { status: "active" },
        orderBy: { revision: "desc" },
        take: 1,
        select: {
          id: true,
          revision: true,
          references: {
            orderBy: { position: "asc" },
            select: { mediaAssetId: true, role: true },
          },
        },
      },
    },
  });
}

export async function resolveProductionReferenceSet(
  db: Pick<Prisma.TransactionClient, "referenceSetRevision">,
  visualProfileId: string,
) {
  return db.referenceSetRevision.findFirst({
    where: { visualProfileId, status: "active" },
    include: {
      references: {
        include: { mediaAsset: true },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { revision: "desc" },
  });
}

export async function resolveProductionBootstrapAuthority(
  db: Pick<Prisma.TransactionClient, "characterProject" | "characterContentVersion">,
  characterId: string,
  brief: string | null,
) {
  const [project, content] = await Promise.all([
    db.characterProject.findFirst({
      where: { characterId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, version: true, phase: true },
    }),
    db.characterContentVersion.findFirst({
      where: { characterId },
      orderBy: { version: "desc" },
      select: { id: true, appearanceSnapshot: true },
    }),
  ]);
  if (!project || !content || !["idea", "planned", "producing"].includes(project.phase)) return null;
  return {
    projectId: project.id,
    projectVersion: project.version,
    characterContentVersionId: content.id,
    visualBriefHash: canonicalSha256({
      characterContentVersionId: content.id,
      appearanceSnapshot: content.appearanceSnapshot,
      brief,
    }),
  };
}

export function generationProfileCapabilities(value: Prisma.JsonValue | null) {
  const capabilities = jsonRecord(jsonRecord(value).capabilities);
  return {
    textToImage: capabilities.textToImage === true,
    referenceImages: capabilities.referenceImages === true,
    initImage: capabilities.initImage === true,
  };
}

function productionConsistencyPrompt(
  mode: CreativeRunCreateInput["consistencyMode"],
) {
  if (mode === "strict") {
    return "Identity consistency: strict; preserve the locked face, hairstyle, body type, and signature traits.";
  }
  if (mode === "creative") {
    return "Identity consistency: creative; explore composition and styling while preserving the core locked identity.";
  }
  return "Identity consistency: balanced; preserve the locked identity while allowing the requested scene, pose, outfit, and lighting.";
}

export function productionPrompt(input: {
  purpose: CreativeRunCreateInput["purpose"];
  target: Awaited<ReturnType<typeof resolveProductionTarget>>;
  recipeBody: string;
  presetFragment: string;
  brief?: string;
  visualProfile: Awaited<ReturnType<typeof resolveProductionVisualProfile>>;
  consistencyMode: CreativeRunCreateInput["consistencyMode"];
}) {
  if (
    input.purpose === "character_video" &&
    input.target?.type === "character"
  ) {
    return [
      `Create one continuous ${characterVideoProductionRecipe.durationSeconds}-second image-to-video portrait clip.`,
      `Target character: ${input.target.label}.`,
      "The pinned source image is the exact identity, appearance, composition, and first-frame authority.",
      `Recipe: ${input.recipeBody}`,
      input.brief ? `Operator motion brief: ${input.brief}` : "",
      "Use subtle natural motion, stable facial identity, coherent anatomy, and a steady single camera take.",
      "Do not cut, reframe, duplicate the person, introduce another person, add captions, or replace the background.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (
    input.purpose === "identity_calibration" &&
    input.target?.type === "character" &&
    input.target.visualIdentity
  ) {
    const visualIdentity = input.target.visualIdentity;
    return [
      "Single uninterrupted portrait photograph.",
      `Subject: ${input.target.label}, an adult ${visualIdentity.age}-year-old ${visualIdentity.gender}.`,
      `Visual style: ${visualIdentity.style}.`,
      visualIdentity.traits.length > 0
        ? `Identity traits: ${visualIdentity.traits.join("; ")}.`
        : "",
      visualIdentity.artDirection
        ? `Art direction: ${visualIdentity.artDirection}.`
        : "",
      input.brief ? `Operator visual brief: ${input.brief}` : "",
      "Composition: one person centered in one continuous camera frame, with a coherent background and clear subject framing.",
      "Polished reusable portrait photography.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const targetPrompt = !input.target
    ? ""
    : input.target.type === "character" && input.visualProfile
      ? `Target character: ${input.target.label}. The Operator brief is the authority for the current scene; do not import people, setting, or events from the character synopsis.`
      : `Target ${input.target.type}: ${input.target.label}. ${input.target.detail}`;
  return [
    `Production purpose: ${purposeLabel(input.purpose)}.`,
    targetPrompt,
    input.visualProfile ? `Locked identity: ${input.visualProfile.identityPrompt}` : "",
    input.visualProfile ? productionConsistencyPrompt(input.consistencyMode) : "",
    `Recipe: ${input.recipeBody}`,
    input.presetFragment ? `Presets: ${input.presetFragment}` : "",
    input.brief ? `Operator brief: ${input.brief}` : "",
    input.target?.type === "character"
      ? "Composition guard: render exactly one person total—the target character—with no background people, duplicated person, collage, contact sheet, split panel, or comparison grid."
      : "",
    "Generate a polished, reusable platform image with clear subject framing and no text overlay.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function productionControls(input: {
  orientation: string;
  dimensions: { width: number; height: number };
  profile: {
    profileKey: string;
    version: number;
    runner: string;
    pipelineModel: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    modelFormat: string;
    runnerConfig: Prisma.JsonValue | null;
    steps: number;
    sampler: string;
    scheduler: string;
    cfgScale: number;
    defaultWidth: number;
    defaultHeight: number;
  };
  presets: Array<{ id: string; type: string }>;
  visualProfile: Awaited<ReturnType<typeof resolveProductionVisualProfile>>;
  consistencyMode: CreativeRunCreateInput["consistencyMode"];
  referenceAssetIds: readonly string[];
  workflowIdentity: {
    mode: string;
    maxReferences: number;
    acceptedRoles: readonly string[];
    supportsLookReference: boolean;
    supportsSourceImageWithIdentity: boolean;
  } | undefined;
  generationRouteFingerprint?: string;
  compositionRequirement?: "single_subject_single_frame";
}) {
  // 锚点由 active Reference Set 的 role 现算，与公开付费生成路径同口径；
  // 此前这里读 profile 影子列，两条生图路径对「哪几张是身份锚点」的判断可能不一致。
  const anchorAssetIds = [
    ...(characterReferenceAuthorityFrom(
      input.visualProfile?.referenceSetRevisions[0],
    )?.anchors ?? []),
  ];
  const referenceAssetIds = [...new Set(input.referenceAssetIds)];
  return pruneUndefined({
    orientation: input.orientation,
    model: input.profile.profileKey,
    profileId: input.profile.profileKey,
    width: input.dimensions.width,
    height: input.dimensions.height,
    backgroundPresetId: presetIdForType(input.presets, "background"),
    posePresetId: presetIdForType(input.presets, "pose"),
    outfitPresetId: presetIdForType(input.presets, "outfit"),
    modePresetId: presetIdForType(input.presets, "mode"),
    consistencyMode: input.visualProfile ? input.consistencyMode : undefined,
    workflowIdentity: input.workflowIdentity,
    generationRouteFingerprint: input.generationRouteFingerprint,
    compositionRequirement: input.compositionRequirement,
    visualIdentity: input.visualProfile
      ? {
          visualProfileId: input.visualProfile.id,
          visualProfileVersion: input.visualProfile.version,
          consistencyMode: input.consistencyMode,
          anchorAssetIds,
          referenceAssetIds,
          seed: input.visualProfile.defaultSeed,
        }
      : undefined,
    contentProduction: true,
  });
}

export function productionNegativePrompt(
  base: string | null,
  identity: string | null | undefined,
  purpose: CreativeRunCreateInput["purpose"],
) {
  if (purpose === "character_video") {
    return [
      base?.trim(),
      "identity drift, face morphing, flicker, jitter, camera cut, reframing, duplicate person, extra people, text, watermark",
    ].filter(Boolean).join(", ");
  }
  const characterCompositionGuard =
    purpose.startsWith("character_") || purpose === "identity_calibration"
    ? "collage, contact sheet, split screen, multiple panels, comparison grid, duplicate person, extra people"
    : null;
  return [base?.trim(), identity?.trim(), characterCompositionGuard].filter(Boolean).join(", ") || null;
}

function presetIdForType(presets: Array<{ id: string; type: string }>, type: string) {
  return presets.find((preset) => preset.type === type)?.id;
}

export function presetPromptFragment(
  orderedIds: string[],
  presets: Array<{ id: string; label: string; controls: Prisma.JsonValue }>,
) {
  const fragments: string[] = [];
  for (const id of orderedIds) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) continue;
    const controls = jsonRecord(preset.controls);
    const values = Object.values(controls)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    fragments.push(values.length ? values.join(", ") : preset.label);
  }
  return fragments.join(", ");
}

export async function appendProductionJobEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

export function purposeLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function parseOptionalDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Errors.badRequest("Invalid scheduledAt value");
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
