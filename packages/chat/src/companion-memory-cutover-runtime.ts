import type { Prisma } from "../generated/client/client.js";
import { chatFsPaths, readWhole } from "./chat-fs.js";
import { buildCompanionWorkspaceRebuild } from "./companion-memory-projection.js";
import {
  resolveCompanionMemoryCutover,
  type CompanionMemoryCutoverProof,
} from "./companion-memory-cutover.js";
import {
  importLegacyCompanionMemory,
  readCompanionMemoryCutoverProof,
} from "./companion-runtime.js";
import {
  buildLegacyMemoryCandidateSnapshot,
  parseLegacyMemoryFile,
} from "./legacy-memory-import.js";

interface CutoverSidecarConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export async function loadLatestCompanionMemoryCutoverProof(
  tx: Prisma.TransactionClient,
  identity: { userId: string; characterId: string },
): Promise<unknown | null> {
  const rows = await tx.$queryRaw<Array<{ proof: unknown }>>`
    SELECT COALESCE(
      version.runtime_trace #> '{companionWorkspace,memoryCutover}',
      version.runtime_trace #> '{companionRuntime,memoryCutover}'
    ) AS proof
    FROM chat.message_versions AS version
    JOIN chat.messages AS message ON message.id = version.message_id
    JOIN chat.chat_sessions AS session ON session.id = message.session_id
    WHERE session.user_id = ${identity.userId}
      AND session.character_id = ${identity.characterId}
      AND session.deleted_at IS NULL
      AND message.deleted_at IS NULL
      AND version.selected = true
      AND COALESCE(
        version.runtime_trace #> '{companionWorkspace,memoryCutover}',
        version.runtime_trace #> '{companionRuntime,memoryCutover}'
      ) IS NOT NULL
    ORDER BY version.created_at DESC, version.id DESC
    LIMIT 1
  `;
  return rows[0]?.proof ?? null;
}

/**
 * INVARIANT: caller owns the exclusive user lock and has drained file intents.
 * The returned proof binds the current legacy bytes to the current sidecar
 * lineage; a normal DSH claim persists it in the same PG transaction.
 */
export async function ensureCompanionMemoryCutoverTx(input: {
  tx: Prisma.TransactionClient;
  userId: string;
  characterId: string;
  sidecar: CutoverSidecarConfig;
  fetchImpl?: typeof fetch;
}): Promise<CompanionMemoryCutoverProof> {
  const identity = { userId: input.userId, characterId: input.characterId };
  const raw = await readWhole(chatFsPaths.memory(input.userId, input.characterId));
  // Prisma interactive transactions own one pg client; never re-enter it with
  // Promise.all, including through helpers.
  const canonical = await buildCompanionWorkspaceRebuild(input.tx, identity);
  const chatProof = await loadLatestCompanionMemoryCutoverProof(input.tx, identity);
  const snapshot = buildLegacyMemoryCandidateSnapshot({
    ...identity,
    memories: parseLegacyMemoryFile(raw ?? "", input.characterId),
    canonicalMessages: canonical.messages,
  });
  const sidecarProof = await readCompanionMemoryCutoverProof({
    ...input.sidecar,
    ...identity,
    fetchImpl: input.fetchImpl,
  });
  const decision = resolveCompanionMemoryCutover({
    snapshot: {
      total: snapshot.total,
      eligibleEntries: snapshot.entries.length,
      legacySourceChecksum: snapshot.legacySourceChecksum,
      importChecksum: snapshot.importChecksum,
    },
    chatProof,
    sidecarProof,
  });
  if (decision.action === "admit") return decision.proof;

  const imported = await importLegacyCompanionMemory({
    ...input.sidecar,
    request: {
      scope: "relationship",
      ...identity,
      legacySourceChecksum: snapshot.legacySourceChecksum,
      checksum: snapshot.importChecksum,
      entries: [],
      recallProbes: [],
    },
    fetchImpl: input.fetchImpl,
  });
  const certified = resolveCompanionMemoryCutover({
    snapshot: {
      total: snapshot.total,
      eligibleEntries: snapshot.entries.length,
      legacySourceChecksum: snapshot.legacySourceChecksum,
      importChecksum: snapshot.importChecksum,
    },
    chatProof: null,
    sidecarProof: imported,
  });
  if (certified.action !== "admit") {
    throw new Error("empty legacy import did not produce a cutover proof");
  }
  return certified.proof;
}
