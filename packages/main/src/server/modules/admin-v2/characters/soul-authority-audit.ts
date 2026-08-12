import { loadCharacterSoulSnapshot } from "@idream/shared";
import type { PrismaClient } from "@prisma/client";

interface SoulReference {
  ownerType: "serving_release" | "character_pointer" | "pinned_session";
  ownerId: string;
  contentVersionId: string;
}

interface SnapshotRow {
  id: string;
  personaSnapshot: unknown;
}

export interface SoulSnapshotAudit {
  referenced: number;
  valid: number;
  v1: number;
  legacy: number;
  invalid: Array<{
    ownerType: SoulReference["ownerType"];
    ownerId: string;
    contentVersionId: string;
    diagnostics: string[];
  }>;
}

export function auditSoulSnapshots(
  references: readonly SoulReference[],
  snapshots: readonly SnapshotRow[],
): SoulSnapshotAudit {
  const byId = new Map(snapshots.map((row) => [row.id, row.personaSnapshot]));
  const report: SoulSnapshotAudit = {
    referenced: references.length,
    valid: 0,
    v1: 0,
    legacy: 0,
    invalid: [],
  };
  for (const reference of references) {
    const stored = byId.get(reference.contentVersionId);
    const loaded = loadCharacterSoulSnapshot(stored);
    if (!loaded.ok) {
      report.invalid.push({
        ...reference,
        diagnostics: loaded.diagnostics.map((item) => `${item.code}:${item.path.join(".")}`),
      });
      continue;
    }
    report.valid += 1;
    const root = stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored as Record<string, unknown>
      : {};
    if (root.schemaVersion === 1) report.v1 += 1;
    else report.legacy += 1;
  }
  return report;
}

export interface CharacterSoulAuthorityAuditReport {
  ok: boolean;
  topology: {
    mode: "same_cluster_views" | "invalid";
    database: string;
    chatDatabase: string;
    requiredViews: Record<string, boolean>;
  };
  readModel: { parityMismatches: number; rows: unknown[] };
  snapshots: SoulSnapshotAudit;
  drain: {
    activeSessions: number;
    nullPinSessions: number;
    legacyPinnedSessions: number;
    legacyServingSnapshots: number;
    legacyCurrentPointers: number;
  };
}

export function characterSoulAuthorityIsLaunchSafe(input: {
  topologyMode: CharacterSoulAuthorityAuditReport["topology"]["mode"];
  parityMismatches: number;
  invalidSnapshots: number;
  nullPinSessions: number;
  legacyServingSnapshots: number;
  legacyCurrentPointers: number;
}) {
  // INTENT: ADR-14 keeps explicit legacy adapters during the migration window.
  // Non-zero drain counts are telemetry, not corruption; inability to inspect
  // them or inability to load an exact referenced snapshot is the blocker.
  return input.topologyMode === "same_cluster_views" &&
    input.parityMismatches === 0 &&
    input.invalidSnapshots === 0 &&
    input.nullPinSessions >= 0 &&
    input.legacyServingSnapshots >= 0 &&
    input.legacyCurrentPointers >= 0;
}

/**
 * Launch-grade audit for the declared same-cluster topology. A future separate
 * Chat database must replace this with durable projection watermarks and ACKs.
 */
