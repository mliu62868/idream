import type { ChatOpsDiagnostics } from "@idream/shared/admin";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import {
  CHAT_RUNTIME_DIAGNOSTICS_PATH,
  chatRuntimeDiagnosticsSchema,
  type ChatRuntimeDiagnostics,
} from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { entitlementMaps } from "@/server/modules/ourdream/subscription-lifecycle";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";

const CUSTOMER_USER = {
  status: "active",
  deletedAt: null,
  dataClass: "customer",
} as const;
const RUNTIME_DIAGNOSTICS_TIMEOUT_MS = 3_000;

type RuntimeDiagnosticsOutcome = {
  configured: boolean;
  data: ChatRuntimeDiagnostics | null;
  diagnostics: ChatOpsDiagnostics;
};

/** Main owns product facts; this is the only remaining Chat-owned diagnostics adapter. */
async function fetchChatRuntimeDiagnostics(): Promise<RuntimeDiagnosticsOutcome> {
  if (!env.CHAT_SERVICE_URL) {
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "missing_url", serviceUrlConfigured: false },
    };
  }
  let payload: unknown;
  try {
    const response = await fetch(
      `${env.CHAT_SERVICE_URL.replace(/\/$/u, "")}${CHAT_RUNTIME_DIAGNOSTICS_PATH}`,
      {
        headers: { "x-internal-token": env.INTERNAL_TOKEN },
        signal: AbortSignal.timeout(RUNTIME_DIAGNOSTICS_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return {
        configured: false,
        data: null,
        diagnostics: {
          reason: response.status === 401 ? "unauthorized" : "upstream_error",
          status: response.status,
          serviceUrlConfigured: true,
        },
      };
    }
    payload = await response.json();
  } catch (error) {
    return {
      configured: false,
      data: null,
      diagnostics: {
        reason: error instanceof SyntaxError ? "bad_json" : "unreachable",
        serviceUrlConfigured: true,
      },
    };
  }
  const parsed = chatRuntimeDiagnosticsSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "contract_mismatch", serviceUrlConfigured: true },
    };
  }
  return {
    configured: true,
    data: parsed.data,
    diagnostics: { serviceUrlConfigured: true },
  };
}

