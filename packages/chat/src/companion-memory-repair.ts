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
  return JSON.parse(JSON.stringify({
    ...root,
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
  if (config.runtime !== "dsh") return { repaired: 0, errors: 0 };
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

      const repairedAt = now.toISOString();
      await prisma.$transaction(async (tx) => {
        const current = await tx.message.findMany({
          where: {
            id: { in: group.messageIds },
            role: "assistant",
            status: "sent",
            deletedAt: null,
            memoryAuthority: "enabled",
          },
          select: { id: true, attempt: true, runtimeTrace: true },
        });
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
              status: "sent",
              deletedAt: null,
            },
            data: { runtimeTrace },
          });
          if (claimed.count !== 1) continue;
          await tx.messageVersion.updateMany({
            where: {
              id: `mv:${message.id}:${message.attempt}`,
              messageId: message.id,
              attempt: message.attempt,
            },
            data: { runtimeTrace },
          });
          repaired += 1;
        }
      });
    } catch {
      errors += 1;
    }
  }
  return { repaired, errors };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
