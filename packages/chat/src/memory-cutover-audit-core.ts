import { createHash } from "node:crypto";
import {
  resolveCompanionMemoryCutover,
  type CompanionLegacyMemorySnapshotEvidence,
} from "./companion-memory-cutover.js";

export interface MemoryCutoverAuditCandidate {
  userId: string;
  characterId: string;
  snapshot: CompanionLegacyMemorySnapshotEvidence;
  excluded: Record<string, number>;
  chatProof: unknown | null;
  sidecarProof: unknown | null;
  snapshotStable: boolean;
  probeError?: string;
}

export interface MemoryCutoverAuditRow {
  relationshipKeyHash: string;
  total: number;
  eligibleEntries: number;
  excluded: Record<string, number>;
  legacySourceChecksum: string;
  importChecksum: string;
  status: "ready" | "empty_unproven" | "blocked" | "snapshot_raced" | "sidecar_unavailable";
  reason: string | null;
}

export function evaluateMemoryCutoverAuditCandidate(
  candidate: MemoryCutoverAuditCandidate,
): MemoryCutoverAuditRow {
  const base = {
    relationshipKeyHash: createHash("sha256")
      .update(`${candidate.userId}\0${candidate.characterId}`)
      .digest("hex"),
    total: candidate.snapshot.total,
    eligibleEntries: candidate.snapshot.eligibleEntries,
    excluded: candidate.excluded,
    legacySourceChecksum: candidate.snapshot.legacySourceChecksum,
    importChecksum: candidate.snapshot.importChecksum,
  };
  if (!candidate.snapshotStable) {
    return { ...base, status: "snapshot_raced", reason: "legacy source changed during audit" };
  }
  if (candidate.probeError) {
    return { ...base, status: "sidecar_unavailable", reason: candidate.probeError };
  }
  try {
    const decision = resolveCompanionMemoryCutover(candidate);
    return decision.action === "admit"
      ? { ...base, status: "ready", reason: null }
      : {
          ...base,
          status: "empty_unproven",
          reason: "audited empty cutover proof has not been created",
        };
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function memoryCutoverAuditReport(rows: readonly MemoryCutoverAuditRow[]): {
  schemaVersion: 1;
  generatedAt: string;
  summary: { relationships: number; ready: number; blocked: number };
  relationships: MemoryCutoverAuditRow[];
} {
  const ready = rows.filter((row) => row.status === "ready").length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: { relationships: rows.length, ready, blocked: rows.length - ready },
    relationships: [...rows],
  };
}

export function memoryCutoverAuditExitCode(rows: readonly MemoryCutoverAuditRow[]): 0 | 1 {
  return rows.every((row) => row.status === "ready") ? 0 : 1;
}
