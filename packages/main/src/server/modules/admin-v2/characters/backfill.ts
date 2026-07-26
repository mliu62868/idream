import type { Prisma, PrismaClient } from "@prisma/client";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";

export { characterReleaseSnapshotHash } from "./release-snapshot";

export const CHARACTER_RELEASE_BACKFILL_DOMAIN = "character_release_visual_v1";

type BackfillStatus = "paused" | "completed";

interface BackfillSummary {
  scanned: number;
  applied: number;
  official: number;
  userContentVersions: number;
  liveLegacySnapshots: number;
  legacyIncomplete: number;
  manualReconciliation: number;
}

interface Mismatch {
  readonly characterId: string;
  readonly code: string;
  readonly detail: string;
}

interface CharacterBackfillOptions {
  readonly runId?: string;
  readonly dryRun?: boolean;
  readonly batchSize?: number;
  readonly initialCursor?: string;
  readonly stopAtId?: string;
}

interface CharacterBackfillResult {
  readonly runId: string;
  readonly status: BackfillStatus;
  readonly nextCursor: string | null;
  readonly summary: BackfillSummary;
  readonly report: {
    readonly mismatches: readonly Mismatch[];
    readonly reportHash: string;
  };
}

const EMPTY_SUMMARY: BackfillSummary = {
  scanned: 0,
  applied: 0,
  official: 0,
  userContentVersions: 0,
  liveLegacySnapshots: 0,
  legacyIncomplete: 0,
  manualReconciliation: 0,
};

function record(
  value: unknown,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value.filter((item): item is string => typeof item === "string"),
        ),
      ).sort()
    : [];
}

function summaryOf(value: Prisma.JsonValue): BackfillSummary {
  const input = record(value);
  return {
    scanned: Number(input.scanned ?? 0),
    applied: Number(input.applied ?? 0),
    official: Number(input.official ?? 0),
    userContentVersions: Number(input.userContentVersions ?? 0),
    liveLegacySnapshots: Number(input.liveLegacySnapshots ?? 0),
    legacyIncomplete: Number(input.legacyIncomplete ?? 0),
    manualReconciliation: Number(input.manualReconciliation ?? 0),
  };
}

function contentSnapshot(character: {
  id: string;
  name: string;
  age: number;
  description: string;
  systemPrompt: string | null;
  style: string;
  gender: string;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
  source: string;
  status: string;
}) {
  const advanced = record(character.advancedDetails);
  return {
    persona: {
      name: character.name,
      age: character.age,
      description: character.description,
      systemPrompt: character.systemPrompt,
      personality: advanced.personality ?? null,
    },
    opening: { firstMessage: advanced.firstMessage ?? null },
    appearance: {
      style: character.style,
      gender: character.gender,
      structured: character.appearance,
      visualBrief: advanced.visualBrief ?? null,
    },
  };
}

async function scopedCounts(
  db: PrismaClient,
  cursor: string | null,
  stopAtId: string | null,
) {
  const where = {
    ...(cursor
      ? { id: { gt: cursor, ...(stopAtId ? { lte: stopAtId } : {}) } }
      : stopAtId
        ? { id: { lte: stopAtId } }
        : {}),
  };
  const [characters, official, publicOfficial] = await Promise.all([
    db.character.count({ where }),
    db.character.count({ where: { ...where, source: "official" } }),
    db.character.count({
      where: {
        ...where,
        source: "official",
        status: "approved",
        visibility: "public",
      },
    }),
  ]);
  return { characters, official, publicOfficial };
}

