import { z } from "zod";
import {
  companionMemoryCutoverProofSchema,
  companionMemoryCutoverSidecarProofSchema,
  type CompanionMemoryCutoverProof,
  type CompanionMemoryCutoverSidecarProof,
} from "@idream/shared/chat/companion-runtime";

export {
  companionMemoryCutoverProofSchema,
  companionMemoryCutoverSidecarProofSchema,
  type CompanionMemoryCutoverProof,
  type CompanionMemoryCutoverSidecarProof,
} from "@idream/shared/chat/companion-runtime";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export interface CompanionLegacyMemorySnapshotEvidence {
  total: number;
  eligibleEntries: number;
  legacySourceChecksum: string;
  importChecksum: string;
}

function companionMemoryCutoverProofFromSidecar(
  value: CompanionMemoryCutoverSidecarProof,
): CompanionMemoryCutoverProof {
  return companionMemoryCutoverProofSchema.parse({
    schemaVersion: 1,
    status: "cutover_ready",
    mode: value.entries === 0 ? "empty" : "imported",
    legacySourceChecksum: value.legacySourceChecksum,
    importChecksum: value.checksum,
    igrepVersion: value.igrepVersion,
    cutoverWorkspaceVersion: value.cutoverWorkspaceVersion,
    workspaceVersion: value.workspaceVersion,
    recallParity: {
      probeSetChecksum: value.recallParity.probeSetChecksum,
      total: value.recallParity.total,
      passed: value.recallParity.passed,
    },
    completedAt: value.completedAt,
  });
}

/**
 * SPEC: a new normal DSH attempt may use igrep as the only recall/write
 * authority only when the current legacy source is bound to the certified
 * sidecar lineage. A truly empty relationship may create that proof online;
 * exclusions still require an explicit operator import decision.
 */
export function resolveCompanionMemoryCutover(input: {
  snapshot: CompanionLegacyMemorySnapshotEvidence;
  chatProof: unknown | null;
  sidecarProof: unknown | null;
}):
  | { action: "admit"; proof: CompanionMemoryCutoverProof }
  | { action: "bootstrap_empty" } {
  const snapshot = z.object({
    total: z.number().int().nonnegative(),
    eligibleEntries: z.number().int().nonnegative(),
    legacySourceChecksum: sha256Schema,
    importChecksum: sha256Schema,
  }).strict().parse(input.snapshot);
  if (snapshot.eligibleEntries > snapshot.total) {
    throw new Error("legacy memory snapshot counts are invalid");
  }

  const chat = input.chatProof === null
    ? null
    : companionMemoryCutoverProofSchema.parse(input.chatProof);
  const sidecar = input.sidecarProof === null
    ? null
    // The import endpoint adds operator-only skipped/written fields to this
    // exact proof wire. Strip only at this internal projection; the HTTP
    // response schemas remain strict shared contracts.
    : companionMemoryCutoverSidecarProofSchema.strip().parse(input.sidecarProof);
  if (!chat && sidecar) {
    if (
      sidecar.legacySourceChecksum === snapshot.legacySourceChecksum
      && sidecar.checksum === snapshot.importChecksum
      && sidecar.entries === snapshot.eligibleEntries
    ) {
      return {
        action: "admit",
        proof: companionMemoryCutoverProofFromSidecar(sidecar),
      };
    }
    if (snapshot.total === 0) return { action: "bootstrap_empty" };
  }
  if (!chat || !sidecar) {
    if (snapshot.total === 0) return { action: "bootstrap_empty" };
    if (snapshot.eligibleEntries === 0) {
      throw new Error(
        "legacy rows require an operator-reviewed empty import before DSH cutover",
      );
    }
    throw new Error("legacy memory import is required before DSH cutover");
  }
  if (chat.legacySourceChecksum !== snapshot.legacySourceChecksum) {
    if (snapshot.total === 0) return { action: "bootstrap_empty" };
    throw new Error("legacy source checksum changed after the cutover proof");
  }
  if (
    sidecar.legacySourceChecksum !== snapshot.legacySourceChecksum
    || chat.importChecksum !== snapshot.importChecksum
    || sidecar.checksum !== snapshot.importChecksum
  ) {
    throw new Error("legacy import checksum does not match current authority");
  }
  if (sidecar.entries !== snapshot.eligibleEntries) {
    throw new Error("legacy import entry count does not match current authority");
  }
  const mode = sidecar.entries === 0 ? "empty" : "imported";
  if (chat.mode !== mode) {
    throw new Error("legacy import mode does not match its certified workspace");
  }
  if (
    chat.cutoverWorkspaceVersion !== sidecar.cutoverWorkspaceVersion
    || chat.recallParity.probeSetChecksum !== sidecar.recallParity.probeSetChecksum
    || chat.recallParity.total !== sidecar.recallParity.total
    || chat.recallParity.passed !== sidecar.recallParity.passed
  ) {
    throw new Error("legacy import workspace lineage or recall parity drifted");
  }
  return {
    action: "admit",
    proof: companionMemoryCutoverProofSchema.parse({
      ...companionMemoryCutoverProofFromSidecar(sidecar),
      schemaVersion: chat.schemaVersion,
    }),
  };
}
