import type {
  CharacterProductionJourney,
} from "@idream/shared/admin";
import type {
  CharacterProject,
  CharacterRelease,
  PrismaClient,
} from "@prisma/client";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { ACTIVE_CONTROL_PLANE_COMMAND_STATUSES } from "../shared/control-plane-command";
import { characterCommandCoordinationKey } from "./command-coordination";
import {
  characterReleaseAssetPurpose,
  characterReleasePlacements,
} from "./character-release-contract";
import {
  characterWorkspaceAnchorLink,
  characterWorkspaceTabLink,
} from "./character-deep-link";
import {
  draftAssetRouteEntries,
  evaluateDraftAssetRouteAuthority,
} from "./draft-asset-route-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { findOperationalGenerationRoute } from "./visual-authority";

export const characterProductionPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

export type CharacterProductionPurpose =
  (typeof characterProductionPurposes)[number];
export type CharacterProductionAssetPack = Partial<
  Record<CharacterProductionPurpose, string>
>;

type Db = PrismaClient;

export function distinctPurposeAssetPack(
  input: Partial<Record<CharacterProductionPurpose, string>>,
): CharacterProductionAssetPack {
  const seenAssetIds = new Set<string>();
  return Object.fromEntries(characterProductionPurposes.flatMap((purpose) => {
    const assetId = input[purpose];
    if (!assetId || seenAssetIds.has(assetId)) return [];
    seenAssetIds.add(assetId);
    return [[purpose, assetId]];
  }));
}

export function projectCurrentDraftAssetPack(
  project: CharacterProject,
  currentRouteFingerprint: string | null,
): CharacterProductionAssetPack {
  const entries = draftAssetRouteEntries(project.draftAssetPack);
  const routeAuthority = evaluateDraftAssetRouteAuthority(
    project.draftAssetPack,
    currentRouteFingerprint,
  );
  return distinctPurposeAssetPack(Object.fromEntries(
    characterProductionPurposes.flatMap((purpose) => {
      const entry = entries[purpose];
      return entry && routeAuthority.routeCurrentByPurpose[purpose] === true
        ? [[purpose, entry.assetId]]
        : [];
    }),
  ));
}

// SPEC: 历史 manifest 里同一个槽位重复登记同一张图，仍然算这个用途有图。
// INTENT: 这条**不是**预览链那条 exact 规则的复制品，两者故意不同：预览链要签发 preview token，
// 歧义必须 fail-closed；这条只统计运营完成度，对着 legacy release 从宽。共用的只有 slot→purpose
// 那张表。（portfolio.integration 的 legacy fixture 直接钉着这个差别。）
export function releaseAssetPack(
  release: CharacterRelease | null,
): CharacterProductionAssetPack {
  if (!release) return {};
  const assetIdsByPurpose = new Map<CharacterProductionPurpose, Set<string>>();
  for (const placement of characterReleasePlacements(release)) {
    const purpose = characterReleaseAssetPurpose(placement.slotKey);
    if (!purpose) continue;
    const assetIds = assetIdsByPurpose.get(purpose) ?? new Set<string>();
    assetIds.add(placement.assetId);
    assetIdsByPurpose.set(purpose, assetIds);
  }
  return distinctPurposeAssetPack(Object.fromEntries(
    characterProductionPurposes.flatMap((purpose) => {
      const assetIds = [...(assetIdsByPurpose.get(purpose) ?? [])];
      return assetIds.length === 1 ? [[purpose, assetIds[0]]] : [];
    }),
  ));
}

export function availablePurposes(
  pack: CharacterProductionAssetPack,
  availableAssetIds: ReadonlySet<string>,
) {
  return characterProductionPurposes.filter((purpose) => {
    const assetId = pack[purpose];
    return Boolean(assetId && availableAssetIds.has(assetId));
  });
}