export async function auditCharacterSoulAuthority(
  db: PrismaClient,
  chatDb: Pick<PrismaClient, "$queryRaw"> = db,
): Promise<CharacterSoulAuthorityAuditReport> {
  const topologyRows = await db.$queryRaw<Array<{
    database: string;
    characterView: string | null;
    contentView: string | null;
    releaseView: string | null;
  }>>`
    SELECT
      current_database() AS database,
      to_regclass('core.chat_character_view')::text AS "characterView",
      to_regclass('core.chat_character_content_version_view')::text AS "contentView",
      to_regclass('core.chat_character_release_view')::text AS "releaseView"
  `;
  const topology = topologyRows[0];
  const chatTopologyRows = await chatDb.$queryRaw<Array<{ database: string }>>`
    SELECT current_database() AS database
  `;
  const chatDatabase = chatTopologyRows[0]?.database ?? "unknown";
  const requiredViews = {
    chatCharacterView: topology?.characterView === "core.chat_character_view",
    chatCharacterContentVersionView:
      topology?.contentView === "core.chat_character_content_version_view",
    chatCharacterReleaseView:
      topology?.releaseView === "core.chat_character_release_view",
  };
  const mode = Object.values(requiredViews).every(Boolean) &&
      chatDatabase === topology?.database
    ? "same_cluster_views" as const
    : "invalid" as const;

  const parityRows = mode === "same_cluster_views"
    ? await db.$queryRaw<Array<{
        characterId: string;
        expectedContentVersionId: string | null;
        actualContentVersionId: string | null;
        expectedReleaseId: string | null;
        actualReleaseId: string | null;
      }>>`
        SELECT
          c.id AS "characterId",
          COALESCE(cr."characterContentVersionId", c."currentContentVersionId") AS "expectedContentVersionId",
          view.character_content_version_id AS "actualContentVersionId",
          cr.id AS "expectedReleaseId",
          view.character_release_id AS "actualReleaseId"
        FROM public.characters c
        LEFT JOIN public.character_serving serving ON serving."characterId" = c.id
        LEFT JOIN public.character_releases cr ON cr.id = serving."currentReleaseId"
        LEFT JOIN core.chat_character_view view ON view.character_id = c.id
        WHERE c."deletedAt" IS NULL
          AND (
            view.character_id IS NULL
            OR view.character_content_version_id IS DISTINCT FROM COALESCE(cr."characterContentVersionId", c."currentContentVersionId")
            OR view.character_release_id IS DISTINCT FROM cr.id
          )
      `
    : [];

  const serving = await db.$queryRaw<Array<{
    ownerId: string;
    contentVersionId: string;
  }>>`
    SELECT serving."characterId" AS "ownerId", release."characterContentVersionId" AS "contentVersionId"
    FROM public.character_serving serving
    JOIN public.character_releases release ON release.id = serving."currentReleaseId"
    WHERE serving.state = 'live'
  `;
  const pointers = await db.$queryRaw<Array<{
    ownerId: string;
    contentVersionId: string;
  }>>`
    SELECT id AS "ownerId", "currentContentVersionId" AS "contentVersionId"
    FROM public.characters
    WHERE "currentContentVersionId" IS NOT NULL AND "deletedAt" IS NULL
  `;
  let pinned: Array<{ ownerId: string; contentVersionId: string }> = [];
  let activeSessions = 0;
  let nullPinSessions = 0;
  try {
    pinned = await chatDb.$queryRaw<Array<{ ownerId: string; contentVersionId: string }>>`
      SELECT id AS "ownerId", character_content_version_id AS "contentVersionId"
      FROM chat.chat_sessions
      WHERE status = 'active' AND character_content_version_id IS NOT NULL
    `;
    const counts = await chatDb.$queryRaw<Array<{ active: bigint; nullPins: bigint }>>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'active' AND character_content_version_id IS NULL) AS "nullPins"
      FROM chat.chat_sessions
    `;
    activeSessions = Number(counts[0]?.active ?? 0);
    nullPinSessions = Number(counts[0]?.nullPins ?? 0);
  } catch {
    // The declared topology includes chat.* in the same database. Inability to
    // inspect pinned sessions is a launch-gate failure, represented below.
    nullPinSessions = -1;
  }
  const references: SoulReference[] = [
    ...serving.map((row) => ({ ...row, ownerType: "serving_release" as const })),
    ...pointers.map((row) => ({ ...row, ownerType: "character_pointer" as const })),
    ...pinned.map((row) => ({ ...row, ownerType: "pinned_session" as const })),
  ];
  const ids = [...new Set(references.map((row) => row.contentVersionId))];
  const snapshots = ids.length > 0
    ? await db.characterContentVersion.findMany({
        where: { id: { in: ids } },
        select: { id: true, personaSnapshot: true },
      })
    : [];
  const snapshotAudit = auditSoulSnapshots(references, snapshots);
  const isV1 = (contentVersionId: string) => {
    const stored = snapshots.find((row) => row.id === contentVersionId)?.personaSnapshot;
    return Boolean(
      stored && typeof stored === "object" && !Array.isArray(stored) &&
      (stored as Record<string, unknown>).schemaVersion === 1,
    );
  };
  const pinnedIds = new Set(pinned.map((row) => row.ownerId));
  const legacyPinnedSessions = references.filter((reference) =>
    reference.ownerType === "pinned_session" &&
    pinnedIds.has(reference.ownerId) &&
    snapshotAudit.invalid.every((invalid) => invalid.ownerId !== reference.ownerId) &&
    !isV1(reference.contentVersionId)
  ).length;
  const legacyServingSnapshots = serving.filter((row) => !isV1(row.contentVersionId)).length;
  const legacyCurrentPointers = pointers.filter((row) => !isV1(row.contentVersionId)).length;
  const ok = characterSoulAuthorityIsLaunchSafe({
    topologyMode: mode,
    parityMismatches: parityRows.length,
    invalidSnapshots: snapshotAudit.invalid.length,
    nullPinSessions,
    legacyServingSnapshots,
    legacyCurrentPointers,
  });
  return {
    ok,
    topology: {
      mode,
      database: topology?.database ?? "unknown",
      chatDatabase,
      requiredViews,
    },
    readModel: { parityMismatches: parityRows.length, rows: parityRows },
    snapshots: snapshotAudit,
    drain: {
      activeSessions,
      nullPinSessions,
      legacyPinnedSessions,
      legacyServingSnapshots,
      legacyCurrentPointers,
    },
  };
}