async function ensureContentVersion(
  tx: Prisma.TransactionClient,
  character: Parameters<typeof contentSnapshot>[0],
) {
  const snapshot = contentSnapshot(character);
  const contentHash = canonicalSha256(snapshot);
  const existing = await tx.characterContentVersion.findUnique({
    where: {
      characterId_contentHash: { characterId: character.id, contentHash },
    },
  });
  if (existing) return existing;
  const latest = await tx.characterContentVersion.aggregate({
    where: { characterId: character.id },
    _max: { version: true },
  });
  return tx.characterContentVersion.create({
    data: {
      id: `legacy-content:${character.id}:${contentHash.slice(0, 16)}`,
      characterId: character.id,
      version: (latest._max.version ?? 0) + 1,
      contentHash,
      personaSnapshot: toInputJson(snapshot.persona),
      openingSnapshot: toInputJson(snapshot.opening),
      appearanceSnapshot: toInputJson(snapshot.appearance),
      sourceType: "legacy_cutover_snapshot",
      sourceId: character.id,
    },
  });
}

async function ensureProjectAndRevision(
  tx: Prisma.TransactionClient,
  character: Parameters<typeof contentSnapshot>[0],
  contentVersionId: string,
) {
  const projectId = `legacy-project:${character.id}`;
  const project = await tx.characterProject.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      characterId: character.id,
      phase:
        character.source === "official" && character.status === "approved"
          ? "live_management"
          : "idea",
      audience: { state: "unavailable", source: "legacy_backfill" },
      successCriteria: [],
      activeKey: `official:${character.id}`,
    },
    update: {},
  });
  const revisionId = `legacy-revision:${character.id}`;
  const revision = await tx.characterRevision.upsert({
    where: { id: revisionId },
    create: {
      id: revisionId,
      projectId: project.id,
      revision: 1,
      characterContentVersionId: contentVersionId,
      projectSnapshot: {
        source: "legacy_backfill",
        audience: { state: "unavailable" },
        successCriteria: [],
      },
    },
    update: {},
  });
  return { project, revision };
}

async function backfillVisualIdentity(
  tx: Prisma.TransactionClient,
  characterId: string,
) {
  const profile = await tx.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if (!profile) return { profile: null, referenceSet: null };

  const immutableHash = characterVisualProfileSnapshotHash(profile);
  if (profile.immutableHash === null) {
    await tx.characterVisualProfile.update({
      where: { id: profile.id },
      data: { immutableHash, evidenceState: "legacy_candidate" },
    });
  }
  // 这里读 anchorAssetIds 是本函数的**输入**：backfill 的职责就是给缺 active Reference Set 的
  // 老 profile 重建参考集，而候选图池是此时唯一可信的线索。参考集的影子副本已随归一删除。
  const proposedIds = Array.from(new Set(stringArray(profile.anchorAssetIds)));
  const assets = proposedIds.length
    ? await tx.mediaAsset.findMany({
        where: {
          id: { in: proposedIds },
          characterId,
          deletedAt: null,
          type: "image",
          safetyStatus: "passed",
        },
        select: { id: true, storageKey: true, url: true, metadata: true },
        orderBy: { id: "asc" },
      })
    : [];
  const operationalAssets = assets.filter((asset) =>
    isMediaAssetOperationalForAuthority(asset.metadata) &&
    hasHydratableMediaBlobAuthority(asset)
  );
  const available = new Set(operationalAssets.map((item) => item.id));
  for (const mediaAssetId of proposedIds) {
    if (!available.has(mediaAssetId)) continue;
    await tx.referenceCandidate.upsert({
      where: {
        visualProfileId_mediaAssetId: {
          visualProfileId: profile.id,
          mediaAssetId,
        },
      },
      create: {
        visualProfileId: profile.id,
        mediaAssetId,
        source: "legacy_visual_backfill",
        status: "candidate",
      },
      update: {},
    });
  }

  let referenceSet = await tx.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  });
  if (referenceSet && referenceSet.references.length === 0) referenceSet = null;
  if (!referenceSet && operationalAssets.length > 0) {
    const latest = await tx.referenceSetRevision.aggregate({
      where: { visualProfileId: profile.id },
      _max: { revision: true },
    });
    const revision = (latest._max.revision ?? 0) + 1;
    await tx.referenceSetRevision.updateMany({
      where: { visualProfileId: profile.id, status: "active" },
      data: { status: "superseded" },
    });
    const createdReferenceSet = await tx.referenceSetRevision.create({
      data: {
        visualProfileId: profile.id,
        revision,
        status: "active",
        selectorVersion: "legacy-backfill-v1",
        createdFrom: "legacy_visual_backfill",
      },
    });
    await tx.characterVisualReferenceSnapshot.createMany({
      data: operationalAssets.map((asset, position) => ({
        referenceSetRevisionId: createdReferenceSet.id,
        mediaAssetId: asset.id,
        position,
        role: position === 0 ? "primary_face" : "identity_reference",
        weight: position === 0 ? 1 : 0.75,
        selectorVersion: "legacy-backfill-v1",
        selectionReason: "historical_profile_reference_snapshot",
      })),
    });
    referenceSet = await tx.referenceSetRevision.findUniqueOrThrow({
      where: { id: createdReferenceSet.id },
      include: { references: { orderBy: { position: "asc" } } },
    });
  }
  if (referenceSet && referenceSet.snapshotHash === null) {
    const snapshotHash = referenceSetSnapshotHash(referenceSet);
    referenceSet = await tx.referenceSetRevision.update({
      where: { id: referenceSet.id },
      data: { snapshotHash },
      include: { references: { orderBy: { position: "asc" } } },
    });
  }
  return { profile: { ...profile, immutableHash }, referenceSet };
}