function packAssetIds(pack: CharacterProductionAssetPack) {
  return characterProductionPurposes.flatMap((purpose) => {
    const assetId = pack[purpose];
    return assetId ? [assetId] : [];
  });
}

function progress(available: readonly CharacterProductionPurpose[]) {
  const availableSet = new Set(available);
  return {
    availablePurposes: [...available],
    missingPurposes: characterProductionPurposes.filter(
      (purpose) => !availableSet.has(purpose),
    ),
    completed: availableSet.size,
    total: 3 as const,
  };
}

function commandDeepLink(characterId: string, commandType: string) {
  return characterWorkspaceTabLink(
    characterId,
    commandType.includes("identity") || commandType.includes("image")
      ? "assets"
      : "release",
  );
}

function journeySteps(input: {
  characterId: string;
  activeIndex: number;
  blocked: boolean;
  live: boolean;
}) {
  const tabLink = (tab: Parameters<typeof characterWorkspaceTabLink>[1]) =>
    characterWorkspaceTabLink(input.characterId, tab);
  const state = (index: number, release = false) => index === input.activeIndex
      ? input.blocked ? "blocked" as const : "current" as const
      : index < input.activeIndex || (input.live && release)
        ? "complete" as const
        : "upcoming" as const;
  return [
    { code: "visual_identity", state: state(0), deepLink: tabLink("visual") },
    { code: "image_assets", state: state(1), deepLink: tabLink("assets") },
    { code: "preview_qa", state: state(2), deepLink: tabLink("preview") },
    { code: "release", state: state(3, true), deepLink: tabLink("release") },
    { code: "live_monitor", state: state(4), deepLink: tabLink("monitor") },
  ] as const;
}

function actionIndex(code: CharacterProductionJourney["primaryAction"]["code"]) {
  if (["create_primary_portrait", "prepare_image_production", "complete_image_route"].includes(code)) return 0;
  if (["continue_image_run", "continue_asset_pack"].includes(code)) return 1;
  if (code === "run_preview_qa") return 2;
  if (code === "review_candidate_release") return 3;
  return 4;
}

function activeCommandStage(commandType: string) {
  return commandType.includes("identity") || commandType.includes("image")
    ? { stage: "image_production" as const, step: 1 }
    : { stage: "release_review" as const, step: 3 };
}

