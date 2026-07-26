import type { Prisma } from "@prisma/client";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

export type CharacterIdentityBootstrapAuthority = {
  readonly state: "new" | "recoverable_empty_history" | "blocked_existing_authority";
  readonly allowed: boolean;
  readonly nextVersion: number;
  readonly historyFingerprint: string;
  readonly recoverableProfileIds: readonly string[];
  readonly blockers: readonly string[];
};

export async function loadCharacterIdentityBootstrapAuthority(
  db: Prisma.TransactionClient,
  characterId: string,
): Promise<CharacterIdentityBootstrapAuthority> {
  const [character, projects, profiles, serving] = await Promise.all([
    db.character.findUnique({
      where: { id: characterId },
      select: {
        id: true,
        imageAssetId: true,
        imageAsset: {
          select: {
            id: true,
            deletedAt: true,
            type: true,
            safetyStatus: true,
            characterId: true,
            metadata: true,
          },
        },
      },
    }),
    db.characterProject.findMany({
      where: { characterId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        version: true,
        phase: true,
        draftImageAssetId: true,
        draftAssetPack: true,
      },
    }),
    db.characterVisualProfile.findMany({
      where: { characterId },
      orderBy: [{ version: "asc" }, { id: "asc" }],
      select: {
        id: true,
        version: true,
        status: true,
        evidenceState: true,
        createdFrom: true,
      },
    }),
    db.characterServing.findUnique({
      where: { characterId },
      select: { currentReleaseId: true, scheduledReleaseId: true },
    }),
  ]);
  const profileIds = profiles.map((profile) => profile.id);
  const projectIds = projects.map((project) => project.id);
  const [referenceSetCount, referenceCandidateCount, lookCount, generationJobCount, releaseCount, passedQaCount] =
    await Promise.all([
      db.referenceSetRevision.count({ where: { visualProfileId: { in: profileIds } } }),
      db.referenceCandidate.count({ where: { visualProfileId: { in: profileIds } } }),
      db.characterLook.count({ where: { visualProfileId: { in: profileIds } } }),
      db.generationJob.count({ where: { visualProfileId: { in: profileIds } } }),
      db.characterRelease.count({ where: { projectId: { in: projectIds } } }),
      db.characterQaRun.count({ where: { characterId, status: "passed" } }),
    ]);
  const latestProject = projects[0] ?? null;
  const currentImageOperational = Boolean(
    character?.imageAsset &&
    character.imageAsset.deletedAt === null &&
    character.imageAsset.type === "image" &&
    character.imageAsset.safetyStatus === "passed" &&
    isMediaAssetOperationalForAuthority(character.imageAsset.metadata)
  );
  const currentImageReferenceCount = currentImageOperational && character?.imageAsset?.characterId === null
    ? await db.character.count({ where: { imageAssetId: character.imageAsset.id } })
    : 0;
  const currentImageCanAnchorIdentity = Boolean(
    currentImageOperational &&
    character?.imageAsset &&
    (
      character.imageAsset.characterId === characterId ||
      (character.imageAsset.characterId === null && currentImageReferenceCount === 1)
    )
  );
  const profileSnapshots = profiles.map((profile) => ({ ...profile }));
  const blockers = [
    ...(!character ? ["character_missing"] : []),
    ...(!latestProject ? ["project_missing"] : []),
    ...(latestProject && !["idea", "planned", "producing"].includes(latestProject.phase)
      ? ["project_phase_not_bootstrap_eligible"]
      : []),
    ...(currentImageCanAnchorIdentity ? ["character_image_already_selected"] : []),
    ...(serving?.currentReleaseId || serving?.scheduledReleaseId ? ["serving_release_exists"] : []),
    ...(releaseCount > 0 ? ["release_history_exists"] : []),
    ...(passedQaCount > 0 ? ["passed_qa_history_exists"] : []),
    ...(referenceSetCount > 0 ? ["reference_set_history_exists"] : []),
    ...(referenceCandidateCount > 0 ? ["reference_candidate_history_exists"] : []),
    ...(lookCount > 0 ? ["character_look_history_exists"] : []),
    // 「已有扎实的参考图历史」由上面的 reference_set_history_exists 承担：参考图只存在于
    // active Reference Set 里，有参考图 ⟺ 有 reference set。此处只判断身份记录本身的来源与证据态。
    ...(profileSnapshots.some((profile) =>
      profile.evidenceState !== "candidate" ||
      profile.createdFrom !== "admin_passport_edit"
    ) ? ["grounded_or_unknown_identity_history_exists"] : []),
  ];
  const historyFingerprint = canonicalSha256({
    characterId,
    characterImage: character ? {
      imageAssetId: character.imageAssetId,
      imageAsset: character.imageAsset,
      referenceCount: currentImageReferenceCount,
      canAnchorIdentity: currentImageCanAnchorIdentity,
    } : null,
    projects: projects.map((project) => ({
      id: project.id,
      version: project.version,
      phase: project.phase,
      draftImageAssetId: project.draftImageAssetId,
      draftAssetPack: project.draftAssetPack,
    })),
    profiles: profileSnapshots,
    serving,
    downstream: {
      referenceSetCount,
      referenceCandidateCount,
      lookCount,
      generationJobCount,
      releaseCount,
      passedQaCount,
    },
  });
  const allowed = blockers.length === 0;
  const state = !allowed
    ? "blocked_existing_authority" as const
    : profiles.length === 0
      ? "new" as const
      : "recoverable_empty_history" as const;
  return {
    state,
    allowed,
    nextVersion: Math.max(0, ...profiles.map((profile) => profile.version)) + 1,
    historyFingerprint,
    recoverableProfileIds: state === "recoverable_empty_history" ? profileIds : [],
    blockers: [...new Set(blockers)],
  };
}
