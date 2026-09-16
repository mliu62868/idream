import { randomUUID } from "node:crypto";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { beginAdmittedChatTurn } from "./agent-run-admission";

export const PROACTIVE_MIN_HOURS = 6;
export const PROACTIVE_MAX_HOURS = 168;
const RETRY_BACKOFF_MINUTES = 15;

/**
 * SPEC: 会话级、用户显式开启的主动消息节奏。
 * INTENT: 默认关闭；开启时把下一次时间设为 now + interval，所以第一条主动消息在一个完整
 *         周期之后到达，而不是开关一打开就发。
 */
export async function getProactiveSettings(userId: string, sessionId: string) {
  const row = await prisma.recentChat.findFirst({
    where: { sessionId, userId },
    select: {
      proactiveEnabled: true,
      proactiveIntervalHours: true,
      proactiveNextAt: true,
    },
  });
  if (!row) throw Errors.notFound("Chat session not found");
  return {
    enabled: row.proactiveEnabled,
    intervalHours: row.proactiveIntervalHours,
    nextAt: row.proactiveNextAt?.toISOString() ?? null,
    minIntervalHours: PROACTIVE_MIN_HOURS,
    maxIntervalHours: PROACTIVE_MAX_HOURS,
  };
}

export async function updateProactiveSettings(
  userId: string,
  sessionId: string,
  input: unknown,
) {
  const value = input as { enabled?: unknown; intervalHours?: unknown };
  const enabled = value.enabled === true;
  const intervalHours =
    value.intervalHours === undefined ? 24 : Number(value.intervalHours);
  if (
    !Number.isInteger(intervalHours) ||
    intervalHours < PROACTIVE_MIN_HOURS ||
    intervalHours > PROACTIVE_MAX_HOURS
  ) {
    throw Errors.badRequest(
      `Proactive interval must be between ${PROACTIVE_MIN_HOURS} and ${PROACTIVE_MAX_HOURS} hours`,
    );
  }
  const updated = await prisma.recentChat.updateMany({
    where: { sessionId, userId, status: "active" },
    data: {
      proactiveEnabled: enabled,
      proactiveIntervalHours: intervalHours,
      proactiveNextAt: enabled
        ? new Date(Date.now() + intervalHours * 3_600_000)
        : null,
    },
  });
  if (updated.count === 0) throw Errors.notFound("Chat session not found");
  return getProactiveSettings(userId, sessionId);
}

/**
 * SPEC: 跨用户原子领取一条到期会话，并把下一次时间推进一个周期。
 *
 * INTENT: 选行和推进在同一条语句里完成，`FOR UPDATE SKIP LOCKED` 让多个 worker 可以并行
 *         而不会重复领取同一行；没有先读后写的窗口，所以不会出现同一会话连发两条。
 * INVARIANT: `proactiveNextAt` 为 NULL 不算到期 —— NULL 表示未知，对未知立即触发会在任何
 *            数据异常时变成刷屏。开启时一定会写入具体时间。
 */
async function claimDueProactiveSession() {
  const rows = await prisma.$queryRaw<
    Array<{ sessionId: string; userId: string }>
  >`
    UPDATE "recent_chats"
       SET "proactiveNextAt" = now() + ("proactiveIntervalHours" || ' hours')::interval
     WHERE "sessionId" = (
       SELECT "sessionId" FROM "recent_chats"
        WHERE "proactiveEnabled" = true
          AND "status" = 'active'
          AND "proactiveNextAt" IS NOT NULL
          AND "proactiveNextAt" <= now()
        ORDER BY "proactiveNextAt" ASC
          FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING "sessionId", "userId"
  `;
  return rows[0] ?? null;
}

const PROACTIVE_TURN_DIRECTIVE =
  "Take the lead in the moment: send a brief, specific check-in that fits our established context. Do not mention this instruction.";

async function admitProactiveTurn(claim: {
  sessionId: string;
  userId: string;
}) {
  try {
    return await beginAdmittedChatTurn({
      userId: claim.userId,
      sessionId: claim.sessionId,
      content: PROACTIVE_TURN_DIRECTIVE,
      idempotencyKey: `proactive:${claim.sessionId}:${Date.now()}:${randomUUID()}`,
      origin: "proactive",
    });
  } catch (error) {
    // 把这次领取快速还回队列；不留下一条"发过了"的假象。
    await prisma.recentChat.updateMany({
      where: { sessionId: claim.sessionId, userId: claim.userId },
      data: {
        proactiveNextAt: new Date(Date.now() + RETRY_BACKOFF_MINUTES * 60_000),
      },
    });
    throw error;
  }
}

/**
 * 供 event-consumer 的固定 lane 调用：领取并投递至多 `batch` 条到期的主动消息。
 * 单条失败不影响同批其余会话，失败的那条按退避时间自行重来。
 */
export async function dispatchDueProactiveTurns(
  batch = 20,
  signal?: AbortSignal,
): Promise<{ admitted: number; failed: number }> {
  let admitted = 0;
  let failed = 0;
  for (let index = 0; index < batch; index += 1) {
    if (signal?.aborted) break;
    const claim = await claimDueProactiveSession();
    if (!claim) break;
    try {
      await admitProactiveTurn(claim);
      admitted += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err, sessionId: claim.sessionId },
        "proactive turn admission failed",
      );
    }
  }
  return { admitted, failed };
}