export async function chatOpsOverview(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const today = startOfUtcDay();
  const rows = await prisma.$queryRaw<Array<{
    activeSessions: number;
    archivedSessions: number;
    deletedSessions: number;
    messages24h: number;
    userMessages24h: number;
    assistantMessages24h: number;
    moderationEvents24h: number;
    blockedModeration24h: number;
    flaggedModeration24h: number;
    messagesUsedToday: number;
    usersAtDailyLimit: number;
    activeAuthorityUsers: number;
    excludedActiveSessions: number;
    excludedArchivedSessions: number;
    excludedDeletedSessions: number;
    excludedMessages24h: number;
    excludedModerationEvents24h: number;
    excludedUsageRowsToday: number;
    excludedMessagesUsedToday: number;
  }>>(Prisma.sql`
    WITH session_scope AS (
      SELECT
        s.status,
        (
          u.id IS NOT NULL
          AND u.status = 'active'
          AND u."deletedAt" IS NULL
          AND u."dataClass" = 'customer'
        ) AS included
      FROM "recent_chats" s
      LEFT JOIN "users" u ON u.id = s."userId"
    ),
    message_scope AS (
      SELECT role, included
      FROM (
        SELECT
          roles.role,
          (
            u.id IS NOT NULL
            AND u.status = 'active'
            AND u."deletedAt" IS NULL
            AND u."dataClass" = 'customer'
          ) AS included
        FROM "chat_turns" t
        JOIN "recent_chats" s ON s."sessionId" = t."sessionId"
        LEFT JOIN "users" u ON u.id = s."userId"
        CROSS JOIN (VALUES ('user'), ('assistant')) AS roles(role)
        WHERE t."createdAt" >= ${since}
        UNION ALL
        SELECT
          'assistant' AS role,
          (
            u.id IS NOT NULL
            AND u.status = 'active'
            AND u."deletedAt" IS NULL
            AND u."dataClass" = 'customer'
          ) AS included
        FROM "recent_chats" s
        LEFT JOIN "users" u ON u.id = s."userId"
        WHERE s."openingMessage" IS NOT NULL AND s."createdAt" >= ${since}
      ) messages
    ),
    moderation_scope AS (
      SELECT
        e.status,
        (
          u.id IS NOT NULL
          AND u.status = 'active'
          AND u."deletedAt" IS NULL
          AND u."dataClass" = 'customer'
        ) AS included
      FROM "moderation_events" e
      LEFT JOIN "chat_turns" t
        ON e."targetType" = 'chat_turn' AND t.id = e."targetId"
      LEFT JOIN "recent_chats" s ON s."sessionId" = t."sessionId"
      LEFT JOIN "users" u ON u.id = s."userId"
      WHERE e."targetType" = 'chat_turn' AND e."createdAt" >= ${since}
    ),
    usage_scope AS (
      SELECT
        f."userId",
        count(*)::int AS messages_used,
        (
          u.id IS NOT NULL
          AND u.status = 'active'
          AND u."deletedAt" IS NULL
          AND u."dataClass" = 'customer'
        ) AS included
      FROM "chat_turn_usage_facts" f
      LEFT JOIN "users" u ON u.id = f."userId"
      WHERE f."productDay" = ${today}
      GROUP BY f."userId", u.id, u.status, u."deletedAt", u."dataClass"
    ),
    session_metrics AS (
      SELECT
        count(*) FILTER (WHERE included AND status = 'active')::int AS active_sessions,
        count(*) FILTER (WHERE included AND status = 'archived')::int AS archived_sessions,
        count(*) FILTER (WHERE included AND status = 'deleted')::int AS deleted_sessions,
        count(*) FILTER (WHERE NOT included AND status = 'active')::int AS excluded_active_sessions,
        count(*) FILTER (WHERE NOT included AND status = 'archived')::int AS excluded_archived_sessions,
        count(*) FILTER (WHERE NOT included AND status = 'deleted')::int AS excluded_deleted_sessions
      FROM session_scope
    ),
    message_metrics AS (
      SELECT
        count(*) FILTER (WHERE included)::int AS messages_24h,
        count(*) FILTER (WHERE included AND role = 'user')::int AS user_messages_24h,
        count(*) FILTER (WHERE included AND role = 'assistant')::int AS assistant_messages_24h,
        count(*) FILTER (WHERE NOT included)::int AS excluded_messages_24h
      FROM message_scope
    ),
    moderation_metrics AS (
      SELECT
        count(*) FILTER (WHERE included)::int AS moderation_events_24h,
        count(*) FILTER (WHERE included AND status = 'blocked')::int AS blocked_moderation_24h,
        count(*) FILTER (WHERE included AND status = 'flagged')::int AS flagged_moderation_24h,
        count(*) FILTER (WHERE NOT included)::int AS excluded_moderation_events_24h
      FROM moderation_scope
    ),
    usage_metrics AS (
      SELECT
        COALESCE(sum(messages_used) FILTER (WHERE included), 0)::int AS messages_used_today,
        count(*) FILTER (WHERE included AND messages_used >= ${FREE_DAILY_MESSAGES})::int AS users_at_daily_limit,
        count(*) FILTER (WHERE NOT included)::int AS excluded_usage_rows_today,
        COALESCE(sum(messages_used) FILTER (WHERE NOT included), 0)::int AS excluded_messages_used_today
      FROM usage_scope
    )
    SELECT
      session_metrics.active_sessions AS "activeSessions",
      session_metrics.archived_sessions AS "archivedSessions",
      session_metrics.deleted_sessions AS "deletedSessions",
      message_metrics.messages_24h AS "messages24h",
      message_metrics.user_messages_24h AS "userMessages24h",
      message_metrics.assistant_messages_24h AS "assistantMessages24h",
      moderation_metrics.moderation_events_24h AS "moderationEvents24h",
      moderation_metrics.blocked_moderation_24h AS "blockedModeration24h",
      moderation_metrics.flagged_moderation_24h AS "flaggedModeration24h",
      usage_metrics.messages_used_today AS "messagesUsedToday",
      usage_metrics.users_at_daily_limit AS "usersAtDailyLimit",
      (
        SELECT count(*)::int FROM "users" u
        WHERE u.status = 'active' AND u."deletedAt" IS NULL AND u."dataClass" = 'customer'
      ) AS "activeAuthorityUsers",
      session_metrics.excluded_active_sessions AS "excludedActiveSessions",
      session_metrics.excluded_archived_sessions AS "excludedArchivedSessions",
      session_metrics.excluded_deleted_sessions AS "excludedDeletedSessions",
      message_metrics.excluded_messages_24h AS "excludedMessages24h",
      moderation_metrics.excluded_moderation_events_24h AS "excludedModerationEvents24h",
      usage_metrics.excluded_usage_rows_today AS "excludedUsageRowsToday",
      usage_metrics.excluded_messages_used_today AS "excludedMessagesUsedToday"
    FROM session_metrics
    CROSS JOIN message_metrics
    CROSS JOIN moderation_metrics
    CROSS JOIN usage_metrics
  `);
  const scoped = rows[0];
  if (!scoped) throw new Error("Main Chat Ops overview returned no aggregate row");
  return {
    configured: true,
    diagnostics: mainOwnedDiagnostics(),
    overview: {
      activeSessions: scoped.activeSessions,
      archivedSessions: scoped.archivedSessions,
      deletedSessions: scoped.deletedSessions,
      messages24h: scoped.messages24h,
      userMessages24h: scoped.userMessages24h,
      assistantMessages24h: scoped.assistantMessages24h,
      moderationEvents24h: scoped.moderationEvents24h,
      blockedModeration24h: scoped.blockedModeration24h,
      flaggedModeration24h: scoped.flaggedModeration24h,
      messagesUsedToday: scoped.messagesUsedToday,
      usersAtDailyLimit: scoped.usersAtDailyLimit,
      unlimitedEntitlements: await countUnlimitedChatUsers(),
      freeDailyLimit: FREE_DAILY_MESSAGES,
      windowHours: 24,
      dataScope: {
        userAuthority: "main.users",
        includedUserStatus: "active",
        includedDeletedAt: null,
        includedDataClass: "customer",
        activeAuthorityUsers: scoped.activeAuthorityUsers,
        excluded: {
          activeSessions: scoped.excludedActiveSessions,
          archivedSessions: scoped.excludedArchivedSessions,
          deletedSessions: scoped.excludedDeletedSessions,
          messages24h: scoped.excludedMessages24h,
          moderationEvents24h: scoped.excludedModerationEvents24h,
          usageRowsToday: scoped.excludedUsageRowsToday,
          messagesUsedToday: scoped.excludedMessagesUsedToday,
        },
      },
    },
  };
}

