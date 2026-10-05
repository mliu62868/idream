import type { OperationalWorkPreference, Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

type Preference = Pick<OperationalWorkPreference, "actorId" | "sourceType" | "sourceId" | "watching" | "pinned" | "snoozedUntil" | "version" | "updatedAt">;

export function workPreferenceSourceTypes(sourceType: string) {
  if (sourceType === "case" || sourceType === "admin_case") return ["admin_case", "case"];
  if (sourceType === "incident" || sourceType === "ops_incident") return ["ops_incident", "incident"];
  return [sourceType];
}

// The two shipped watch APIs previously wrote different tuples. Existing rows
// converge by updatedAt (canonical wins a tie); only the canonical Today row
// owns pin/snooze. No historical per-field timestamps exist to infer more.
export function normalizeWorkPreferences(rows: readonly Preference[]): Preference[] {
  const groups = new Map<string, Preference[]>();
  for (const row of rows) {
    const sourceType = workPreferenceSourceTypes(row.sourceType)[0]!;
    const key = JSON.stringify([row.actorId, sourceType, row.sourceId]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const sourceType = workPreferenceSourceTypes(group[0]!.sourceType)[0]!;
    const canonical = group.find(row => row.sourceType === sourceType);
    const latest = group.reduce((left, right) => right.updatedAt > left.updatedAt
      || (right.updatedAt.getTime() === left.updatedAt.getTime() && right.sourceType === sourceType) ? right : left);
    return { ...(canonical ?? latest), sourceType, watching: latest.watching, version: Math.max(...group.map(row => row.version)) };
  });
}

export async function updateWorkPreference(tx: Prisma.TransactionClient, input: {
  actorId: string;
  sourceType: string;
  sourceId: string;
  watching?: boolean;
  pinned?: boolean;
  snoozedUntil?: Date | null;
  expectedVersion?: number;
}) {
  const sourceTypes = workPreferenceSourceTypes(input.sourceType);
  const sourceType = sourceTypes[0]!;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.actorId}:${sourceType}:${input.sourceId}`}))`;
  const rows = await tx.operationalWorkPreference.findMany({ where: { actorId: input.actorId, sourceId: input.sourceId, sourceType: { in: sourceTypes } } });
  const before = normalizeWorkPreferences(rows)[0];
  const version = before?.version ?? 0;
  if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
    throw Errors.versionConflict("Today preference version changed", { expectedVersion: input.expectedVersion, currentVersion: version });
  }
  const data = {
    watching: input.watching ?? before?.watching ?? false,
    pinned: input.pinned ?? before?.pinned ?? false,
    snoozedUntil: input.snoozedUntil === undefined ? before?.snoozedUntil ?? null : input.snoozedUntil,
    version: version + 1,
  };
  const canonical = rows.find(row => row.sourceType === sourceType);
  let preference;
  if (canonical) {
    const changed = await tx.operationalWorkPreference.updateMany({ where: { id: canonical.id, version: canonical.version }, data });
    if (changed.count !== 1) throw Errors.versionConflict("Today preference version changed");
    preference = await tx.operationalWorkPreference.findUniqueOrThrow({ where: { id: canonical.id } });
  } else {
    preference = await tx.operationalWorkPreference.create({ data: { actorId: input.actorId, sourceType, sourceId: input.sourceId, ...data } });
  }
  if (sourceTypes.length > 1) {
    await tx.operationalWorkPreference.deleteMany({ where: { actorId: input.actorId, sourceId: input.sourceId, sourceType: { in: sourceTypes.slice(1) } } });
  }
  return { before, preference };
}
