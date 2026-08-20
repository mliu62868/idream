// SPEC: ADR-19 §11.2 imports one legacy relationship at a time. PG canonical
// turns decide eligibility; memory.md is only a candidate source.
// INVARIANT: apply runs under the exclusive user authority lock, so edit/delete
// projection cannot invalidate source evidence between planning and promotion.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  COMPANION_IGREP_VERSION,
  companionLegacyRecallProbeSchema,
  companionLegacyMemoryImportSchema,
  type CompanionLegacyMemoryImport,
  type CompanionLegacyMemoryImportEntry,
  type CompanionLegacyRecallProbe,
  type CompanionWorkspaceRebuildMessage,
} from "@idream/shared/chat/companion-runtime";
import { z } from "zod";
import type { Prisma } from "../generated/client/client.js";
import { chatFsPaths, readWhole, withFileMutationLock } from "./chat-fs.js";
import {
  assertNoPendingChatFileMutationsTx,
  projectChatFileMutations,
} from "./file-mutations.js";
import {
  buildCompanionWorkspaceRebuild,
} from "./companion-memory-projection.js";
import {
  importLegacyCompanionMemory,
} from "./companion-runtime.js";
import {
  resolveCompanionMemoryCutover,
  type CompanionMemoryCutoverProof,
} from "./companion-memory-cutover.js";
import { canonicalCompanionSidecarUrl } from "./companion-runtime-selection.js";
import type { LegacyMemoryImportCliInput } from "./memory-cli.js";
import {
  chatPrisma,
  chatProjectorPrisma,
  type ChatPrismaClient,
} from "./db.js";
import { parseLine, type MemoryItem } from "./memories.js";
import { lockUser } from "./turn-lock.js";

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
  legacySourceChecksum: string;
  request: CompanionLegacyMemoryImport;
}

export type LegacyMemoryImportMarker = CompanionMemoryCutoverProof;

export interface LegacyMemoryImportPendingProof {
  schemaVersion: 1;
  status: "import_pending";
  legacySourceChecksum: string;
  importChecksum: string;
  igrepVersion: typeof COMPANION_IGREP_VERSION;
  recallProbeSetChecksum: string;
  startedAt: string;
}

export interface LegacyWorkspaceCleanupFact {
  cleanupRequired: true;
  state: "import_pending" | "cutover_ready";
  importChecksum: string;
  recallProbeSetChecksum: string;
  igrepVersion: string;
  cutoverReadyAt: string | null;
  memoryCutover?: LegacyMemoryImportPendingProof | CompanionMemoryCutoverProof;
}

export interface LegacyMemoryCandidateSnapshot {
  total: number;
  excluded: LegacyMemoryImportExclusions;
  entries: CompanionLegacyMemoryImportEntry[];
  legacySourceChecksum: string;
  importChecksum: string;
}

export function buildLegacyMemoryCandidateSnapshot(input: {
  userId: string;
  characterId: string;
  memories: readonly MemoryItem[];
  canonicalMessages: readonly CompanionWorkspaceRebuildMessage[];
}): LegacyMemoryCandidateSnapshot {
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
  const importChecksum = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  const legacySourceChecksum = createHash("sha256")
    .update(JSON.stringify(input.memories.map((memory) => ({
      id: memory.id,
      characterId: memory.characterId,
      type: memory.type,
      text: memory.text,
      sourceMessageIds: [...memory.sourceMessageIds].sort(),
      confidence: memory.confidence,
    }))))
    .digest("hex");
  return {
    total: input.memories.length,
    excluded,
    entries,
    legacySourceChecksum,
    importChecksum,
  };
}

export function buildLegacyMemoryImportPlan(input: {
  userId: string;
  characterId: string;
  memories: readonly MemoryItem[];
  canonicalMessages: readonly CompanionWorkspaceRebuildMessage[];
  recallProbes: readonly CompanionLegacyRecallProbe[];
}): LegacyMemoryImportPlan {
  const snapshot = buildLegacyMemoryCandidateSnapshot(input);
  return {
    total: snapshot.total,
    excluded: snapshot.excluded,
    legacySourceChecksum: snapshot.legacySourceChecksum,
    request: companionLegacyMemoryImportSchema.parse({
      scope: "relationship",
      userId: input.userId,
      characterId: input.characterId,
      legacySourceChecksum: snapshot.legacySourceChecksum,
      checksum: snapshot.importChecksum,
      entries: snapshot.entries,
      recallProbes: input.recallProbes,
    }),
  };
}

const legacyRecallProbeFileSchema = z
  .object({
    version: z.literal(1),
    probes: z.array(companionLegacyRecallProbeSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.probes.map((probe) => probe.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["probes"],
        message: "legacy recall probe ids must be unique",
      });
    }
  });

