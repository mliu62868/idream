import { readCompanionMemoryCutoverProof } from "./companion-runtime.js";
import { canonicalCompanionSidecarUrl } from "./companion-runtime-selection.js";
import { chatPrisma, type ChatPrismaClient } from "./db.js";
import {
  evaluateMemoryCutoverAuditCandidate,
  memoryCutoverAuditExitCode,
  memoryCutoverAuditReport,
  type MemoryCutoverAuditRow,
} from "./memory-cutover-audit-core.js";

function auditSidecarConfig(source: NodeJS.ProcessEnv): {
  baseUrl: string;
  token: string;
  timeoutMs: number;
} {
  const token = source.DSH_AGENT_TOKEN?.trim();
  if (!token) throw new Error("DSH_AGENT_TOKEN is required for the cutover audit");
  return {
    baseUrl: canonicalCompanionSidecarUrl(
      source.DSH_AGENT_URL ?? "http://127.0.0.1:3101",
      "DSH_AGENT_URL",
    ),
    token,
    timeoutMs: 10_000,
  };
}

/**
 * SPEC: this is a read-only Phase 5 evidence audit. It enumerates only
 * relationships that already persisted a cutover-ready attempt proof. New
 * Phase 6 relationships legitimately have no migration proof and are omitted.
 */
export async function auditHistoricalMemoryCutover(
  dependencies: {
    prisma?: ChatPrismaClient;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MemoryCutoverAuditRow[]> {
  const prisma = dependencies.prisma ?? chatPrisma;
  const sidecar = auditSidecarConfig(dependencies.env ?? process.env);
  const relationships = await prisma.$queryRaw<Array<{
    userId: string;
    characterId: string;
    chatProof: unknown;
  }>>`
    SELECT DISTINCT ON (session.user_id, session.character_id)
      session.user_id AS "userId",
      session.character_id AS "characterId",
      COALESCE(
        version.runtime_trace #> '{companionWorkspace,memoryCutover}',
        version.runtime_trace #> '{companionRuntime,memoryCutover}'
      ) AS "chatProof"
    FROM chat.message_versions AS version
    JOIN chat.messages AS message ON message.id = version.message_id
    JOIN chat.chat_sessions AS session ON session.id = message.session_id
    WHERE session.deleted_at IS NULL
      AND message.deleted_at IS NULL
      AND version.selected = true
      AND COALESCE(
        version.runtime_trace #> '{companionWorkspace,memoryCutover}',
        version.runtime_trace #> '{companionRuntime,memoryCutover}'
      ) IS NOT NULL
    ORDER BY
      session.user_id,
      session.character_id,
      version.created_at DESC,
      version.id DESC
  `;

  const rows: MemoryCutoverAuditRow[] = [];
  for (const relationship of relationships) {
    let sidecarProof: unknown | null = null;
    let probeError: string | undefined;
    try {
      sidecarProof = await readCompanionMemoryCutoverProof({
        ...sidecar,
        userId: relationship.userId,
        characterId: relationship.characterId,
        fetchImpl: dependencies.fetchImpl,
      });
    } catch {
      probeError = "sidecar proof unavailable";
    }
    rows.push(evaluateMemoryCutoverAuditCandidate({
      ...relationship,
      sidecarProof,
      ...(probeError ? { probeError } : {}),
    }));
  }
  return rows;
}

export async function runMemoryCutoverAuditCli(): Promise<void> {
  try {
    const rows = await auditHistoricalMemoryCutover();
    process.stdout.write(`${JSON.stringify(memoryCutoverAuditReport(rows))}\n`);
    process.exitCode = memoryCutoverAuditExitCode(rows);
  } finally {
    await chatPrisma.$disconnect();
  }
}
