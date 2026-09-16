import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { actorWithPermission, queryParams } from "../shared/authority";
import { paginateAdminKeyset, CREATED_AT_DESC_KEYS } from "../shared/list-cursor";

const customer = { status: "active", deletedAt: null, dataClass: "customer" } as const;
// Do not read transcript, group title, or error payloads: this is operational metadata.
const turnSelect = {
  id: true, assistantStatus: true, attempt: true, admissionAttempts: true,
  admittedAt: true, admissionNextRunAt: true, admissionLastError: true,
  createdAt: true, terminalAt: true,
} as const;
type Turn = Prisma.ChatTurnGetPayload<{ select: typeof turnSelect }>;
function latestTurn(row: Turn | undefined) {
  return row ? {
    id: row.id, status: row.assistantStatus, attempt: row.attempt,
    admissionAttempts: row.admissionAttempts, admittedAt: row.admittedAt?.toISOString() ?? null,
    admissionNextRunAt: row.assistantStatus === "pending" && !row.admittedAt ? row.admissionNextRunAt.toISOString() : null,
    hasAdmissionError: row.admissionLastError !== null,
    createdAt: row.createdAt.toISOString(), terminalAt: row.terminalAt?.toISOString() ?? null,
  } : null;
}
const memberSelect = { sessionId: true, characterId: true, status: true } as const;

const groupSelect = { id: true, userId: true, status: true, createdAt: true,
          members: { select: memberSelect, orderBy: { groupPosition: "asc" } },
          turns: { take: 1, orderBy: { ordinal: "desc" }, select: { turn: { select: turnSelect } } },
        } as const;
const sessionSelect = { ...memberSelect, userId: true, createdAt: true, proactiveEnabled: true, proactiveIntervalHours: true, proactiveNextAt: true, proactiveUnreadAt: true,
        turns: { where: { origin: "proactive" }, take: 1, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: turnSelect },
      } satisfies Prisma.RecentChatSelect;

export async function chatOpsEngagement(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/engagement");
  const { kind, userId, characterId, cursor, limit } = query;
  const asOf = new Date();
  if (kind === "groups") {
    const result = await paginateAdminKeyset<Prisma.GroupConversationGetPayload<{ select: typeof groupSelect }>, Prisma.GroupConversationOrderByWithRelationInput>({
      scope: "chat-engagement-groups", queryIdentity: { userId, characterId }, cursor, limit,
      keys: CREATED_AT_DESC_KEYS,
      fetch: (page) => prisma.groupConversation.findMany({
        where: { AND: [{ user: customer, ...(userId ? { userId } : {}), ...(characterId ? { members: { some: { characterId } } } : {}) }, ...page.cursorWhere] },
        orderBy: page.orderBy, take: page.take,
        select: groupSelect,
      }),
    });
    return { items: result.items.map((row) => ({ id: row.id, userId: row.userId, status: row.status, sessions: row.members, schedule: null, latestTurn: latestTurn(row.turns[0]?.turn) })), pageInfo: result.pageInfo, asOf: asOf.toISOString(), freshness: "fresh" as const };
  }
  const result = await paginateAdminKeyset<Prisma.RecentChatGetPayload<{ select: typeof sessionSelect }>, Prisma.RecentChatOrderByWithRelationInput>({
    scope: "chat-engagement-proactive", queryIdentity: { userId, characterId }, cursor, limit,
    keys: [
      { field: "createdAt", direction: "desc", type: "datetime", value: (row: { createdAt: Date; sessionId: string }) => row.createdAt },
      { field: "sessionId", direction: "desc", value: (row: { createdAt: Date; sessionId: string }) => row.sessionId },
    ],
    fetch: (page) => prisma.recentChat.findMany({
      where: { AND: [{ user: customer, ...(userId ? { userId } : {}), ...(characterId ? { characterId } : {}), OR: [{ proactiveEnabled: true }, { turns: { some: { origin: "proactive" } } }] }, ...page.cursorWhere] },
      orderBy: page.orderBy, take: page.take,
      select: sessionSelect,
    }),
  });
  return { items: result.items.map((row) => ({
    id: row.sessionId, userId: row.userId, status: row.status,
    sessions: [{ sessionId: row.sessionId, characterId: row.characterId, status: row.status }],
    schedule: { enabled: row.proactiveEnabled, intervalHours: row.proactiveIntervalHours,
      nextAt: row.proactiveNextAt?.toISOString() ?? null, unreadAt: row.proactiveUnreadAt?.toISOString() ?? null,
      // Scheduler eligibility only; admission still owns allowance, release and content gates.
      state: !row.proactiveEnabled ? "disabled" : row.status !== "active" ? "inactive" : !row.proactiveNextAt ? "missing_schedule" : row.proactiveNextAt <= asOf ? "due" : "scheduled",
    }, latestTurn: latestTurn(row.turns[0]),
  })), pageInfo: result.pageInfo, asOf: asOf.toISOString(), freshness: "fresh" as const };
}