export function parseLegacyRecallProbeFile(raw: string): CompanionLegacyRecallProbe[] {
  return legacyRecallProbeFileSchema.parse(JSON.parse(raw)).probes;
}

export function redactedLegacyRecallProbeSummary(
  probes: readonly CompanionLegacyRecallProbe[],
): {
  count: number;
  checksum: string;
  probes: Array<{ id: string; queryHash: string; legacyExpectedHash: string }>;
} {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    count: probes.length,
    checksum: digest(JSON.stringify(probes)),
    probes: probes.map((probe) => ({
      id: probe.id,
      queryHash: digest(probe.query),
      legacyExpectedHash: digest(probe.legacyExpected),
    })),
  };
}

export function legacyMemoryImportCliEvidence(
  result: LegacyMemoryImportPlan & {
    mode: "dry-run" | "applied";
    marker?: LegacyMemoryImportMarker;
  },
): {
  mode: "dry-run" | "applied";
  total: number;
  excluded: LegacyMemoryImportExclusions;
  checksum: string;
  legacySourceChecksum: string;
  igrepVersion: string;
  recallProbes: ReturnType<typeof redactedLegacyRecallProbeSummary>;
  marker?: LegacyMemoryImportMarker;
} {
  // INVARIANT: operator evidence may contain counts and digests, never legacy
  // text, source message ids, or relationship identity.
  return {
    mode: result.mode,
    total: result.total,
    excluded: result.excluded,
    checksum: result.request.checksum,
    legacySourceChecksum: result.legacySourceChecksum,
    igrepVersion: COMPANION_IGREP_VERSION,
    recallProbes: redactedLegacyRecallProbeSummary(result.request.recallProbes),
    ...(result.marker ? { marker: result.marker } : {}),
  };
}

export async function persistLegacyWorkspaceCleanupRequired(
  tx: Prisma.TransactionClient,
  assistantMessageId: string,
  fact: LegacyWorkspaceCleanupFact,
): Promise<void> {
  const payload = JSON.stringify(fact);
  // INVARIANT: one SQL statement merges the cleanup fact into both serving
  // projections. A missing or ambiguous selected version rolls the surrounding
  // import transaction back instead of leaving rollback cleanup unknowable.
  const updated = await tx.$executeRaw`
    WITH updated_message AS (
      UPDATE chat.messages
      SET runtime_trace = jsonb_set(
        COALESCE(runtime_trace, '{}'::jsonb),
        '{companionWorkspace}',
        COALESCE(runtime_trace->'companionWorkspace', '{}'::jsonb) || ${payload}::jsonb,
        true
      )
      WHERE id = ${assistantMessageId}
        AND deleted_at IS NULL
        AND (
          runtime_trace IS NULL
          OR (
            jsonb_typeof(runtime_trace) = 'object'
            AND (
              runtime_trace->'companionWorkspace' IS NULL
              OR jsonb_typeof(runtime_trace->'companionWorkspace') = 'object'
            )
          )
        )
      RETURNING id
    )
    UPDATE chat.message_versions AS version
    SET runtime_trace = jsonb_set(
      COALESCE(version.runtime_trace, '{}'::jsonb),
      '{companionWorkspace}',
      COALESCE(version.runtime_trace->'companionWorkspace', '{}'::jsonb) || ${payload}::jsonb,
      true
    )
    FROM updated_message
    WHERE version.message_id = updated_message.id
      AND version.selected = true
      AND (
        version.runtime_trace IS NULL
        OR (
          jsonb_typeof(version.runtime_trace) = 'object'
          AND (
            version.runtime_trace->'companionWorkspace' IS NULL
            OR jsonb_typeof(version.runtime_trace->'companionWorkspace') = 'object'
          )
        )
      )
  `;
  if (updated !== 1) {
    throw new Error("legacy import did not mark exactly one Message and selected Version");
  }
}

async function withLegacyMemoryImportAuthority<T>(
  userId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  prisma: ChatPrismaClient,
  projectorPrisma: ChatPrismaClient,
  timeoutMs: number,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // INVARIANT: one import owns the user's canonical snapshot through the
    // remote promotion. The nested cleanup-intent transaction deliberately
    // does not acquire this advisory lock, so it can commit before the remote
    // side effect while every normal writer remains fenced.
    await lockUser(tx, userId);
    await assertNoPendingChatFileMutationsTx(tx, userId);
    return run(tx);
  }, { timeout: timeoutMs });
}

