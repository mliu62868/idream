// SPEC: ADR-19 §11.2 imports one legacy relationship at a time. PG canonical
// turns decide eligibility; memory.md is only a candidate source.
// INVARIANT: apply runs under the shared user authority lock, so edit/delete
// projection cannot invalidate source evidence between planning and promotion.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  companionLegacyMemoryImportSchema,
  type CompanionLegacyMemoryImport,
  type CompanionLegacyMemoryImportEntry,
  type CompanionWorkspaceRebuildMessage,
} from "@idream/shared/chat/companion-runtime";
import { chatFsPaths, readWhole } from "./chat-fs.js";
import {
  buildCompanionWorkspaceRebuild,
} from "./companion-memory-projection.js";
import {
  importLegacyCompanionMemory,
} from "./companion-runtime.js";
import {
  chatPrisma,
  chatProjectorPrisma,
  type ChatPrismaClient,
} from "./db.js";
import { withReadableChatFileSnapshot } from "./file-mutations.js";
import { parseLine, type MemoryItem } from "./memories.js";

export interface LegacyMemoryImportExclusions {
  boundary: number;
  nonCharacter: number;
  withoutSource: number;
  untraceableSource: number;
  duplicateId: number;
}

export interface LegacyMemoryImportPlan {
  total: number;
  excluded: LegacyMemoryImportExclusions;
  request: CompanionLegacyMemoryImport;
}

export interface LegacyMemoryImportMarker {
  checksum: string;
  igrepVersion: string;
  completedAt: string;
}

export function buildLegacyMemoryImportPlan(input: {
  userId: string;
  characterId: string;
  memories: readonly MemoryItem[];
  canonicalMessages: readonly CompanionWorkspaceRebuildMessage[];
}): LegacyMemoryImportPlan {
  const canonicalIds = new Set(input.canonicalMessages.map((message) => message.id));
  const counts = new Map<string, number>();
  for (const memory of input.memories) {
    counts.set(memory.id, (counts.get(memory.id) ?? 0) + 1);
  }
  const excluded: LegacyMemoryImportExclusions = {
    boundary: 0,
    nonCharacter: 0,
    withoutSource: 0,
    untraceableSource: 0,
    duplicateId: 0,
  };
  const entries: CompanionLegacyMemoryImportEntry[] = [];
  for (const memory of input.memories) {
    if ((counts.get(memory.id) ?? 0) > 1) {
      excluded.duplicateId += 1;
      continue;
    }
    if (memory.characterId !== input.characterId) {
      excluded.nonCharacter += 1;
      continue;
    }
    if (memory.type.toLowerCase() === "boundary") {
      excluded.boundary += 1;
      continue;
    }
    const sourceMessageIds = [...new Set(memory.sourceMessageIds)].sort();
    if (sourceMessageIds.length === 0) {
      excluded.withoutSource += 1;
      continue;
    }
    if (sourceMessageIds.some((id) => !canonicalIds.has(id))) {
      excluded.untraceableSource += 1;
      continue;
    }
    entries.push({
      legacyMemoryId: memory.id,
      type: memory.type,
      text: memory.text,
      sourceMessageIds,
    });
  }
  const checksum = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return {
    total: input.memories.length,
    excluded,
    request: companionLegacyMemoryImportSchema.parse({
      scope: "relationship",
      userId: input.userId,
      characterId: input.characterId,
      checksum,
      entries,
    }),
  };
}

function parseLegacyMemoryFile(raw: string, characterId: string): MemoryItem[] {
  const memories: MemoryItem[] = [];
  for (const [lineNo, line] of raw.split("\n").entries()) {
    const parsed = parseLine(characterId, line, lineNo);
    if (!parsed) continue;
    const { lineNo: _lineNo, ...memory } = parsed;
    void _lineNo;
    memories.push(memory);
  }
  return memories;
}

interface LegacyMemoryImportSidecarConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