async function countUnlimitedChatUsers() {
  const now = new Date();
  let afterId: string | undefined;
  let count = 0;
  while (true) {
    // A cache row only nominates a candidate. The purchased-offer projection
    // below decides whether that user actually has unlimited access.
    const candidates = await prisma.user.findMany({
      where: {
        ...CUSTOMER_USER,
        OR: [
          { subscriptions: { some: { status: "active" } } },
          { entitlements: { some: {
            key: "unlimited_messages", value: { equals: true },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          } } },
        ],
      },
      select: { id: true }, orderBy: { id: "asc" }, take: 500,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    });
    const values = await entitlementMaps(candidates.map((user) => user.id), prisma, now);
    for (const entitlements of values.values()) if (entitlements.unlimited_messages === true) count++;
    if (candidates.length < 500) return count;
    afterId = candidates.at(-1)!.id;
  }
}

export async function chatOpsProviderHealth(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const outcome = await fetchChatRuntimeDiagnostics();
  const runtime = outcome.data?.runtime;
  const runtimeReady = Boolean(
    runtime?.accepting && runtime.warmed && runtime.fileStore && runtime.redis &&
    runtime.agentRuntime && runtime.fresh,
  );
  const chatItem = outcome.data ? {
    provider: "chat_model",
    adapter: outcome.data.provider.adapter,
    status: outcome.data.provider.adapter === "mock" ? "mock" : runtimeReady ? "ok" : "degraded",
    ok: outcome.data.provider.adapter !== "mock" && runtimeReady,
    model: outcome.data.provider.model,
    endpoint: outcome.data.provider.endpoint,
    latencyMs: null,
    httpStatus: 200,
    modelListed: null,
    error: outcome.data.provider.adapter === "mock"
      ? "CHAT_MODEL_PROVIDER=mock"
      : runtimeReady ? null : runtime?.reason ?? "runtime_not_ready",
  } : null;
  return {
    configured: outcome.configured,
    diagnostics: outcome.diagnostics,
    checkedAt: outcome.data?.checkedAt ?? new Date().toISOString(),
    items: [
      ...(chatItem ? [chatItem] : []),
      {
        provider: "chat_moderation",
        adapter: env.MODERATION_PROVIDER,
        status: env.MODERATION_PROVIDER === "mock" ? "mock" : "configured",
        ok: true,
        model: null,
        endpoint: env.MODERATION_PROVIDER === "mock" ? null : env.MODERATION_SERVICE_URL ?? null,
        latencyMs: null,
        httpStatus: null,
        modelListed: null,
        error: null,
      },
    ],
  };
}

