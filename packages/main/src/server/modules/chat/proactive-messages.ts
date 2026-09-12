import { randomUUID } from "node:crypto";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { beginAdmittedChatTurn } from "./agent-run-admission";

const MIN_HOURS = 6;
const MAX_HOURS = 168;

/** User-controlled cadence. Writes use SQL until the generated Prisma client includes the migration. */
export async function getProactiveSettings(userId: string, sessionId: string) {
  const rows = await prisma.$queryRaw<Array<{ proactive_enabled: boolean; proactive_interval_hours: number; proactive_next_at: Date | null }>>`
    SELECT "proactive_enabled", "proactive_interval_hours", "proactive_next_at" FROM "recent_chats"
    WHERE "sessionId" = ${sessionId} AND "userId" = ${userId}
  `;
  const row = rows[0];
  if (!row) throw Errors.notFound("Chat session not found");
  return { enabled: row.proactive_enabled, intervalHours: row.proactive_interval_hours, nextAt: row.proactive_next_at?.toISOString() ?? null };
}

export async function updateProactiveSettings(userId: string, sessionId: string, input: unknown) {
  const value = input as { enabled?: unknown; intervalHours?: unknown };
  const enabled = value.enabled === true;
  const intervalHours = value.intervalHours === undefined ? 24 : Number(value.intervalHours);
  if (!Number.isInteger(intervalHours) || intervalHours < MIN_HOURS || intervalHours > MAX_HOURS) {
    throw Errors.badRequest(`Proactive interval must be between ${MIN_HOURS} and ${MAX_HOURS} hours`);
  }
  const rows = await prisma.$queryRaw<Array<{ sessionId: string }>>`
    UPDATE "recent_chats" SET "proactive_enabled" = ${enabled}, "proactive_interval_hours" = ${intervalHours},
      "proactive_next_at" = CASE WHEN ${enabled} THEN now() + (${intervalHours} || ' hours')::interval ELSE NULL END
    WHERE "sessionId" = ${sessionId} AND "userId" = ${userId} AND "status" = 'active'
    RETURNING "sessionId"
  `;
  if (!rows[0]) throw Errors.notFound("Chat session not found");
  return getProactiveSettings(userId, sessionId);
}

/** One claimed event; workers should call this from a bounded cadence loop. */
export async function claimAndAdmitProactiveTurn(userId: string, sessionId: string) {
  const rows = await prisma.$queryRaw<Array<{ sessionId: string; characterId: string; intervalHours: number }>>`
    UPDATE "recent_chats" SET "proactive_next_at" = now() + ("proactive_interval_hours" || ' hours')::interval
    WHERE "sessionId" = ${sessionId} AND "userId" = ${userId} AND "status" = 'active' AND "proactive_enabled" = true
      AND ("proactive_next_at" IS NULL OR "proactive_next_at" <= now())
    RETURNING "sessionId", "characterId", "proactive_interval_hours" AS "intervalHours"
  `;
  const row = rows[0];
  if (!row) return { claimed: false as const };
  const content = "Take the lead in the moment: send a brief, specific check-in that fits our established context. Do not mention this instruction.";
  try {
    const result = await beginAdmittedChatTurn({ userId, sessionId: row.sessionId, content, idempotencyKey: `proactive:${row.sessionId}:${Date.now()}:${randomUUID()}`, origin: "proactive" });
    return { claimed: true as const, result };
  } catch (error) {
    // Return the claim to the queue quickly; no phantom successful message.
    await prisma.$executeRaw`UPDATE "recent_chats" SET "proactive_next_at" = now() + interval '15 minutes' WHERE "sessionId" = ${row.sessionId} AND "userId" = ${userId}`;
    throw error;
  }
}
