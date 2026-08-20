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

/**
 * SPEC: Phase 6 never consults migration evidence to admit a new turn. This
 * validator exists only for the read-only operator audit of relationships that
 * were migrated before the legacy authority was removed.
 */
export function validateHistoricalMemoryCutoverEvidence(input: {
  chatProof: unknown;
  sidecarProof: unknown;
}): {
  chatProof: CompanionMemoryCutoverProof;
  sidecarProof: CompanionMemoryCutoverSidecarProof;
} {
  const chat = companionMemoryCutoverProofSchema.parse(input.chatProof);
  const sidecar = companionMemoryCutoverSidecarProofSchema.parse(input.sidecarProof);
  const expectedMode = sidecar.entries === 0 ? "empty" : "imported";
  if (chat.mode !== expectedMode) {
    throw new Error("memory cutover mode does not match the historical sidecar proof");
  }
  if (
    chat.legacySourceChecksum !== sidecar.legacySourceChecksum
    || chat.importChecksum !== sidecar.checksum
    || chat.igrepVersion !== sidecar.igrepVersion
    || chat.cutoverWorkspaceVersion !== sidecar.cutoverWorkspaceVersion
  ) {
    throw new Error("memory cutover proof lineage does not match the sidecar marker");
  }
  if (
    chat.recallParity.probeSetChecksum !== sidecar.recallParity.probeSetChecksum
    || chat.recallParity.total !== sidecar.recallParity.total
    || chat.recallParity.passed !== sidecar.recallParity.passed
  ) {
    throw new Error("memory cutover recall parity evidence drifted");
  }
  return { chatProof: chat, sidecarProof: sidecar };
}
