// Canonical dependency truth shared by Admin asset operations and customer Gallery mutations.
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { characterReleasePlacements } from "@/server/modules/admin-v2/characters/character-release-contract";
import { operationalMediaAssetPlacementWhere } from "@/server/modules/admin/shared/metric-data-scope";

export type MediaAssetAuthorityDependency =
  | {
      kind: "character_primary_image";
      characterId: string;
      repairPath: string;
    }
  | {
      kind: "character_project_draft";
      characterId: string;
      projectId: string;
      repairPath: string;
    }
  | {
      kind: "character_visual_identity";
      characterId: string;
      visualProfileId: string;
      repairPath: string;
    }
  | {
      kind: "character_reference_set";
      characterId: string;
      visualProfileId: string;
      referenceSetRevisionId: string;
      repairPath: string;
    }
  | {
      kind: "character_generation_job";
      characterId: string | null;
      generationJobId: string;
      runId: string | null;
      repairPath: string;
    }
  | {
      kind: "character_look";
      characterId: string;
      lookId: string;
      status: string;
      repairPath: string;
    }
  | {
      kind: "creative_run_asset";
      runId: string;
      itemId: string;
      status: string;
      characterId: string | null;
      repairPath: string;
    }
  | {
      kind: "character_release";
      characterId: string;
      releaseId: string;
      releaseState: "current" | "scheduled";
      slot: string;
      repairPath: string;
    }
  | {
      kind: "verified_campaign";
      placementId: string;
      runId: string | null;
      targetId: string;
      repairPath: string;
    }
  | {
      kind: "placement_verification";
      placementId: string;
      runId: string | null;
      targetId: string;
      repairPath: string;
    };

type MediaAssetAuthorityDatabase = Prisma.TransactionClient | typeof prisma;

type CharacterProjectDraftAuthorityRow = {
  id: string;
  characterId: string;
  draftImageAssetId: string | null;
  draftAssetPack: Prisma.JsonValue;
};

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function projectDraftAssetIds(project: {
  draftImageAssetId: string | null;
  draftAssetPack: unknown;
}): string[] {
  const pack = jsonRecord(project.draftAssetPack);
  return [
    ...(project.draftImageAssetId ? [project.draftImageAssetId] : []),
    ...(["character_cover", "character_hero", "character_chat"] as const).flatMap(
      (purpose) => {
        const value = pack[purpose];
        if (typeof value === "string" && value.length > 0) return [value];
        const assetId = jsonRecord(value).assetId;
        return typeof assetId === "string" && assetId.length > 0 ? [assetId] : [];
      },
    ),
  ];
}

export function generationJobReferencedAssetIds(job: {
  referenceAssetIds: unknown;
  controls: unknown;
  referenceManifest: unknown;
}): string[] {
  const controls = jsonRecord(job.controls);
  const visualIdentity = jsonRecord(controls.visualIdentity);
  const sourceImageAssetId = controls.sourceImageAssetId;
  const lookReferenceAssetId = controls.lookReferenceAssetId;
  const manifestAssetIds = Array.isArray(job.referenceManifest)
    ? job.referenceManifest.flatMap((item) => {
        const mediaAssetId = jsonRecord(item).mediaAssetId;
        return typeof mediaAssetId === "string" && mediaAssetId.length > 0
          ? [mediaAssetId]
          : [];
      })
    : [];
  return [
    ...jsonStringArray(job.referenceAssetIds),
    ...jsonStringArray(visualIdentity.anchorAssetIds),
    ...jsonStringArray(visualIdentity.referenceAssetIds),
    ...(typeof sourceImageAssetId === "string" && sourceImageAssetId.length > 0
      ? [sourceImageAssetId]
      : []),
    ...(typeof lookReferenceAssetId === "string" && lookReferenceAssetId.length > 0
      ? [lookReferenceAssetId]
      : []),
    ...manifestAssetIds,
  ];
}

function pushDependency(
  dependenciesByAssetId: Map<string, MediaAssetAuthorityDependency[]>,
  assetId: string,
  dependency: MediaAssetAuthorityDependency,
) {
  dependenciesByAssetId.get(assetId)?.push(dependency);
}