export function parseLegacyMemoryFile(raw: string, characterId: string): MemoryItem[] {
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
  const baseUrl = canonicalCompanionSidecarUrl(
    source.DSH_AGENT_URL ?? "http://127.0.0.1:3101",
    "DSH_AGENT_URL",
  );
  const rawTimeout = source.DSH_AGENT_DEADLINE_MS ?? "300000";
  if (!/^\d+$/.test(rawTimeout)) {
    throw new Error("DSH_AGENT_DEADLINE_MS must be a positive integer");
  }
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DSH_AGENT_DEADLINE_MS must be a positive integer");
  }
  return {
    baseUrl,
    token,
    timeoutMs,
  };
}

export async function importLegacyMemoryRelationship(
  input: {
    userId: string;
    characterId: string;
    dryRun: boolean;
    recallProbes: readonly CompanionLegacyRecallProbe[];
  },
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
  await projectChatFileMutations(input.userId, projectorPrisma);
  return withFileMutationLock(
    chatFsPaths.memory(input.userId, input.characterId),
    () => withLegacyMemoryImportAuthority(
      input.userId,
      async (tx) => {
        const raw = await readWhole(chatFsPaths.memory(input.userId, input.characterId)) ?? "";
        const identity = { userId: input.userId, characterId: input.characterId };
        const canonical = await buildCompanionWorkspaceRebuild(tx, identity);
        const plan = buildLegacyMemoryImportPlan({
          ...identity,
          memories: parseLegacyMemoryFile(raw, input.characterId),
          canonicalMessages: canonical.messages,
          recallProbes: input.recallProbes,
        });
        if (input.dryRun || !config) return { ...plan, mode: "dry-run" };
        const anchor = [...canonical.messages].reverse()
          .find((message) => message.role === "assistant");
        if (!anchor) {
          throw new Error("legacy import needs a canonical assistant anchor for cleanup authority");
        }
        // A timeout or process exit after the request reaches the sidecar is
        // ambiguous: promotion may already have happened. Commit cleanupRequired
        // first so rollback remains fail-closed even when this outer transaction
        // never reaches its final cutover-ready write.
        await prisma.$transaction(async (cleanupTx) => {
          const startedAt = new Date().toISOString();
          await persistLegacyWorkspaceCleanupRequired(cleanupTx, anchor.id, {
            cleanupRequired: true,
            state: "import_pending",
            importChecksum: plan.request.checksum,
            recallProbeSetChecksum: redactedLegacyRecallProbeSummary(
              plan.request.recallProbes,
            ).checksum,
            igrepVersion: COMPANION_IGREP_VERSION,
            cutoverReadyAt: null,
            memoryCutover: {
              schemaVersion: 1,
              status: "import_pending",
              legacySourceChecksum: plan.legacySourceChecksum,
              importChecksum: plan.request.checksum,
              igrepVersion: COMPANION_IGREP_VERSION,
              recallProbeSetChecksum: redactedLegacyRecallProbeSummary(
                plan.request.recallProbes,
              ).checksum,
              startedAt,
            },
          });
        }, { timeout: 30_000 });
        const imported = await importLegacyCompanionMemory({
          baseUrl: config.baseUrl,
          token: config.token,
          request: plan.request,
          fetchImpl: dependencies.fetchImpl,
          timeoutMs: config.timeoutMs + 30_000,
        });
        const certified = resolveCompanionMemoryCutover({
          snapshot: {
            total: plan.total,
            eligibleEntries: plan.request.entries.length,
            legacySourceChecksum: plan.legacySourceChecksum,
            importChecksum: plan.request.checksum,
          },
          chatProof: null,
          sidecarProof: imported,
        });
        if (certified.action !== "admit") {
          throw new Error("legacy import did not produce a cutover proof");
        }
        const marker: LegacyMemoryImportMarker = certified.proof;
        await persistLegacyWorkspaceCleanupRequired(tx, anchor.id, {
          cleanupRequired: true,
          state: "cutover_ready",
          importChecksum: imported.checksum,
          recallProbeSetChecksum: imported.recallParity.probeSetChecksum,
          igrepVersion: imported.igrepVersion,
          cutoverReadyAt: imported.completedAt,
          memoryCutover: marker,
        });
        return {
          ...plan,
          mode: "applied",
          imported,
          marker,
        };
      },
      prisma,
      projectorPrisma,
      config ? config.timeoutMs + 45_000 : 30_000,
    ),
  );
}

export async function runLegacyMemoryImportCli(
  input: LegacyMemoryImportCliInput,
): Promise<void> {
  try {
    const recallProbes = parseLegacyRecallProbeFile(await readFile(input.probeFile, "utf8"));
    const result = await importLegacyMemoryRelationship({ ...input, recallProbes });
    process.stdout.write(`${JSON.stringify(legacyMemoryImportCliEvidence(result))}\n`);
  } finally {
    await Promise.all([
      chatPrisma.$disconnect(),
      chatProjectorPrisma.$disconnect(),
    ]);
  }
}