async function applyCharacter(
  tx: Prisma.TransactionClient,
  character: Awaited<ReturnType<PrismaClient["character"]["findFirstOrThrow"]>>,
) {
  const content = await ensureContentVersion(tx, character);
  if (character.source !== "official") {
    return {
      classification: "user_content_version",
      action: "content_version_created_or_reused",
      legacyIncomplete: false,
      manualReconciliation: false,
      liveLegacySnapshot: false,
      after: { contentVersionId: content.id },
      mismatches: [] as Mismatch[],
    };
  }

  const { project, revision } = await ensureProjectAndRevision(
    tx,
    character,
    content.id,
  );
  const visual = await backfillVisualIdentity(tx, character.id);
  const isLive =
    character.status === "approved" && character.visibility === "public";
  const isAmbiguous =
    character.visibility === "private" &&
    ["approved", "archived"].includes(character.status);
  let releaseId: string | null = null;
  const mismatches: Mismatch[] = [];

  if (isLive) {
    const generationProvenance = {
      source: "legacy_backfill",
      routeQualification: "unavailable",
      characterQa: "unavailable",
    };
    const releasePlacementManifest = { state: "unavailable", placements: [] };
    const snapshotHash = characterReleaseSnapshotHash({
      projectId: project.id,
      revisionId: revision.id,
      characterContentVersionId: content.id,
      visualProfileId: visual.profile?.id ?? null,
      visualProfileVersion: visual.profile?.version ?? null,
      referenceSetRevisionId: visual.referenceSet?.id ?? null,
      generationProvenance,
      releasePlacementManifest,
    });
    const audit = await tx.adminAuditLog.findFirst({
      where: {
        targetType: "character",
        targetId: character.id,
        action: "content.official.publish",
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const release = await tx.characterRelease.upsert({
      where: { id: `legacy-release:${character.id}` },
      create: {
        id: `legacy-release:${character.id}`,
        projectId: project.id,
        revisionId: revision.id,
        characterContentVersionId: content.id,
        visualProfileId: visual.profile?.id ?? null,
        visualProfileVersion: visual.profile?.version ?? null,
        referenceSetRevisionId: visual.referenceSet?.id ?? null,
        generationProvenance: toInputJson(generationProvenance),
        releasePlacementManifest: toInputJson(releasePlacementManifest),
        snapshotHash,
        readiness: "blocked",
        legacy: true,
        status: "published",
        publishedAt: audit?.createdAt ?? null,
      },
      update: {},
    });
    releaseId = release.id;
    await tx.characterServing.upsert({
      where: { characterId: character.id },
      create: {
        characterId: character.id,
        currentReleaseId: release.id,
        state: "live",
      },
      update: {},
    });
    if (!visual.profile || !visual.referenceSet) {
      mismatches.push({
        characterId: character.id,
        code: "live_release_visual_incomplete",
        detail:
          "Historical live release lacks an exact Visual Identity or ReferenceSetRevision.",
      });
    }
    mismatches.push({
      characterId: character.id,
      code: "live_release_route_unqualified",
      detail:
        "No historical eval matrix proves a qualified default generation route.",
    });
  } else {
    await tx.characterServing.upsert({
      where: { characterId: character.id },
      create: { characterId: character.id, state: "inactive" },
      update: {},
    });
  }

  return {
    classification: isLive
      ? "legacy_live_incomplete"
      : isAmbiguous
        ? "manual_reconciliation"
        : "official_not_live",
    action: isLive
      ? "legacy_release_and_serving_created_or_reused"
      : "project_revision_serving_created_or_reused",
    legacyIncomplete: isLive,
    manualReconciliation: isAmbiguous,
    liveLegacySnapshot: isLive,
    after: {
      contentVersionId: content.id,
      projectId: project.id,
      revisionId: revision.id,
      releaseId,
      servingState: isLive ? "live" : "inactive",
      visualProfileId: visual.profile?.id ?? null,
      referenceSetRevisionId: visual.referenceSet?.id ?? null,
    },
    mismatches,
  };
}

function predictedCharacter(character: {
  id: string;
  source: string;
  status: string;
  visibility: string;
  visualProfiles: readonly {
    id: string;
    anchorAssetIds: Prisma.JsonValue;
  }[];
}) {
  const isLive =
    character.source === "official" &&
    character.status === "approved" &&
    character.visibility === "public";
  const manual =
    character.source === "official" &&
    character.visibility === "private" &&
    ["approved", "archived"].includes(character.status);
  return {
    classification:
      character.source !== "official"
        ? "user_content_version"
        : isLive
          ? "legacy_live_incomplete"
          : manual
            ? "manual_reconciliation"
            : "official_not_live",
    action: "dry_run_only",
    legacyIncomplete: isLive,
    manualReconciliation: manual,
    liveLegacySnapshot: isLive,
    after: {
      wouldCreateContentVersion: true,
      wouldCreateOfficialAuthority: character.source === "official",
    },
    mismatches: isLive
      ? ([
          {
            characterId: character.id,
            code: "live_release_route_unqualified",
            detail:
              "No historical eval matrix can be inferred from legacy scores.",
          },
        ] satisfies Mismatch[])
      : ([] as Mismatch[]),
  };
}

async function buildReconciliationReport(
  db: PrismaClient,
  initialCursor: string | null,
  stopAtId: string | null,
) {
  const characters = await db.character.findMany({
    where: {
      source: "official",
      ...(initialCursor
        ? { id: { gt: initialCursor, ...(stopAtId ? { lte: stopAtId } : {}) } }
        : stopAtId
          ? { id: { lte: stopAtId } }
          : {}),
    },
    select: { id: true, status: true, visibility: true },
    orderBy: { id: "asc" },
  });
  const mismatches: Mismatch[] = [];
  for (const character of characters) {
    const serving = await db.characterServing.findUnique({
      where: { characterId: character.id },
    });
    if (!serving) {
      mismatches.push({
        characterId: character.id,
        code: "official_serving_missing",
        detail: "Official Character has no CharacterServing row.",
      });
      continue;
    }
    if (character.status !== "approved" || character.visibility !== "public")
      continue;
    if (!serving.currentReleaseId) {
      mismatches.push({
        characterId: character.id,
        code: "public_current_release_missing",
        detail: "Public official Character has no current Release pointer.",
      });
      continue;
    }
    const release = await db.characterRelease.findUnique({
      where: { id: serving.currentReleaseId },
    });
    if (!release) {
      mismatches.push({
        characterId: character.id,
        code: "current_release_missing",
        detail: "Serving pointer targets a missing Release.",
      });
      continue;
    }
    const project = await db.characterProject.findUnique({
      where: { id: release.projectId },
    });
    if (project?.characterId !== character.id) {
      mismatches.push({
        characterId: character.id,
        code: "cross_character_serving_pointer",
        detail: "Serving pointer targets another Character's Release.",
      });
    }
    if (
      !release.visualProfileId ||
      !release.visualProfileVersion ||
      !release.referenceSetRevisionId
    ) {
      mismatches.push({
        characterId: character.id,
        code: "live_release_visual_incomplete",
        detail:
          "Current Release lacks an exact Identity version or ReferenceSetRevision.",
      });
    }
    const provenance = record(release.generationProvenance);
    const requiredRoute = record(provenance.requiredReleaseRoute);
    const routeFingerprint = typeof requiredRoute.routeFingerprint === "string"
      ? requiredRoute.routeFingerprint
      : provenance.routeFingerprint;
    if (typeof routeFingerprint !== "string") {
      mismatches.push({
        characterId: character.id,
        code: "live_release_route_unqualified",
        detail: "Current Release has no exact qualified route fingerprint.",
      });
    } else {
      const qualified = await db.generationRouteQualification.findFirst({
        where: {
          routeFingerprint,
          result: "qualified",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (!qualified)
        mismatches.push({
          characterId: character.id,
          code: "live_release_route_unqualified",
          detail: "Pinned generation route is not currently qualified.",
        });
    }
  }
  const reportBody = { domain: CHARACTER_RELEASE_BACKFILL_DOMAIN, mismatches };
  return { ...reportBody, reportHash: canonicalSha256(reportBody) };
}

export async function runCharacterReleaseBackfillBatch(
  db: PrismaClient,
  options: CharacterBackfillOptions,
): Promise<CharacterBackfillResult> {
  let run = options.runId
    ? await db.adminBackfillRun.findUnique({ where: { id: options.runId } })
    : null;
  if (options.runId && !run)
    throw new Error(`Backfill run ${options.runId} was not found`);
  if (run?.status === "completed") {
    const persisted = record(run.report);
    return {
      runId: run.id,
      status: "completed",
      nextCursor: null,
      summary: summaryOf(run.summary),
      report: {
        mismatches: Array.isArray(persisted.mismatches)
          ? (persisted.mismatches as unknown as Mismatch[])
          : [],
        reportHash: run.reportHash ?? "",
      },
    };
  }

  if (!run) {
    const dryRun = options.dryRun ?? true;
    const batchSize = Math.min(1_000, Math.max(1, options.batchSize ?? 100));
    const beforeCounts = await scopedCounts(
      db,
      options.initialCursor ?? null,
      options.stopAtId ?? null,
    );
    run = await db.adminBackfillRun.create({
      data: {
        domain: CHARACTER_RELEASE_BACKFILL_DOMAIN,
        mode: dryRun ? "dry_run" : "apply",
        status: "running",
        cursor: options.initialCursor ?? null,
        stopAtId: options.stopAtId ?? null,
        batchSize,
        optionsHash: canonicalSha256({
          dryRun,
          batchSize,
          initialCursor: options.initialCursor ?? null,
          stopAtId: options.stopAtId ?? null,
        }),
        before: toInputJson({
          ...beforeCounts,
          initialCursor: options.initialCursor ?? null,
        }),
        after: toInputJson({}),
        summary: toInputJson(EMPTY_SUMMARY),
      },
    });
  }

  const dryRun = run.mode === "dry_run";
  const initialCursor = record(run.before).initialCursor;
  const where = run.cursor
    ? { id: { gt: run.cursor, ...(run.stopAtId ? { lte: run.stopAtId } : {}) } }
    : run.stopAtId
      ? { id: { lte: run.stopAtId } }
      : {};
  const candidates = await db.character.findMany({
    where,
    include: {
      visualProfiles: {
        where: { status: "active" },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
    orderBy: { id: "asc" },
    take: run.batchSize + 1,
  });
  const batch = candidates.slice(0, run.batchSize);
  const hasMore = candidates.length > batch.length;
  const summary = summaryOf(run.summary);

  for (const character of batch) {
    const before = {
      source: character.source,
      status: character.status,
      visibility: character.visibility,
      hasActiveVisualProfile: character.visualProfiles.length > 0,
    };
    const outcome = dryRun
      ? predictedCharacter(character)
      : await db.$transaction((tx) => applyCharacter(tx, character));
    summary.scanned += 1;
    summary.applied += dryRun ? 0 : 1;
    summary.official += character.source === "official" ? 1 : 0;
    summary.userContentVersions += character.source === "official" ? 0 : 1;
    summary.liveLegacySnapshots += outcome.liveLegacySnapshot ? 1 : 0;
    summary.legacyIncomplete += outcome.legacyIncomplete ? 1 : 0;
    summary.manualReconciliation += outcome.manualReconciliation ? 1 : 0;
    const itemBody = {
      classification: outcome.classification,
      action: outcome.action,
      before,
      after: outcome.after,
      mismatches: outcome.mismatches,
      applied: !dryRun,
    };
    await db.adminBackfillItem.upsert({
      where: {
        runId_entityType_entityId: {
          runId: run.id,
          entityType: "character",
          entityId: character.id,
        },
      },
      create: {
        runId: run.id,
        entityType: "character",
        entityId: character.id,
        classification: outcome.classification,
        action: outcome.action,
        before: toInputJson(before),
        after: toInputJson(outcome.after),
        mismatches: toInputJson(outcome.mismatches),
        checksum: canonicalSha256(itemBody),
        applied: !dryRun,
      },
      update: {},
    });
  }

  const nextCursor = batch.at(-1)?.id ?? run.cursor;
  if (hasMore) {
    await db.adminBackfillRun.update({
      where: { id: run.id },
      data: {
        status: "paused",
        cursor: nextCursor,
        summary: toInputJson(summary),
      },
    });
    return {
      runId: run.id,
      status: "paused",
      nextCursor: nextCursor ?? null,
      summary,
      report: { mismatches: [], reportHash: "" },
    };
  }

  const start =
    typeof initialCursor === "string"
      ? initialCursor
      : (options.initialCursor ?? null);
  const report = dryRun
    ? {
        domain: CHARACTER_RELEASE_BACKFILL_DOMAIN,
        mismatches: (
          await db.adminBackfillItem.findMany({
            where: { runId: run.id },
            select: { mismatches: true },
          })
        ).flatMap((item) =>
          Array.isArray(item.mismatches)
            ? (item.mismatches as unknown as Mismatch[])
            : [],
        ),
        reportHash: "",
      }
    : await buildReconciliationReport(db, start, run.stopAtId);
  const reportBody = { domain: report.domain, mismatches: report.mismatches };
  const reportHash = report.reportHash || canonicalSha256(reportBody);
  const after = await scopedCounts(db, start, run.stopAtId);
  await db.adminBackfillRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      cursor: nextCursor,
      summary: toInputJson(summary),
      after: toInputJson(after),
      report: toInputJson(reportBody),
      reportHash,
      finishedAt: new Date(),
    },
  });
  return {
    runId: run.id,
    status: "completed",
    nextCursor: null,
    summary,
    report: { mismatches: report.mismatches, reportHash },
  };
}