export function projectCharacterProductionJourneySnapshot(input: {
  characterId: string;
  asOf: Date;
  hasVisualProfile: boolean;
  referenceCount: number;
  routeQualified: boolean;
  hasActiveImageRun: boolean;
  draftPurposes: readonly CharacterProductionPurpose[];
  livePurposes: readonly CharacterProductionPurpose[];
  servingState: CharacterProductionJourney["release"]["servingState"];
  currentReleaseId: string | null;
  candidateReleaseId: string | null;
  activeCommand: NonNullable<CharacterProductionJourney["primaryAction"]["command"]> | null;
}): CharacterProductionJourney {
  const tabLink = (tab: Parameters<typeof characterWorkspaceTabLink>[1]) =>
    characterWorkspaceTabLink(input.characterId, tab);
  const draft = progress(input.draftPurposes);
  const live = progress(input.livePurposes);
  const blockers: Array<CharacterProductionJourney["blockers"][number]> = [];
  let primaryAction: CharacterProductionJourney["primaryAction"];
  let stage: CharacterProductionJourney["stage"];
  let status: CharacterProductionJourney["status"];
  let activeStep: number | null = null;
  if (input.activeCommand) {
    const deepLink = commandDeepLink(input.characterId, input.activeCommand.type);
    const commandStage = activeCommandStage(input.activeCommand.type);
    if (input.activeCommand.needsReconciliation) {
      blockers.push({
        code: "command_needs_reconciliation",
        message: "The active command outcome must be reconciled before another mutation.",
        deepLink,
      });
    }
    primaryAction = {
      code: "recover_active_command",
      deepLink,
      command: input.activeCommand,
    };
    stage = commandStage.stage;
    activeStep = commandStage.step;
    status = input.activeCommand.needsReconciliation ? "blocked" : "in_progress";
  } else if (!input.hasVisualProfile) {
    const deepLink = tabLink("assets");
    blockers.push({
      code: "visual_identity_missing",
      message: "A reusable visual identity has not been established.",
      deepLink,
    });
    primaryAction = {
      code: live.availablePurposes.includes("character_cover")
        ? "prepare_image_production"
        : "create_primary_portrait",
      deepLink,
      command: null,
    };
    stage = "visual_setup";
    status = "in_progress";
  } else if (input.referenceCount === 0 || !input.routeQualified) {
    const deepLink = characterWorkspaceAnchorLink(
      input.characterId,
      input.referenceCount === 0
        ? "visual_reference_set"
        : "route_qualification_workbench",
    );
    blockers.push({
      code: input.referenceCount === 0
        ? "reference_set_not_active"
        : "generation_route_unqualified",
      message: input.referenceCount === 0
        ? "A sealed active Reference Set is required."
        : "No qualified image route can consume the current Reference Set.",
      deepLink,
    });
    primaryAction = { code: "complete_image_route", deepLink, command: null };
    stage = "visual_setup";
    status = "blocked";
  } else if (input.hasActiveImageRun) {
    primaryAction = { code: "continue_image_run", deepLink: tabLink("assets"), command: null };
    stage = "image_production";
    status = "in_progress";
  } else {
    const liveNow = input.servingState === "live";
    const workingPack = liveNow && draft.completed === 0 ? live : draft;
    if (workingPack.completed < workingPack.total) {
      primaryAction = { code: "continue_asset_pack", deepLink: tabLink("assets"), command: null };
      stage = "image_production";
      status = "in_progress";
    } else if (input.candidateReleaseId) {
      primaryAction = { code: "review_candidate_release", deepLink: tabLink("release"), command: null };
      stage = "release_review";
      status = "ready";
    } else if (liveNow && draft.completed === 0) {
      primaryAction = { code: "monitor_live_character", deepLink: tabLink("monitor"), command: null };
      stage = "live_operations";
      status = "live";
    } else {
      primaryAction = { code: "run_preview_qa", deepLink: tabLink("preview"), command: null };
      stage = "preview_qa";
      status = "ready";
    }
  }
  return {
    projectionVersion: 1,
    asOf: input.asOf.toISOString(),
    stage,
    status,
    steps: journeySteps({
      characterId: input.characterId,
      activeIndex: activeStep ?? actionIndex(primaryAction.code),
      blocked: status === "blocked",
      live: input.servingState === "live",
    }),
    blockers,
    primaryAction,
    assetPack: { draft, live },
    release: {
      servingState: input.servingState,
      currentReleaseId: input.currentReleaseId,
      candidateReleaseId: input.candidateReleaseId,
    },
  };
}