export async function mediaAssetAuthorityDependenciesBatch(
  db: MediaAssetAuthorityDatabase,
  requestedAssetIds: readonly string[],
): Promise<Map<string, MediaAssetAuthorityDependency[]>> {
  const assetIds = [...new Set(
    requestedAssetIds.map((assetId) => assetId.trim()).filter(Boolean),
  )];
  const dependenciesByAssetId = new Map(
    assetIds.map((assetId) => [assetId, [] as MediaAssetAuthorityDependency[]]),
  );
  if (assetIds.length === 0) return dependenciesByAssetId;
  const requestedAssetIdSet = new Set(assetIds);
  const [
    primaryImageCharacters,
    placements,
    draftProjects,
    visualProfiles,
    referenceSnapshots,
    activeCharacterLooks,
    activeGenerationJobs,
    activeCreativeItems,
    servings,
  ] = await Promise.all([
    db.character.findMany({
      where: {
        imageAssetId: { in: assetIds },
        deletedAt: null,
      },
      select: { id: true, imageAssetId: true },
    }),
    db.mediaAssetPlacement.findMany({
      where: operationalMediaAssetPlacementWhere({
        mediaAssetId: { in: assetIds },
        status: { in: ["published", "scheduled"] },
        verificationState: { in: ["pending", "verifying", "passed"] },
      }),
      select: {
        id: true,
        mediaAssetId: true,
        slot: true,
        targetId: true,
        status: true,
        verificationState: true,
        metadata: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    // CharacterProject intentionally has no Prisma Character relation. Keep
    // this as one bounded query, but join raw authority truth so historical
    // active Project rows cannot pin media after their Character was deleted.
    db.$queryRaw<CharacterProjectDraftAuthorityRow[]>(Prisma.sql`
      SELECT
        project."id",
        project."characterId",
        project."draftImageAssetId",
        project."draftAssetPack"
      FROM "character_projects" AS project
      INNER JOIN "characters" AS character
        ON character."id" = project."characterId"
        AND character."deletedAt" IS NULL
      WHERE project."activeKey" IS NOT NULL
        AND project."phase" NOT IN ('inactive', 'retired')
        AND (
          project."draftImageAssetId" IN (${Prisma.join(assetIds)})
          OR project."draftAssetPack" #>> '{character_cover,assetId}'
            IN (${Prisma.join(assetIds)})
          OR project."draftAssetPack" ->> 'character_cover'
            IN (${Prisma.join(assetIds)})
          OR project."draftAssetPack" #>> '{character_hero,assetId}'
            IN (${Prisma.join(assetIds)})
          OR project."draftAssetPack" ->> 'character_hero'
            IN (${Prisma.join(assetIds)})
          OR project."draftAssetPack" #>> '{character_chat,assetId}'
            IN (${Prisma.join(assetIds)})
          OR project."draftAssetPack" ->> 'character_chat'
            IN (${Prisma.join(assetIds)})
        )
    `),
    db.characterVisualProfile.findMany({
      where: {
        status: "active",
        character: { deletedAt: null },
        OR: assetIds.flatMap((assetId) => [
          { anchorAssetIds: { array_contains: [assetId] } },
          { referenceAssetIds: { array_contains: [assetId] } },
        ]),
      },
      select: {
        id: true,
        characterId: true,
        anchorAssetIds: true,
        referenceAssetIds: true,
      },
    }),
    db.characterVisualReferenceSnapshot.findMany({
      where: {
        mediaAssetId: { in: assetIds },
        referenceSetRevision: {
          status: "active",
          visualProfile: {
            status: "active",
            character: { deletedAt: null },
          },
        },
      },
      select: {
        mediaAssetId: true,
        referenceSetRevisionId: true,
        referenceSetRevision: {
          select: {
            visualProfileId: true,
            visualProfile: { select: { characterId: true } },
          },
        },
      },
    }),
    db.characterLook.findMany({
      where: {
        referenceAssetId: { in: assetIds },
        status: { in: ["active", "needs_rebase"] },
        character: { deletedAt: null },
      },
      select: {
        id: true,
        characterId: true,
        referenceAssetId: true,
        status: true,
      },
    }),
    db.generationJob.findMany({
      where: {
        status: {
          in: ["queued", "moderating_input", "running", "moderating_output"],
        },
        OR: assetIds.flatMap((assetId) => [
          { referenceAssetIds: { array_contains: [assetId] } },
          {
            controls: {
              path: ["sourceImageAssetId"],
              equals: assetId,
            },
          },
          {
            controls: {
              path: ["lookReferenceAssetId"],
              equals: assetId,
            },
          },
          {
            controls: {
              path: ["visualIdentity", "anchorAssetIds"],
              array_contains: [assetId],
            },
          },
          {
            controls: {
              path: ["visualIdentity", "referenceAssetIds"],
              array_contains: [assetId],
            },
          },
          {
            referenceManifest: {
              array_contains: [{ mediaAssetId: assetId }],
            },
          },
        ]),
      },
      select: {
        id: true,
        characterId: true,
        referenceAssetIds: true,
        controls: true,
        referenceManifest: true,
        productionItems: {
          take: 1,
          select: { batchId: true },
        },
      },
    }),
    db.contentProductionItem.findMany({
      where: {
        mediaAssetId: { in: assetIds },
        status: { in: ["queued", "generated", "approved"] },
      },
      select: {
        id: true,
        mediaAssetId: true,
        batchId: true,
        status: true,
        batch: {
          select: {
            targetType: true,
            targetId: true,
          },
        },
      },
    }),
    // Serving is deliberately not prefiltered through a JSON path. One
    // relation query loads the only current/scheduled Releases that can be
    // authoritative, then the canonical parser handles both the object
    // manifest and the legacy raw-array form.
    db.characterServing.findMany({
      where: {
        AND: [
          { character: { deletedAt: null } },
          {
            OR: [
              {
                state: { in: ["live", "paused"] },
                currentReleaseId: { not: null },
              },
              { scheduledReleaseId: { not: null } },
            ],
          },
        ],
      },
      select: {
        characterId: true,
        state: true,
        currentReleaseId: true,
        scheduledReleaseId: true,
        currentRelease: {
          select: {
            id: true,
            releasePlacementManifest: true,
          },
        },
        scheduledRelease: {
          select: {
            id: true,
            releasePlacementManifest: true,
          },
        },
      },
    }),
  ]);

  for (const project of draftProjects) {
    for (const assetId of new Set(projectDraftAssetIds(project))) {
      if (!requestedAssetIdSet.has(assetId)) continue;
      pushDependency(dependenciesByAssetId, assetId, {
        kind: "character_project_draft",
        characterId: project.characterId,
        projectId: project.id,
        repairPath: `/admin/characters/${project.characterId}?tab=assets`,
      });
    }
  }
  for (const profile of visualProfiles) {
    for (const assetId of new Set([
      ...jsonStringArray(profile.anchorAssetIds),
      ...jsonStringArray(profile.referenceAssetIds),
    ])) {
      if (!requestedAssetIdSet.has(assetId)) continue;
      pushDependency(dependenciesByAssetId, assetId, {
        kind: "character_visual_identity",
        characterId: profile.characterId,
        visualProfileId: profile.id,
        repairPath: `/admin/characters/${profile.characterId}?tab=visual`,
      });
    }
  }
  for (const snapshot of referenceSnapshots) {
    pushDependency(dependenciesByAssetId, snapshot.mediaAssetId, {
      kind: "character_reference_set",
      characterId: snapshot.referenceSetRevision.visualProfile.characterId,
      visualProfileId: snapshot.referenceSetRevision.visualProfileId,
      referenceSetRevisionId: snapshot.referenceSetRevisionId,
      repairPath: `/admin/characters/${snapshot.referenceSetRevision.visualProfile.characterId}?tab=assets`,
    });
  }
  for (const look of activeCharacterLooks) {
    if (!look.referenceAssetId) continue;
    pushDependency(dependenciesByAssetId, look.referenceAssetId, {
      kind: "character_look",
      characterId: look.characterId,
      lookId: look.id,
      status: look.status,
      repairPath: `/admin/characters/${look.characterId}?tab=visual#character-looks`,
    });
  }
  for (const job of activeGenerationJobs) {
    const runId = job.productionItems[0]?.batchId ?? null;
    for (const assetId of new Set(generationJobReferencedAssetIds(job))) {
      if (!requestedAssetIdSet.has(assetId)) continue;
      pushDependency(dependenciesByAssetId, assetId, {
        kind: "character_generation_job",
        characterId: job.characterId,
        generationJobId: job.id,
        runId,
        repairPath: runId
          ? `/admin/creative/runs/${runId}`
          : job.characterId
            ? `/admin/characters/${job.characterId}?tab=assets`
            : `/admin/ops/jobs?job=${encodeURIComponent(job.id)}`,
      });
    }
  }
  for (const item of activeCreativeItems) {
    if (!item.mediaAssetId) continue;
    pushDependency(dependenciesByAssetId, item.mediaAssetId, {
      kind: "creative_run_asset",
      runId: item.batchId,
      itemId: item.id,
      status: item.status,
      characterId:
        item.batch.targetType === "character"
          ? item.batch.targetId
          : null,
      repairPath: `/admin/creative/runs/${item.batchId}`,
    });
  }

  const releaseDependencyKeys = new Set<string>();
  for (const serving of servings) {
    const servingReleases = [
      ...(
        serving.currentRelease && ["live", "paused"].includes(serving.state)
          ? [{
              release: serving.currentRelease,
              releaseState: "current" as const,
            }]
          : []
      ),
      ...(
        serving.scheduledRelease
          ? [{
              release: serving.scheduledRelease,
              releaseState: "scheduled" as const,
            }]
          : []
      ),
    ];
    for (const { release, releaseState } of servingReleases) {
      for (const placement of characterReleasePlacements(release)) {
        if (!requestedAssetIdSet.has(placement.assetId)) continue;
        const dependencyKey =
          `${placement.assetId}:${releaseState}:${release.id}:${placement.slotKey}`;
        if (releaseDependencyKeys.has(dependencyKey)) continue;
        releaseDependencyKeys.add(dependencyKey);
        pushDependency(dependenciesByAssetId, placement.assetId, {
          kind: "character_release",
          characterId: serving.characterId,
          releaseId: release.id,
          releaseState,
          slot: placement.slotKey,
          repairPath: `/admin/characters/${serving.characterId}?tab=release`,
        });
      }
    }
  }

  for (const placement of placements) {
    const metadata = jsonRecord(placement.metadata);
    const runId = typeof metadata.creativeRunId === "string"
      ? metadata.creativeRunId
      : null;
    pushDependency(dependenciesByAssetId, placement.mediaAssetId, {
      kind:
        placement.status === "published"
          && placement.verificationState === "passed"
          ? "verified_campaign"
          : "placement_verification",
      placementId: placement.id,
      runId,
      targetId: placement.targetId,
      repairPath: runId
        ? `/admin/creative/runs/${runId}`
        : `/admin/content/placements/${placement.id}`,
    });
  }
  // Keep the direct Character pointer visible as an independent dependency,
  // but append it after more specific Release/Project repair workflows so the
  // top-level repairPath remains the action that can actually withdraw a live
  // or staged authority. When it is the only dependency (legacy/private
  // Character), its Assets workspace remains the canonical repair path.
  for (const character of primaryImageCharacters) {
    if (!character.imageAssetId) continue;
    pushDependency(dependenciesByAssetId, character.imageAssetId, {
      kind: "character_primary_image",
      characterId: character.id,
      repairPath: `/admin/characters/${character.id}?tab=assets`,
    });
  }
  return dependenciesByAssetId;
}

export async function mediaAssetAuthorityDependencies(
  db: MediaAssetAuthorityDatabase,
  assetId: string,
): Promise<MediaAssetAuthorityDependency[]> {
  return (await mediaAssetAuthorityDependenciesBatch(db, [assetId])).get(assetId) ?? [];
}
