import type { CharacterProductionJourney } from "@idream/shared/admin";
import type {
  CharacterProject,
  CharacterRelease,
  PrismaClient,
} from "@prisma/client";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { deriveCreativeItemExecutionState } from "../creative/run-state";
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
import { CHARACTER_RELEASE_POLICY_VERSION, characterDraftSoulBlocker } from "./release-validation";
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

// SPEC: 路线资格的运维入口。不走 character-deep-link：它不在角色工作台内。
const PLATFORM_ROUTE_ADMIN_LINK = "/admin/ops/profiles";

export function distinctPurposeAssetPack(
  input: Partial<Record<CharacterProductionPurpose, string>>,
): CharacterProductionAssetPack {
  const seenAssetIds = new Set<string>();
  return Object.fromEntries(
    characterProductionPurposes.flatMap((purpose) => {
      const assetId = input[purpose];
      if (!assetId || seenAssetIds.has(assetId)) return [];
      seenAssetIds.add(assetId);
      return [[purpose, assetId]];
    }),
  );
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
  return distinctPurposeAssetPack(
    Object.fromEntries(
      characterProductionPurposes.flatMap((purpose) => {
        const entry = entries[purpose];
        return entry && routeAuthority.routeCurrentByPurpose[purpose] === true
          ? [[purpose, entry.assetId]]
          : [];
      }),
    ),
  );
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
  return distinctPurposeAssetPack(
    Object.fromEntries(
      characterProductionPurposes.flatMap((purpose) => {
        const assetIds = [...(assetIdsByPurpose.get(purpose) ?? [])];
        return assetIds.length === 1 ? [[purpose, assetIds[0]]] : [];
      }),
    ),
  );
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
  hasVisualProfile: boolean;
  activeIndex: number;
  blocked: boolean;
  live: boolean;
}) {
  const tabLink = (tab: Parameters<typeof characterWorkspaceTabLink>[1]) =>
    characterWorkspaceTabLink(input.characterId, tab);
  // SPEC: Once a Character is live, Preview, Release, and Live monitoring have all been reached.
  // INTENT: A later draft asset iteration can make Image assets current again, but it must not
  //         rewrite the already-live downstream stages as "Not started".
  const state = (index: number) =>
    index === input.activeIndex
      ? input.blocked
        ? ("blocked" as const)
        : ("current" as const)
      : index < input.activeIndex || input.live
        ? ("complete" as const)
        : ("upcoming" as const);
  return [
    {
      code: "visual_identity",
      state: state(0),
      // 没有身份时，建立身份的唯一动作就是在 Assets 生成并审核第一张肖像；
      // 有身份后，补参考集/路线才回到 Visual。进度条必须和主动作落到同一处。
      deepLink: tabLink(input.hasVisualProfile ? "visual" : "assets"),
    },
    { code: "image_assets", state: state(1), deepLink: tabLink("assets") },
    { code: "preview", state: state(2), deepLink: tabLink("preview") },
    { code: "release", state: state(3), deepLink: tabLink("release") },
    { code: "live_monitor", state: state(4), deepLink: tabLink("monitor") },
  ] as const;
}

function actionIndex(
  code: CharacterProductionJourney["primaryAction"]["code"],
) {
  if (
    [
      "create_primary_portrait",
      "prepare_image_production",
      "complete_image_route",
      "platform_route_unavailable",
    ].includes(code)
  )
    return 0;
  if (
    [
      "continue_image_run",
      "continue_asset_pack",
      "retry_failed_image_run",
      "resolve_unknown_image_run",
    ].includes(code)
  )
    return 1;
  if (code === "preview_character" || code === "repair_character_soul") return 2;
  if (code === "publish_character") return 3;
  return 4;
}

function activeCommandStage(commandType: string) {
  return commandType.includes("identity") || commandType.includes("image")
    ? { stage: "image_production" as const, step: 1 }
    : { stage: "publishing" as const, step: 3 };
}

export type CharacterImageRunIssue = "failed" | "unknown";

// SPEC: 一次 Run 的结局按它的 item 判：有图就不是问题；任何一项结局未知，发出去的请求可能已经
//       产生费用，要先核对；全部失败才算失败。仍在进行的返回 null，由 hasActiveImageRun 负责。
export function imageRunIssueFromItems(
  items: ReadonlyArray<{
    readonly status: string;
    readonly mediaAssetId: string | null;
    readonly jobStatus: string | null;
    readonly jobErrorCode: string | null;
    readonly attemptUnknown: boolean;
  }>,
): CharacterImageRunIssue | null {
  if (items.length === 0) return null;
  const states = items.map((item) =>
    deriveCreativeItemExecutionState({
      itemStatus: item.status,
      jobStatus: item.jobStatus,
      jobErrorCode: item.jobErrorCode,
      attemptStatus: item.attemptUnknown ? "unknown" : null,
      transportStatus: null,
      hasAsset: item.mediaAssetId !== null,
    }),
  );
  if (states.includes("ready")) return null;
  if (states.includes("unknown")) return "unknown";
  return states.every((state) => state === "failed") ? "failed" : null;
}

