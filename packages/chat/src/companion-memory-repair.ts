import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { env } from "./env.js";
import { withTurnAuthority } from "./file-mutations.js";

interface RepairCandidate {
  id: string;
  attempt: number;
  sessionId: string;
  userId: string;
  characterId: string;
}

interface RepairGroup {
  userId: string;
  characterId: string;
  sessionId: string;
  messageIds: string[];
}

export interface CompanionMemoryRepairResult {
  repaired: number;
  errors: number;
}

export function needsCompanionMemoryRepair(runtimeTrace: unknown): boolean {
  const root = record(runtimeTrace);
  const pin = record(root?.companionRuntime);
  const companion = record(root?.companion);
  return pin?.runtime === "dsh"
    && pin.memoryBackend === "igrep-dsh"
    && pin.private === false
    && ["pending", "failed"].includes(String(companion?.memoryIngestOutcome));
}

export function repairedCompanionMemoryTrace(
  runtimeTrace: unknown,
  repairedAt: string,
): Prisma.InputJsonValue {
  if (!needsCompanionMemoryRepair(runtimeTrace)) {
    throw new Error("runtime trace does not own a repairable companion memory projection");
  }
  const root = record(runtimeTrace)!;
  const companion = record(root.companion)!;
  const primaryTelemetry = record(root.primaryTelemetry);
  const priorMemoryTelemetry = record(primaryTelemetry?.memory);
  const startedAt = typeof primaryTelemetry?.startedAt === "string"
    ? Date.parse(primaryTelemetry.startedAt)
    : Number.NaN;
  const totalMs = typeof primaryTelemetry?.totalMs === "number"
    ? primaryTelemetry.totalMs
    : Number.NaN;
  const repairedAtMs = Date.parse(repairedAt);
  const settleLagMs = Number.isFinite(startedAt)
      && Number.isFinite(totalMs)
      && Number.isFinite(repairedAtMs)
    ? Math.max(0, repairedAtMs - (startedAt + totalMs))
    : null;
  return JSON.parse(JSON.stringify({
    ...root,
    ...(primaryTelemetry
      ? {
          primaryTelemetry: {
            ...primaryTelemetry,
            memory: {
              ...priorMemoryTelemetry,
              outcome: "ingested_rebuilt",
              ...(settleLagMs === null ? {} : { settleLagMs }),
            },
          },
        }
      : {}),
    companion: {
      ...companion,
      memoryIngestOutcome: "ingested_rebuilt",
      memoryIngestSettledAt: repairedAt,
      memoryRepair: {
        kind: "canonical_rebuild",
        repairedAt,
      },
    },
  })) as Prisma.InputJsonValue;
}

