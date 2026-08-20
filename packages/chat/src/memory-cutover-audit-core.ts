import { createHash } from "node:crypto";
import { validateHistoricalMemoryCutoverEvidence } from "./companion-memory-cutover.js";

export interface MemoryCutoverAuditCandidate {
  userId: string;
  characterId: string;
  chatProof: unknown;
  sidecarProof: unknown | null;
  probeError?: string;
}

export interface MemoryCutoverAuditRow {
  relationshipKeyHash: string;
  status: "ready" | "missing_sidecar_proof" | "sidecar_unavailable" | "blocked";
  mode: "imported" | "empty" | null;
  entries: number | null;
  cutoverWorkspaceVersion: string | null;
  currentWorkspaceVersion: string | null;
  reason: string | null;
}

export function evaluateMemoryCutoverAuditCandidate(
  candidate: MemoryCutoverAuditCandidate,
): MemoryCutoverAuditRow {
  const base = {
    relationshipKeyHash: createHash("sha256")
      .update(`${candidate.userId}\0${candidate.characterId}`)
      .digest("hex"),
    mode: null,
    entries: null,
    cutoverWorkspaceVersion: null,
    currentWorkspaceVersion: null,
  } as const;
  if (candidate.probeError) {
    return {
      ...base,
      status: "sidecar_unavailable",
      reason: candidate.probeError,
    };
  }
  if (candidate.sidecarProof === null) {
    return {
      ...base,
      status: "missing_sidecar_proof",
      reason: "historical sidecar cutover marker is missing",
    };
  }
  try {
    const evidence = validateHistoricalMemoryCutoverEvidence(candidate);
    return {
      relationshipKeyHash: base.relationshipKeyHash,
      status: "ready",
      mode: evidence.chatProof.mode,
      entries: evidence.sidecarProof.entries,
      cutoverWorkspaceVersion: evidence.sidecarProof.cutoverWorkspaceVersion,
      currentWorkspaceVersion: evidence.sidecarProof.workspaceVersion,
      reason: null,
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
