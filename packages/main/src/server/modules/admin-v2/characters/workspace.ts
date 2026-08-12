import {
  adminCommandStatusSchema,
  characterQaRunSchema,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";
import {
  getVoiceDefaultSettings,
  voiceIdForGender,
} from "@/server/modules/voice-defaults";
import { ACTIVE_CONTROL_PLANE_COMMAND_STATUSES } from "../shared/control-plane-command";
import { loadCharacterMediaOperationsProjection } from "./character-media-operations";
import { characterCommandCoordinationKey } from "./command-coordination";
import { characterAssetPack } from "./draft-asset-route-authority";
import { inspectCharacterImageGenerationSource } from "./image-readiness-authority";
import { listCharacterPortfolioData } from "./portfolio";
import { projectDto } from "./project-draft";
import { characterSoulWorkspaceProjection } from "./soul-workspace";
import {
  characterVoiceProfileDto,
  inspectConfiguredVoiceIdentityRuntime,
} from "./voice-identity";
import {
  previewAssetPackDto,
  previewChangedFields,
  previewSnapshot,
  releasePreviewAssetPackIds,
} from "./workspace-preview";
import {
  characterWorkspaceReleaseProjection,
  servingDto,
} from "./workspace-release";
import { loadCharacterVisualWorkspace } from "./workspace-visual";

/**
 * SPEC: 角色运营台一次请求要看到的全部事实，按面板组装：Soul / Project / Visual /
 * Voice / Release / Preview / Performance。
 * INTENT: 这里只负责取数与拼装，每个面板自己的投影规则住在同名子域文件里——面板长胖时
 * 改的是那个文件，不是这里。取数顺序仍是原来那串批次：能并行的进同一个 Promise.all，
 * 有依赖的（先有身份版本才能查参考集）保持串行。
 */
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
  if (!character) throw Errors.notFound("Character not found");
  if (!project) {
    const approvedSubmission =
      character.source === "user" &&
      character.visibility === "public" &&
      character.status === "approved" &&
      character.currentContentVersionId
        ? await prisma.characterSubmission.findFirst({
            where: { characterId, status: "approved" },
            orderBy: [
              { reviewedAt: "desc" },
              { submittedAt: "desc" },
              { id: "desc" },
            ],
            select: { id: true },
          })
        : null;
    throw Errors.notFound(
      "Character Project not found",
      approvedSubmission
        ? {
            reason: "customer_publication_prep_missing",
            characterId,
            submissionId: approvedSubmission.id,
            recoveryOperation: "POST /api/v2/admin/characters/:id/project",
          }
        : undefined,
    );
  }
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
  const [characterImageReferenceCount, mediaOperations] = await Promise.all([
    character.imageAsset?.characterId === null
      ? prisma.character.count({ where: { imageAssetId: character.imageAsset.id } })
      : Promise.resolve(0),
    loadCharacterMediaOperationsProjection(characterId),
  ]);
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
  const { visual, qualifiedRoute } = await loadCharacterVisualWorkspace({
    characterId,
    character,
    project,
    serving,
    releases,
    activeLooks,
    characterImageAvailable,
    characterImageGenerationSource,
  });
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
    visual,
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
    releases: characterWorkspaceReleaseProjection({
      releases,
      validationRuns,
      checks,
      monitors,
    }),
    qaRuns: qaRuns.map((run) => characterQaRunSchema.parse({
      ...run,
      checks: run.checks,
      createdAt: run.createdAt.toISOString(),
    })),
    preview: { live, draft, changedFields: previewChangedFields(live, draft) },
    performance,
    portfolio: {
      latestDecision: portfolioItem?.latestDecision ?? null,
      changeMarkers: portfolioItem?.changeMarkers ?? [],
    },
  };
}