export function groupCompanionMemoryRepairs(
  candidates: readonly RepairCandidate[],
): RepairGroup[] {
  const groups = new Map<string, RepairGroup>();
  for (const candidate of candidates) {
    const key = `${candidate.userId}\0${candidate.characterId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.messageIds.push(candidate.id);
    } else {
      groups.set(key, {
        userId: candidate.userId,
        characterId: candidate.characterId,
        sessionId: candidate.sessionId,
        messageIds: [candidate.id],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Rebuild is a replayable projection of PG terminal truth. The durable
 * relationship_rebuild intent is committed before sidecar I/O; a crash before
 * trace settlement therefore retries the same canonical rebuild safely.
 */
export async function repairCompanionMemoryProjections(
  prisma: ChatPrismaClient,
  projectorPrisma: ChatPrismaClient,
  now: Date,
): Promise<CompanionMemoryRepairResult> {
  const config = env.COMPANION_RUNTIME_CONFIG;
  // INVARIANT: rollback changes routing for new attempts, not ownership of
  // already-committed DSH workspaces. Retained sidecar authority must keep
  // repair/rebuild active until those historical traces settle.
  if (!config.sidecarToken) return { repaired: 0, errors: 0 };
  const pendingCutoff = new Date(now.getTime() - config.deadlineMs - 30_000);
  const candidates = await prisma.$queryRaw<RepairCandidate[]>`
    SELECT
      message.id,
      message.attempt,
      message.session_id AS "sessionId",
      session.user_id AS "userId",
      session.character_id AS "characterId"
    FROM chat.messages message
    JOIN chat.chat_sessions session ON session.id = message.session_id
    WHERE message.role = 'assistant'
      AND message.status = 'sent'
      AND message.deleted_at IS NULL
      AND message.memory_authority = 'enabled'
      AND session.status <> 'deleted'
      AND session.deleted_at IS NULL
      AND message.runtime_trace #>> '{companionRuntime,runtime}' = 'dsh'
      AND message.runtime_trace #>> '{companionRuntime,memoryBackend}' = 'igrep-dsh'
      AND message.runtime_trace #>> '{companionRuntime,private}' = 'false'
      AND (
        message.runtime_trace #>> '{companion,memoryIngestOutcome}' = 'failed'
        OR (
          message.runtime_trace #>> '{companion,memoryIngestOutcome}' = 'pending'
          AND message.updated_at < ${pendingCutoff}
        )
      )
    ORDER BY message.updated_at ASC, message.id ASC
    LIMIT 200
  `;

  let repaired = 0;
  let errors = 0;
  for (const group of groupCompanionMemoryRepairs(candidates)) {
    try {
      const recorded = await withTurnAuthority(
        {
          userId: group.userId,
          sessionId: group.sessionId,
          prisma,
          projectorPrisma,
        },
        async (tx, recordIntent) => {
          const current = await tx.message.findMany({
            where: {
              id: { in: group.messageIds },
              role: "assistant",
              status: "sent",
              deletedAt: null,
              memoryAuthority: "enabled",
              session: {
                userId: group.userId,
                characterId: group.characterId,
                status: { not: "deleted" },
                deletedAt: null,
              },
            },
            select: { runtimeTrace: true },
          });
          if (!current.some((message) => needsCompanionMemoryRepair(message.runtimeTrace))) {
            return false;
          }
          await recordIntent({
            kind: "relationship_rebuild",
            characterId: group.characterId,
          });
          return true;
        },
      );
      if (!recorded) continue;

      repaired += await settleCompanionMemoryRepairTraces(
        prisma,
        group.messageIds,
        now.toISOString(),
      );
    } catch {
      errors += 1;
    }
  }
  return { repaired, errors };
}

/** Message and its selected attempt Version are one observable repair fact. */
export async function settleCompanionMemoryRepairTraces(
  prisma: ChatPrismaClient,
  messageIds: readonly string[],
  repairedAt: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.message.findMany({
      where: {
        id: { in: [...messageIds] },
        role: "assistant",
        status: "sent",
        deletedAt: null,
        memoryAuthority: "enabled",
      },
      select: { id: true, attempt: true, runtimeTrace: true },
    });
    let repaired = 0;
    for (const message of current) {
      if (!needsCompanionMemoryRepair(message.runtimeTrace)) continue;
      const runtimeTrace = repairedCompanionMemoryTrace(
        message.runtimeTrace,
        repairedAt,
      );
      const claimed = await tx.message.updateMany({
        where: {
          id: message.id,
          attempt: message.attempt,
          role: "assistant",
          status: "sent",
          deletedAt: null,
          memoryAuthority: "enabled",
        },
        data: { runtimeTrace },
      });
      if (claimed.count !== 1) continue;
      const versionClaimed = await tx.messageVersion.updateMany({
        where: {
          id: `mv:${message.id}:${message.attempt}`,
          messageId: message.id,
          attempt: message.attempt,
          selected: true,
        },
        data: { runtimeTrace },
      });
      if (versionClaimed.count !== 1) {
        throw new Error("companion memory repair selected MessageVersion CAS failed");
      }
      repaired += 1;
    }
    return repaired;
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
