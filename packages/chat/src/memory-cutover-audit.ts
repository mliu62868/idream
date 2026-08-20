import path from "node:path";
import { listPrefix, readWhole } from "./chat-fs.js";
import { buildCompanionWorkspaceRebuild } from "./companion-memory-projection.js";
import { readCompanionMemoryCutoverProof } from "./companion-runtime.js";
import { canonicalCompanionSidecarUrl } from "./companion-runtime-selection.js";
import { chatPrisma, type ChatPrismaClient } from "./db.js";
import {
  buildLegacyMemoryCandidateSnapshot,
  parseLegacyMemoryFile,
} from "./legacy-memory-import.js";
import { loadLatestCompanionMemoryCutoverProof } from "./companion-memory-cutover-runtime.js";
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

export async function auditLegacyMemoryCutover(
  dependencies: {
    prisma?: ChatPrismaClient;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    listFiles?: typeof listPrefix;
    readFile?: typeof readWhole;
  } = {},
): Promise<MemoryCutoverAuditRow[]> {
  const prisma = dependencies.prisma ?? chatPrisma;
  const listFiles = dependencies.listFiles ?? listPrefix;
  const readFile = dependencies.readFile ?? readWhole;
  const sidecar = auditSidecarConfig(dependencies.env ?? process.env);
  const relationships = new Map<string, { userId: string; characterId: string }>();
  for (const relative of await listFiles(["mem"])) {
    const segments = relative.split(path.sep);
    if (
      segments.length !== 4
      || segments[0] !== "mem"
      || segments[3] !== "memory.md"
      || segments[2] === "global"
    ) continue;
    const identity = { userId: segments[1]!, characterId: segments[2]! };
    relationships.set(`${identity.userId}\0${identity.characterId}`, identity);
  }

  const rows: MemoryCutoverAuditRow[] = [];
  for (const identity of relationships.values()) {
    const memoryPath = ["mem", identity.userId, identity.characterId, "memory.md"];
    const before = await readFile(memoryPath) ?? "";
    const authority = await prisma.$transaction(async (tx) => {
      const canonical = await buildCompanionWorkspaceRebuild(tx, identity);
      const chatProof = await loadLatestCompanionMemoryCutoverProof(tx, identity);
      return { canonical, chatProof };
    }, { timeout: 30_000 });
    const snapshot = buildLegacyMemoryCandidateSnapshot({
      ...identity,
      memories: parseLegacyMemoryFile(before, identity.characterId),
      canonicalMessages: authority.canonical.messages,
    });
    let sidecarProof: unknown | null = null;
    let probeError: string | undefined;
    try {
      sidecarProof = await readCompanionMemoryCutoverProof({
        ...sidecar,
        ...identity,
        fetchImpl: dependencies.fetchImpl,
      });
    } catch {
      probeError = "sidecar proof unavailable";
    }
    const after = await readFile(memoryPath) ?? "";
    rows.push(evaluateMemoryCutoverAuditCandidate({
      ...identity,
      snapshot: {
        total: snapshot.total,
        eligibleEntries: snapshot.entries.length,
        legacySourceChecksum: snapshot.legacySourceChecksum,
        importChecksum: snapshot.importChecksum,
      },
      excluded: { ...snapshot.excluded },
      chatProof: authority.chatProof,
      sidecarProof,
      snapshotStable: before === after,
      ...(probeError ? { probeError } : {}),
    }));
  }
  return rows;
}

export async function runMemoryCutoverAuditCli(): Promise<void> {
  try {
    const rows = await auditLegacyMemoryCutover();
    process.stdout.write(`${JSON.stringify(memoryCutoverAuditReport(rows))}\n`);
    process.exitCode = memoryCutoverAuditExitCode(rows);
  } finally {
    await chatPrisma.$disconnect();
  }
}