export async function chatOpsSessions(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/sessions");
  const queryIdentity = {
    userId: query.userId,
    characterId: query.characterId,
    status: query.status && query.status !== "all" ? query.status : "all",
  };
  const keys = query.cursor
    ? decodeAdminListCursor(query.cursor, "chat_ops_sessions", queryIdentity)
    : null;
  if (keys) assertCursorKeyCount(keys, 3, "chat_ops_sessions");
  // Main hard-deletes product sessions. The retained filter is a stable Admin
  // contract, but there is deliberately no recoverable deleted-session row.
  if (query.status === "deleted") {
    return {
      configured: true,
      diagnostics: mainOwnedDiagnostics(),
      items: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }
  const conditions: Prisma.RecentChatWhereInput[] = [
    { user: { is: CUSTOMER_USER } },
    ...(query.userId ? [{ userId: query.userId }] : []),
    ...(query.characterId ? [{ characterId: query.characterId }] : []),
    query.status && query.status !== "all"
      ? { status: query.status }
      : { status: { not: "deleted" } },
  ];
  if (keys) conditions.push(sessionCursorWhere(keys));
  const rows = await prisma.recentChat.findMany({
    where: { AND: conditions },
    orderBy: [
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { sessionId: "desc" },
    ],
    take: query.limit + 1,
    include: {
      turns: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          assistantMessageId: true,
          assistantStatus: true,
          userStatus: true,
          model: true,
          promptTokens: true,
          completionTokens: true,
        },
      },
      _count: { select: { turns: true } },
    },
  });
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  return {
    configured: true,
    diagnostics: mainOwnedDiagnostics(),
    items: page.map((row) => {
      const last = row.turns[0];
      const hasOpening = row.openingMessage !== null;
      const lastTokenCount = last && (last.promptTokens !== null || last.completionTokens !== null)
        ? (last.promptTokens ?? 0) + (last.completionTokens ?? 0)
        : null;
      return {
        id: row.sessionId,
        userId: row.userId,
        characterId: row.characterId,
        title: row.title,
        status: row.status,
        memoryEnabled: row.memoryEnabled,
        messageCount: row._count.turns * 2 + (hasOpening ? 1 : 0),
        lastMessageId: last?.assistantMessageId ?? (hasOpening ? `opening:${row.sessionId}` : null),
        lastMessageRole: last || hasOpening ? "assistant" : null,
        lastMessageStatus: last?.assistantStatus ?? (hasOpening ? "sent" : null),
        lastSafetyStatus: last ? (last.userStatus === "blocked" ? "blocked" : "passed") : null,
        lastModel: last?.model ?? null,
        lastTokenCount,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage && page.at(-1)
        ? encodeAdminListCursor("chat_ops_sessions", queryIdentity, [
            page.at(-1)!.lastMessageAt?.toISOString() ?? null,
            page.at(-1)!.createdAt.toISOString(),
            page.at(-1)!.sessionId,
          ])
        : null,
    },
  };
}

export async function chatOpsUsage(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/usage");
  const periodStart = startOfUtcDay();
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1_000);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const queryIdentity = { userId: query.userId, periodStart: periodStart.toISOString() };
  const keys = query.cursor
    ? decodeAdminListCursor(query.cursor, "chat_ops_usage", queryIdentity)
    : null;
  if (keys) assertCursorKeyCount(keys, 3, "chat_ops_usage");
  const innerConditions: Prisma.Sql[] = [
    Prisma.sql`f."productDay" = ${periodStart}`,
    Prisma.sql`u.status = 'active'`,
    Prisma.sql`u."deletedAt" IS NULL`,
    Prisma.sql`u."dataClass" = 'customer'`,
  ];
  if (query.userId) innerConditions.push(Prisma.sql`f."userId" = ${query.userId}`);
  const outerConditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (keys) {
    const messagesUsed = cursorNumber(keys, 0, "chat_ops_usage");
    const updatedAt = cursorDate(keys, 1, "chat_ops_usage");
    const userId = cursorString(keys, 2, "chat_ops_usage");
    outerConditions.push(Prisma.sql`
      (
        usage."messagesUsed" < ${messagesUsed}
        OR (usage."messagesUsed" = ${messagesUsed} AND usage."updatedAt" < ${updatedAt})
        OR (
          usage."messagesUsed" = ${messagesUsed}
          AND usage."updatedAt" = ${updatedAt}
          AND usage."userId" < ${userId}
        )
      )
    `);
  }
  const rows = await prisma.$queryRaw<Array<{
    userId: string;
    messagesUsed: number;
    updatedAt: Date;
  }>>(Prisma.sql`
    WITH usage AS (
      SELECT
        f."userId" AS "userId",
        count(*)::int AS "messagesUsed",
        max(f."createdAt") AS "updatedAt"
      FROM "chat_turn_usage_facts" f
      JOIN "users" u ON u.id = f."userId"
      WHERE ${Prisma.join(innerConditions, " AND ")}
      GROUP BY f."userId"
    )
    SELECT usage."userId", usage."messagesUsed", usage."updatedAt"
    FROM usage
    WHERE ${Prisma.join(outerConditions, " AND ")}
    ORDER BY usage."messagesUsed" DESC, usage."updatedAt" DESC, usage."userId" DESC
    LIMIT ${query.limit + 1}
  `);
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const userIds = page.map((row) => row.userId);
  const [entitlements, sessions] = userIds.length === 0
    ? [new Map<string, Record<string, Prisma.JsonValue>>(), []] as const
    : await Promise.all([
        entitlementMaps(userIds),
        prisma.recentChat.findMany({
          where: { userId: { in: userIds } },
          select: {
            userId: true,
            status: true,
            openingMessage: true,
            createdAt: true,
            turns: { where: { createdAt: { gte: since } }, select: { id: true } },
          },
        }),
      ]);
  const sessionsByUser = groupBy(sessions, (row) => row.userId);
  const items = page.map((row) => {
    const values = new Map(Object.entries(entitlements.get(row.userId) ?? {}));
    const userSessions = sessionsByUser.get(row.userId) ?? [];
    const unlimitedMessages = jsonBoolean(values.get("unlimited_messages"));
    const freeRemaining = unlimitedMessages
      ? null
      : Math.max(0, FREE_DAILY_MESSAGES - row.messagesUsed);
    const messages24h = userSessions.reduce(
      (count, session) => count + session.turns.length * 2 + (
        session.openingMessage !== null && session.createdAt >= since ? 1 : 0
      ),
      0,
    );
    return {
      userId: row.userId,
      sessionId: null,
      modelTier: planTier(values),
      unlimitedMessages,
      voiceEnabled: jsonBoolean(values.get("voice_enabled")),
      messagesUsed: row.messagesUsed,
      freeDailyLimit: FREE_DAILY_MESSAGES,
      freeRemaining,
      quotaStatus: unlimitedMessages
        ? "unlimited" as const
        : row.messagesUsed >= FREE_DAILY_MESSAGES ? "free_at_limit" as const : "free_remaining" as const,
      activeSessions: userSessions.filter((session) => session.status === "active").length,
      messages24h,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
  const last = page.at(-1);
  return {
    configured: true,
    diagnostics: mainOwnedDiagnostics(),
    freeDailyLimit: FREE_DAILY_MESSAGES,
    items,
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("chat_ops_usage", queryIdentity, [
            last.messagesUsed,
            last.updatedAt.toISOString(),
            last.userId,
          ])
        : null,
    },
  };
}

export async function chatOpsModerationEvents(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/moderation-events");
  const queryIdentity = {
    status: query.status,
    layer: query.layer,
    policyCode: query.policyCode,
    targetType: query.targetType,
    targetId: query.targetId,
  };
  const keys = query.cursor
    ? decodeAdminListCursor(query.cursor, "chat_ops_moderation_events", queryIdentity)
    : null;
  if (keys) assertCursorKeyCount(keys, 2, "chat_ops_moderation_events");
  const conditions: Prisma.Sql[] = [
    Prisma.sql`e."targetType" = 'chat_turn'`,
    Prisma.sql`u.status = 'active'`,
    Prisma.sql`u."deletedAt" IS NULL`,
    Prisma.sql`u."dataClass" = 'customer'`,
  ];
  if (query.status && query.status !== "all") conditions.push(Prisma.sql`e.status = ${query.status}`);
  if (query.layer && query.layer !== "all") conditions.push(Prisma.sql`e.layer = ${query.layer}`);
  if (query.policyCode) conditions.push(Prisma.sql`e."policyCode" = ${query.policyCode}`);
  if (query.targetType) conditions.push(Prisma.sql`e."targetType" = ${query.targetType}`);
  if (query.targetId) conditions.push(Prisma.sql`e."targetId" = ${query.targetId}`);
  if (keys) {
    const createdAt = cursorDate(keys, 0, "chat_ops_moderation_events");
    const id = cursorString(keys, 1, "chat_ops_moderation_events");
    conditions.push(Prisma.sql`
      (e."createdAt" < ${createdAt} OR (e."createdAt" = ${createdAt} AND e.id < ${id}))
    `);
  }
  const rows = await prisma.$queryRaw<Array<{
    id: string;
    targetType: string;
    targetId: string;
    layer: string;
    status: string;
    policyCode: string | null;
    confidence: number | null;
    createdAt: Date;
  }>>(Prisma.sql`
    SELECT
      e.id,
      e."targetType" AS "targetType",
      e."targetId" AS "targetId",
      e.layer,
      e.status,
      e."policyCode" AS "policyCode",
      e.confidence,
      e."createdAt" AS "createdAt"
    FROM "moderation_events" e
    JOIN "chat_turns" t ON t.id = e."targetId"
    JOIN "recent_chats" s ON s."sessionId" = t."sessionId"
    JOIN "users" u ON u.id = s."userId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY e."createdAt" DESC, e.id DESC
    LIMIT ${query.limit + 1}
  `);
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    configured: true,
    diagnostics: mainOwnedDiagnostics(),
    items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("chat_ops_moderation_events", queryIdentity, [
            last.createdAt.toISOString(),
            last.id,
          ])
        : null,
    },
  };
}