function sidecarConfig(source: NodeJS.ProcessEnv): LegacyMemoryImportSidecarConfig {
  const token = source.DSH_AGENT_TOKEN?.trim();
  if (!token) throw new Error("DSH_AGENT_TOKEN is required to apply a legacy memory import");
  const parsedUrl = new URL(source.DSH_AGENT_URL ?? "http://127.0.0.1:3101");
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("DSH_AGENT_URL must use http or https");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("DSH_AGENT_URL must not contain credentials, query, or fragment");
  }
  const rawTimeout = source.DSH_AGENT_DEADLINE_MS ?? "300000";
  if (!/^\d+$/.test(rawTimeout)) {
    throw new Error("DSH_AGENT_DEADLINE_MS must be a positive integer");
  }
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DSH_AGENT_DEADLINE_MS must be a positive integer");
  }
  return {
    baseUrl: parsedUrl.toString().replace(/\/$/, ""),
    token,
    timeoutMs,
  };
}

export async function importLegacyMemoryRelationship(
  input: { userId: string; characterId: string; dryRun: boolean },
  dependencies: {
    prisma?: ChatPrismaClient;
    projectorPrisma?: ChatPrismaClient;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LegacyMemoryImportPlan & {
  mode: "dry-run" | "applied";
  imported?: Awaited<ReturnType<typeof importLegacyCompanionMemory>>;
  marker?: LegacyMemoryImportMarker;
}> {
  const prisma = dependencies.prisma ?? chatPrisma;
  const projectorPrisma = dependencies.projectorPrisma ?? chatProjectorPrisma;
  const config = input.dryRun ? null : sidecarConfig(dependencies.env ?? process.env);
  return withReadableChatFileSnapshot(
    input.userId,
    async (tx) => {
      const raw = await readWhole(chatFsPaths.memory(input.userId, input.characterId)) ?? "";
      const identity = { userId: input.userId, characterId: input.characterId };
      const canonical = await buildCompanionWorkspaceRebuild(tx, identity);
      const plan = buildLegacyMemoryImportPlan({
        ...identity,
        memories: parseLegacyMemoryFile(raw, input.characterId),
        canonicalMessages: canonical.messages,
      });
      if (input.dryRun || !config) return { ...plan, mode: "dry-run" };
      const imported = await importLegacyCompanionMemory({
        baseUrl: config.baseUrl,
        token: config.token,
        request: plan.request,
        fetchImpl: dependencies.fetchImpl,
        timeoutMs: config.timeoutMs + 30_000,
      });
      return {
        ...plan,
        mode: "applied",
        imported,
        marker: {
          checksum: imported.checksum,
          igrepVersion: imported.igrepVersion,
          completedAt: imported.completedAt,
        },
      };
    },
    prisma,
    projectorPrisma,
    config ? config.timeoutMs + 45_000 : 30_000,
  );
}

export function parseLegacyMemoryImportArgs(argv: readonly string[]): {
  userId: string;
  characterId: string;
  dryRun: boolean;
} {
  let userId = "";
  let characterId = "";
  let dryRun = true;
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--user-id" || argument === "--character-id") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--user-id") userId = value;
      else characterId = value;
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      if (explicitDryRun) throw new Error("--apply and --dry-run are mutually exclusive");
      dryRun = false;
      continue;
    }
    if (argument === "--dry-run") {
      if (!dryRun) throw new Error("--apply and --dry-run are mutually exclusive");
      explicitDryRun = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!userId) throw new Error("--user-id is required");
  if (!characterId) throw new Error("--character-id is required");
  return { userId, characterId, dryRun };
}

async function main(): Promise<void> {
  try {
    const input = parseLegacyMemoryImportArgs(process.argv.slice(2));
    const result = await importLegacyMemoryRelationship(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await Promise.all([
      chatPrisma.$disconnect(),
      chatProjectorPrisma.$disconnect(),
    ]);
  }
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entrypoint) {
  await main();
}