export function projectCharacterProductionJourneySnapshot(input: {
  characterId: string;
  asOf: Date;
  hasVisualProfile: boolean;
  referenceCount: number;
  routeQualified: boolean;
  hasActiveImageRun: boolean;
  draftPurposes: readonly CharacterProductionPurpose[];
  /** Latest Run of a still-missing purpose ended without an image, or its outcome is unknown. */
  imageRunIssue?: CharacterImageRunIssue | null;
  livePurposes: readonly CharacterProductionPurpose[];
  /** The draft pack selects exactly the images the live Release serves. */
  draftPackMatchesLive?: boolean;
  servingState: CharacterProductionJourney["release"]["servingState"];
  currentReleaseId: string | null;
  candidateReleaseId: string | null;
  pendingRevision: { id: string; revision: number; createdAt: Date } | null;
  /** First Soul/opening release gate the draft fails (characterDraftSoulBlocker). */
  soulBlocker?: ReturnType<typeof characterDraftSoulBlocker>;
  activeCommand: NonNullable<
    CharacterProductionJourney["primaryAction"]["command"]
  > | null;
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
  // SPEC: 暂停的角色保留 Release，与线上同样不需要补草稿；线上图齐、草稿没有新东西、
  //       也没有待发布修订时，生产环节没有活可干，路线或 Run 的问题都不构成待办。
  const servesRelease =
    input.servingState === "live" || input.servingState === "paused";
  const nothingToProduce =
    servesRelease &&
    live.completed === live.total &&
    !input.candidateReleaseId &&
    !input.pendingRevision &&
    (draft.completed === 0 || input.draftPackMatchesLive === true);
  if (input.activeCommand) {
    const deepLink = commandDeepLink(
      input.characterId,
      input.activeCommand.type,
    );
    const commandStage = activeCommandStage(input.activeCommand.type);
    if (input.activeCommand.needsReconciliation) {
      blockers.push({
        code: "command_needs_reconciliation",
        message:
          "The active command outcome must be reconciled before another mutation.",
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
    status = input.activeCommand.needsReconciliation
      ? "blocked"
      : "in_progress";
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
  } else if (
    (input.referenceCount === 0 || !input.routeQualified) &&
    !nothingToProduce
  ) {
    const operatorFixable = input.referenceCount === 0;
    // INTENT: 路线资格由平台运维管理；角色页的路线区只读，把运营带过去只会让他对着看不懂的
    //         区块找不存在的按钮。缺参考集才是运营在角色页能修的。
    const deepLink = operatorFixable
      ? characterWorkspaceAnchorLink(input.characterId, "visual_reference_set")
      : PLATFORM_ROUTE_ADMIN_LINK;
    blockers.push({
      code: operatorFixable
        ? "reference_set_not_active"
        : "generation_route_unqualified",
      message: operatorFixable
        ? "A sealed active Reference Set is required."
        : "No qualified image route can consume this Character's Reference Set. This is a platform configuration issue; platform operations can fix it under Profiles & Rollout.",
      deepLink,
    });
    primaryAction = {
      code: operatorFixable ? "complete_image_route" : "platform_route_unavailable",
      deepLink,
      command: null,
    };
    stage = "visual_setup";
    status = "blocked";
  } else if (input.imageRunIssue === "unknown" && !nothingToProduce) {
    // INTENT: 结局未知的 Run 往往还挂着 running 的 Job，必须排在「继续当前图片」之前，
    //         否则运营会对着一个永远不会结束的进度等下去；也不能直接再生成——可能重复扣费。
    const deepLink = tabLink("assets");
    blockers.push({
      code: "image_run_outcome_unknown",
      message:
        "The latest image Run has an unknown outcome and may already have cost money. Check that Run before generating again.",
      deepLink,
    });
    primaryAction = { code: "resolve_unknown_image_run", deepLink, command: null };
    stage = "image_production";
    status = "blocked";
  } else if (input.hasActiveImageRun) {
    primaryAction = {
      code: "continue_image_run",
      deepLink: tabLink("assets"),
      command: null,
    };
    stage = "image_production";
    status = "in_progress";
  } else {
    const workingPack = servesRelease && draft.completed === 0 ? live : draft;
    if (workingPack.completed < workingPack.total && input.imageRunIssue === "failed") {
      const deepLink = tabLink("assets");
      blockers.push({
        code: "image_run_failed",
        message: "The latest image Run failed without producing an image. Generate it again.",
        deepLink,
      });
      primaryAction = { code: "retry_failed_image_run", deepLink, command: null };
      stage = "image_production";
      status = "in_progress";
    } else if (workingPack.completed < workingPack.total) {
      primaryAction = {
        code: "continue_asset_pack",
        deepLink: tabLink("assets"),
        command: null,
      };
      stage = "image_production";
      status = "in_progress";
    } else if (input.candidateReleaseId) {
      primaryAction = {
        code: "publish_character",
        deepLink: tabLink("release"),
        command: null,
      };
      stage = "publishing";
      status = "ready";
    } else if (nothingToProduce) {
      // SPEC: publishing leaves the draft pack in place, so a live Character whose
      // draft pack is empty or equals the live pack, with no newer Revision, has
      // nothing to preview; an unpublished Revision always goes back to Preview.
      // A paused Character keeps its Release, so the same holds for it.
      primaryAction = {
        code: "monitor_live_character",
        deepLink: tabLink("monitor"),
        command: null,
      };
      stage = "live_operations";
      status = "live";
    } else if (input.soulBlocker) {
      // INTENT: the images are done, but Release would refuse this draft; sending the
      // operator to Preview first only defers the same dead end by two screens.
      const deepLink = tabLink("soul");
      blockers.push({
        code: input.soulBlocker,
        message: input.soulBlocker === "opening_complete"
          ? "The draft has no opening message."
          : "The draft persona must be saved in the current format before publishing.",
        deepLink,
      });
      primaryAction = { code: "repair_character_soul", deepLink, command: null };
      stage = "preview";
      status = "blocked";
    } else {
      primaryAction = {
        code: "preview_character",
        deepLink: tabLink("preview"),
        command: null,
      };
      stage = "preview";
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
      hasVisualProfile: input.hasVisualProfile,
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
      pendingRevision: input.pendingRevision
        ? {
            revisionId: input.pendingRevision.id,
            revision: input.pendingRevision.revision,
            createdAt: input.pendingRevision.createdAt.toISOString(),
            deepLink: tabLink("release"),
          }
        : null,
    },
  };
}

function samePack(
  draft: CharacterProductionAssetPack,
  live: CharacterProductionAssetPack,
) {
  return characterProductionPurposes.every(
    (purpose) => draft[purpose] === live[purpose],
  );
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
    readonly availableAssetIdsByCharacter?: ReadonlyMap<
      string,
      ReadonlySet<string>
    >;
  } = {},
): Promise<ReadonlyMap<string, CharacterProductionJourney>> {
  const ids = [...new Set(characterIds)];
  if (ids.length === 0) return new Map();
  const coordinationKeys = ids.map(characterCommandCoordinationKey);
  const [projects, servings, profiles, activeRuns, latestRuns, commands, contents] =
    await Promise.all([
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
          items: { some: { job: { status: { in: ["queued", "running"] } } } },
        },
        select: { targetId: true },
      }),
      db.contentProductionBatch.findMany({
        where: {
          targetType: "character",
          targetId: { in: ids },
          purpose: { in: [...characterProductionPurposes] },
          lifecycleState: { not: "archived" },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        distinct: ["targetId", "purpose"],
        select: {
          targetId: true,
          purpose: true,
          items: {
            select: {
              status: true,
              mediaAssetId: true,
              jobId: true,
              job: { select: { status: true, errorCode: true } },
            },
          },
        },
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
      db.characterContentVersion.findMany({
        where: { characterId: { in: ids } },
        orderBy: [{ characterId: "asc" }, { version: "desc" }, { id: "desc" }],
        distinct: ["characterId"],
        select: { characterId: true, personaSnapshot: true, openingSnapshot: true },
      }),
    ]);
  const contentByCharacter = new Map(contents.map((content) => [content.characterId, content]));
  const latestRunJobIds = latestRuns.flatMap((run) =>
    run.items.flatMap((item) => (item.jobId ? [item.jobId] : [])),
  );
  const unknownJobIds = new Set(
    latestRunJobIds.length > 0
      ? (
          await db.generationAttempt.findMany({
            where: { requestId: { in: latestRunJobIds }, status: "unknown" },
            select: { requestId: true },
          })
        ).map((attempt) => attempt.requestId)
      : [],
  );
  const runIssuesByCharacter = new Map<
    string,
    Partial<Record<CharacterProductionPurpose, CharacterImageRunIssue>>
  >();
  for (const run of latestRuns) {
    if (!run.targetId) continue;
    const issue = imageRunIssueFromItems(
      run.items.map((item) => ({
        status: item.status,
        mediaAssetId: item.mediaAssetId,
        jobStatus: item.job?.status ?? null,
        jobErrorCode: item.job?.errorCode ?? null,
        attemptUnknown: item.jobId !== null && unknownJobIds.has(item.jobId),
      })),
    );
    if (!issue) continue;
    runIssuesByCharacter.set(run.targetId, {
      ...runIssuesByCharacter.get(run.targetId),
      [run.purpose as CharacterProductionPurpose]: issue,
    });
  }
  const projectByCharacter = new Map<string, CharacterProject>();
  for (const project of projects) {
    if (!projectByCharacter.has(project.characterId)) {
      projectByCharacter.set(project.characterId, project);
    }
  }
  const projectIds = [...projectByCharacter.values()].map(
    (project) => project.id,
  );
  const [releases, revisions] =
    projectIds.length > 0
      ? await Promise.all([
          db.characterRelease.findMany({
            where: { projectId: { in: projectIds } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
          db.characterRevision.findMany({
            where: { projectId: { in: projectIds } },
            orderBy: [{ revision: "desc" }, { id: "desc" }],
            select: { id: true, projectId: true, revision: true, createdAt: true },
          }),
        ])
      : [[], []];
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
  const routePromises = new Map<
    string,
    ReturnType<typeof findOperationalGenerationRoute>
  >();
  const routeByCharacter = new Map<
    string,
    Awaited<ReturnType<typeof findOperationalGenerationRoute>>
  >();
  await Promise.all(
    ids.map(async (characterId) => {
      const profile = profileByCharacter.get(characterId);
      if (!profile) return;
      if (options.routeByCharacter?.has(characterId)) {
        const route = options.routeByCharacter.get(characterId) ?? null;
        if (route) routeByCharacter.set(characterId, route);
        return;
      }
      const roles =
        profile.referenceSetRevisions[0]?.references.map(
          (reference) => reference.role,
        ) ?? [];
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
    }),
  );
  const servingByCharacter = new Map(
    servings.map((serving) => [serving.characterId, serving]),
  );
  const draftPackByCharacter = new Map<string, CharacterProductionAssetPack>();
  const livePackByCharacter = new Map<string, CharacterProductionAssetPack>();
  const candidateByCharacter = new Map<string, CharacterRelease | null>();
  const pendingRevisionByCharacter = new Map<string, (typeof revisions)[number]>();
  for (const characterId of ids) {
    const project = projectByCharacter.get(characterId);
    if (!project) continue;
    const characterReleases = releasesByProject.get(project.id) ?? [];
    const serving = servingByCharacter.get(characterId);
    const currentRelease = serving?.currentReleaseId
      ? (characterReleases.find(
          (release) => release.id === serving.currentReleaseId,
        ) ?? null)
      : null;
    candidateByCharacter.set(
      characterId,
      characterReleases.find(
        (release) =>
          !["published", "superseded", "withdrawn"].includes(release.status),
      ) ?? null,
    );
    draftPackByCharacter.set(
      characterId,
      projectCurrentDraftAssetPack(
        project,
        routeByCharacter.get(characterId)?.routeFingerprint ?? null,
      ),
    );
    livePackByCharacter.set(characterId, releaseAssetPack(currentRelease));
    // SPEC: a Character that has a current Release but a Revision newer than
    // every Revision any of its Releases ever put live has an edit nobody
    // published yet.
    // INTENT: a creator edit writes a Revision and never touches Serving, so
    // without this the operator sees a healthy live Character and the edit sits
    // unpublished indefinitely. A Revision that did go live and was rolled back
    // is a decision, not a forgotten edit.
    if (currentRelease) {
      const latest = revisions.find((revision) => revision.projectId === project.id);
      const shipped = characterReleases.filter(
        (release) => release.publishedAt !== null || release.id === currentRelease.id,
      );
      // A legacy Release may pin a Revision id that never existed; then only a
      // Revision written after that Release counts.
      const newer = latest && shipped.every((release) => {
        if (release.revisionId === latest.id) return false;
        const pinned = revisions.find((revision) => revision.id === release.revisionId);
        return pinned ? latest.revision > pinned.revision : latest.createdAt > release.createdAt;
      });
      if (latest && newer) {
        pendingRevisionByCharacter.set(characterId, latest);
      }
    }
  }
  const candidateAssetIds = [
    ...new Set([
      ...[...draftPackByCharacter.values()].flatMap(packAssetIds),
      ...[...livePackByCharacter.values()].flatMap(packAssetIds),
    ]),
  ];
  const [assets, legacyCharacterReferences] =
    candidateAssetIds.length > 0 && !options.availableAssetIdsByCharacter
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
    const characterReferences =
      legacyReferencesByAsset.get(reference.imageAssetId) ?? [];
    characterReferences.push(reference.id);
    legacyReferencesByAsset.set(reference.imageAssetId, characterReferences);
  }
  const availableAssetIdsFor = (characterId: string) =>
    new Set(
      options.availableAssetIdsByCharacter?.get(characterId) ??
        candidateAssetIds.filter((assetId) => {
          const asset = assetById.get(assetId);
          if (!asset || !isMediaAssetOperationalForAuthority(asset.metadata))
            return false;
          return (
            asset.characterId === characterId ||
            (asset.characterId === null &&
              (legacyReferencesByAsset.get(assetId) ?? []).length === 1 &&
              legacyReferencesByAsset.get(assetId)?.[0] === characterId)
          );
        }),
    );
  const activeRunIds = new Set(
    activeRuns.flatMap((run) => (run.targetId ? [run.targetId] : [])),
  );
  const commandByCoordinationKey = new Map<string, (typeof commands)[number]>();
  for (const command of commands) {
    if (
      command.coordinationKey &&
      !commandByCoordinationKey.has(command.coordinationKey)
    ) {
      commandByCoordinationKey.set(command.coordinationKey, command);
    }
  }
  const journeys = new Map<string, CharacterProductionJourney>();
  for (const characterId of ids) {
    const project = projectByCharacter.get(characterId);
    if (!project) continue;
    const profile = profileByCharacter.get(characterId) ?? null;
    const referenceCount =
      profile?.referenceSetRevisions[0]?.references.length ?? 0;
    const route = routeByCharacter.get(characterId) ?? null;
    const serving = servingByCharacter.get(characterId) ?? null;
    const candidate = candidateByCharacter.get(characterId) ?? null;
    const availableIds = availableAssetIdsFor(characterId);
    const command =
      commandByCoordinationKey.get(
        characterCommandCoordinationKey(characterId),
      ) ?? null;
    const draftPurposes = availablePurposes(
      draftPackByCharacter.get(characterId) ?? {},
      availableIds,
    );
    // Only a purpose still missing from the draft needs another image.
    const runIssues = characterProductionPurposes.flatMap((purpose) => {
      const issue = runIssuesByCharacter.get(characterId)?.[purpose];
      return issue && !draftPurposes.includes(purpose) ? [issue] : [];
    });
    journeys.set(
      characterId,
      projectCharacterProductionJourneySnapshot({
        characterId,
        asOf,
        hasVisualProfile: profile !== null,
        referenceCount,
        routeQualified: route !== null,
        hasActiveImageRun: activeRunIds.has(characterId),
        draftPurposes,
        imageRunIssue: runIssues.includes("unknown")
          ? "unknown"
          : runIssues.includes("failed")
            ? "failed"
            : null,
        livePurposes: availablePurposes(
          livePackByCharacter.get(characterId) ?? {},
          availableIds,
        ),
        draftPackMatchesLive: samePack(
          draftPackByCharacter.get(characterId) ?? {},
          livePackByCharacter.get(characterId) ?? {},
        ),
        servingState: (serving?.state ??
          "inactive") as CharacterProductionJourney["release"]["servingState"],
        currentReleaseId: serving?.currentReleaseId ?? null,
        candidateReleaseId: candidate?.id ?? null,
        pendingRevision: pendingRevisionByCharacter.get(characterId) ?? null,
        soulBlocker: characterDraftSoulBlocker(contentByCharacter.get(characterId) ?? null),
        activeCommand: command
          ? {
              id: command.id,
              type: command.commandType,
              status: command.status as NonNullable<
                CharacterProductionJourney["primaryAction"]["command"]
              >["status"],
              needsReconciliation: command.needsReconciliation,
            }
          : null,
      }),
    );
  }
  return journeys;
}

export async function projectCharacterProductionJourney(
  db: Db,
  characterId: string,
  asOf = new Date(),
) {
  const journey = (
    await projectCharacterProductionJourneys(db, [characterId], asOf)
  ).get(characterId);
  if (!journey) throw Errors.notFound("Character production journey not found");
  return journey;
}