function sessionCursorWhere(keys: readonly unknown[]): Prisma.RecentChatWhereInput {
  if (keys.length !== 3) throw Errors.badRequest("chat_ops_sessions cursor key count is invalid");
  const createdAt = cursorDate(keys, 1, "chat_ops_sessions");
  const sessionId = cursorString(keys, 2, "chat_ops_sessions");
  if (keys[0] === null) {
    return {
      lastMessageAt: null,
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, sessionId: { lt: sessionId } },
      ],
    };
  }
  const lastMessageAt = cursorDate(keys, 0, "chat_ops_sessions");
  return {
    OR: [
      { lastMessageAt: { lt: lastMessageAt } },
      { lastMessageAt, createdAt: { lt: createdAt } },
      { lastMessageAt, createdAt, sessionId: { lt: sessionId } },
      { lastMessageAt: null },
    ],
  };
}

function cursorDate(keys: readonly unknown[], index: number, scope: string): Date {
  if (keys.length <= index) throw Errors.badRequest(`${scope} cursor key count is invalid`);
  return parseIsoCursorKey(keys[index], scope);
}

function cursorString(keys: readonly unknown[], index: number, scope: string): string {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function cursorNumber(keys: readonly unknown[], index: number, scope: string): number {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Errors.badRequest(`${scope} cursor key is invalid`);
  }
  return value;
}

function assertCursorKeyCount(keys: readonly unknown[], count: number, scope: string): void {
  if (keys.length !== count) throw Errors.badRequest(`${scope} cursor key count is invalid`);
}

function mainOwnedDiagnostics(): ChatOpsDiagnostics {
  return { serviceUrlConfigured: Boolean(env.CHAT_SERVICE_URL) };
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const bucket = grouped.get(id);
    if (bucket) bucket.push(item);
    else grouped.set(id, [item]);
  }
  return grouped;
}

function planTier(entitlements: Map<string, unknown>): string {
  const plan = record(entitlements.get("plan"));
  const slug = String(plan?.slug ?? "");
  if (slug.includes("deluxe") || jsonBoolean(entitlements.get("video_generation"))) return "deluxe";
  if (slug.includes("premium") || jsonBoolean(entitlements.get("premium_controls"))) return "premium";
  return "free";
}

function jsonBoolean(value: unknown): boolean {
  return value === true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