export async function projectCharacterProductionJourneys(
  db: Db,
  characterIds: readonly string[],
  asOf = new Date(),
  options: {
    readonly routeByCharacter?: ReadonlyMap<
      string,
      Awaited<ReturnType<typeof findOperationalGenerationRoute>>
    >;
    readonly availableAssetIdsByCharacter?: ReadonlyMap<string, ReadonlySet<string>>;
  } = {},
): Promise<ReadonlyMap<string, CharacterProductionJourney>> {
  const ids = [...new Set(characterIds)];
  if (ids.length === 0) return new Map();
  const coordinationKeys = ids.map(characterCommandCoordinationKey);
  const [projects, servings, profiles, activeRuns, commands] = await Promise.all([
    db.characterProject.findMany({
      where: { characterId: { in: ids } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    db.characterServing.findMany({ where: { characterId: { in: ids } } }),
    db.characterVisualProfile.findMany({
      where: { characterId: { in: ids }, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: {
        id: true,
        characterId: true,
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
    db.contentProductionBatch.findMany({
      where: {
        targetType: "character",
        targetId: { in: ids },
        purpose: { in: [...characterProductionPurposes] },
        lifecycleState: "active",
        status: { in: ["draft", "queued", "reviewing"] },
      },
      select: { targetId: true },
    }),
    db.controlPlaneCommand.findMany({
      where: {
        coordinationKey: { in: coordinationKeys },
        status: { in: [...ACTIVE_CONTROL_PLANE_COMMAND_STATUSES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        coordinationKey: true,
        commandType: true,
        status: true,
        needsReconciliation: true,
      },
    }),
  ]);
  const projectByCharacter = new Map<string, CharacterProject>();
  for (const project of projects) {
    if (!projectByCharacter.has(project.characterId)) {
      projectByCharacter.set(project.characterId, project);
    }
  }
  const projectIds = [...projectByCharacter.values()].map((project) => project.id);
  const releases = projectIds.length > 0
    ? await db.characterRelease.findMany({
        where: { projectId: { in: projectIds } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    : [];
  const releasesByProject = new Map<string, CharacterRelease[]>();
  for (const release of releases) {
    const rows = releasesByProject.get(release.projectId) ?? [];
    rows.push(release);
    releasesByProject.set(release.projectId, rows);
  }
  const profileByCharacter = new Map<string, (typeof profiles)[number]>();
  for (const profile of profiles) {
    if (!profileByCharacter.has(profile.characterId)) {
      profileByCharacter.set(profile.characterId, profile);
    }
  }
  const routePromises = new Map<string, ReturnType<typeof findOperationalGenerationRoute>>();
  const routeByCharacter = new Map<string, Awaited<ReturnType<typeof findOperationalGenerationRoute>>>();
  await Promise.all(ids.map(async (characterId) => {
    const profile = profileByCharacter.get(characterId);
    if (!profile) return;
    if (options.routeByCharacter?.has(characterId)) {
      const route = options.routeByCharacter.get(characterId) ?? null;
      if (route) routeByCharacter.set(characterId, route);
      return;
    }
    const roles = profile.referenceSetRevisions[0]?.references.map((reference) => reference.role) ?? [];
    const key = JSON.stringify([profile.style, roles]);
    let route = routePromises.get(key);
    if (!route) {
      route = findOperationalGenerationRoute(db, {
        style: profile.style,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: asOf,
        requiredReferenceCount: roles.length,
        requiredReferenceRoles: roles,
      });
      routePromises.set(key, route);
    }
    routeByCharacter.set(characterId, await route);
  }));
  const servingByCharacter = new Map(servings.map((serving) => [serving.characterId, serving]));
  const draftPackByCharacter = new Map<string, CharacterProductionAssetPack>();
  const livePackByCharacter = new Map<string, CharacterProductionAssetPack>();
  const candidateByCharacter = new Map<string, CharacterRelease | null>();
  for (const characterId of ids) {
    const project = projectByCharacter.get(characterId);
    if (!project) continue;
    const characterReleases = releasesByProject.get(project.id) ?? [];
    const serving = servingByCharacter.get(characterId);
    const currentRelease = serving?.currentReleaseId
      ? characterReleases.find((release) => release.id === serving.currentReleaseId) ?? null
      : null;
    candidateByCharacter.set(
      characterId,
      characterReleases.find((release) =>
        !["published", "superseded", "withdrawn"].includes(release.status)
      ) ?? null,
    );
    draftPackByCharacter.set(
      characterId,
      projectCurrentDraftAssetPack(project, routeByCharacter.get(characterId)?.routeFingerprint ?? null),
    );
    livePackByCharacter.set(characterId, releaseAssetPack(currentRelease));
  }
  const candidateAssetIds = [...new Set([
    ...[...draftPackByCharacter.values()].flatMap(packAssetIds),
    ...[...livePackByCharacter.values()].flatMap(packAssetIds),
  ])];
  const [assets, legacyCharacterReferences] = candidateAssetIds.length > 0 && !options.availableAssetIdsByCharacter
    ? await Promise.all([
        db.mediaAsset.findMany({
          where: operationalMediaAssetWhere({
            id: { in: candidateAssetIds },
            deletedAt: null,
            type: "image",
            safetyStatus: "passed",
          }),
          select: { id: true, characterId: true, metadata: true },
        }),
        db.character.findMany({
          where: { imageAssetId: { in: candidateAssetIds } },
          select: { id: true, imageAssetId: true },
        }),
      ])
    : [[], []];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const legacyReferencesByAsset = new Map<string, string[]>();
  for (const reference of legacyCharacterReferences) {
    if (!reference.imageAssetId) continue;
    const characterReferences = legacyReferencesByAsset.get(reference.imageAssetId) ?? [];
    characterReferences.push(reference.id);
    legacyReferencesByAsset.set(reference.imageAssetId, characterReferences);
  }
  const availableAssetIdsFor = (characterId: string) =>
    new Set(options.availableAssetIdsByCharacter?.get(characterId) ?? candidateAssetIds.filter((assetId) => {
      const asset = assetById.get(assetId);
      if (!asset || !isMediaAssetOperationalForAuthority(asset.metadata)) return false;
      return asset.characterId === characterId || (
        asset.characterId === null &&
        (legacyReferencesByAsset.get(assetId) ?? []).length === 1 &&
        legacyReferencesByAsset.get(assetId)?.[0] === characterId
      );
    }));
  const activeRunIds = new Set(activeRuns.flatMap((run) => run.targetId ? [run.targetId] : []));
  const commandByCoordinationKey = new Map<string, (typeof commands)[number]>();
  for (const command of commands) {
    if (command.coordinationKey && !commandByCoordinationKey.has(command.coordinationKey)) {
      commandByCoordinationKey.set(command.coordinationKey, command);
    }
  }
  const journeys = new Map<string, CharacterProductionJourney>();
  for (const characterId of ids) {
    const project = projectByCharacter.get(characterId);
    if (!project) continue;
    const profile = profileByCharacter.get(characterId) ?? null;
    const referenceCount = profile?.referenceSetRevisions[0]?.references.length ?? 0;
    const route = routeByCharacter.get(characterId) ?? null;
    const serving = servingByCharacter.get(characterId) ?? null;
    const candidate = candidateByCharacter.get(characterId) ?? null;
    const availableIds = availableAssetIdsFor(characterId);
    const command = commandByCoordinationKey.get(characterCommandCoordinationKey(characterId)) ?? null;
    journeys.set(characterId, projectCharacterProductionJourneySnapshot({
      characterId,
      asOf,
      hasVisualProfile: profile !== null,
      referenceCount,
      routeQualified: route !== null,
      hasActiveImageRun: activeRunIds.has(characterId),
      draftPurposes: availablePurposes(draftPackByCharacter.get(characterId) ?? {}, availableIds),
      livePurposes: availablePurposes(livePackByCharacter.get(characterId) ?? {}, availableIds),
      servingState: (serving?.state ?? "inactive") as CharacterProductionJourney["release"]["servingState"],
      currentReleaseId: serving?.currentReleaseId ?? null,
      candidateReleaseId: candidate?.id ?? null,
      activeCommand: command
        ? {
            id: command.id,
            type: command.commandType,
            status: command.status as NonNullable<CharacterProductionJourney["primaryAction"]["command"]>["status"],
            needsReconciliation: command.needsReconciliation,
          }
        : null,
    }));
  }
  return journeys;
}

export async function projectCharacterProductionJourney(
  db: Db,
  characterId: string,
  asOf = new Date(),
) {
  const journey = (await projectCharacterProductionJourneys(db, [characterId], asOf)).get(characterId);
  if (!journey) throw Errors.notFound("Character production journey not found");
  return journey;
}
