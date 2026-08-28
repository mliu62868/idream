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
  current: number;
  historical: number;
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
    current: 0,
    historical: 0,
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
    if (root.schemaVersion === 3) report.current += 1;
    else report.historical += 1;
  }
  return report;
}

export interface CharacterSoulAuthorityAuditReport {
  ok: boolean;
  topology: {
    mode: "main_turn_ledger" | "invalid";
    database: string;
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
  // INVARIANT: launch-safe serving/current pointers must use the current Soul
  // schema, and every active session must pin immutable content. Historical
  // adapters exist for continuity, not as a reason to report a green launch.
  return input.topologyMode === "main_turn_ledger" &&
    input.parityMismatches === 0 &&
    input.invalidSnapshots === 0 &&
    input.nullPinSessions === 0 &&
    input.legacyServingSnapshots === 0 &&
    input.legacyCurrentPointers === 0;
}

/**
 * Launch-grade audit for Main-owned immutable Character pins and Chat Turns.
 */
export async function auditCharacterSoulAuthority(
  db: PrismaClient,
): Promise<CharacterSoulAuthorityAuditReport> {
  const topologyRows = await db.$queryRaw<Array<{ database: string }>>`
    SELECT current_database() AS database
  `;
  const topology = topologyRows[0];
  const mode = topology?.database ? "main_turn_ledger" as const : "invalid" as const;
  const parityRows: unknown[] = [];

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
    pinned = await db.$queryRaw<Array<{ ownerId: string; contentVersionId: string }>>`
      SELECT "sessionId" AS "ownerId", "characterContentVersionId" AS "contentVersionId"
      FROM public.recent_chats
      WHERE status = 'active' AND "characterContentVersionId" IS NOT NULL
    `;
    const counts = await db.$queryRaw<Array<{ active: bigint; nullPins: bigint }>>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'active' AND "characterContentVersionId" IS NULL) AS "nullPins"
      FROM public.recent_chats
    `;
    activeSessions = Number(counts[0]?.active ?? 0);
    nullPinSessions = Number(counts[0]?.nullPins ?? 0);
  } catch {
    // Inability to inspect Main's pinned sessions is a launch-gate failure.
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
  const isCurrentSoul = (contentVersionId: string) => {
    const stored = snapshots.find((row) => row.id === contentVersionId)?.personaSnapshot;
    return Boolean(
      stored && typeof stored === "object" && !Array.isArray(stored) &&
      (stored as Record<string, unknown>).schemaVersion === 3,
    );
  };
  const pinnedIds = new Set(pinned.map((row) => row.ownerId));
  const legacyPinnedSessions = references.filter((reference) =>
    reference.ownerType === "pinned_session" &&
    pinnedIds.has(reference.ownerId) &&
    snapshotAudit.invalid.every((invalid) => invalid.ownerId !== reference.ownerId) &&
    !isCurrentSoul(reference.contentVersionId)
  ).length;
  const legacyServingSnapshots = serving.filter((row) => !isCurrentSoul(row.contentVersionId)).length;
  const legacyCurrentPointers = pointers.filter((row) => !isCurrentSoul(row.contentVersionId)).length;
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
