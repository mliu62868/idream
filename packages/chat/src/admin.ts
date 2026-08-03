// SPEC: chat 服务内部 admin 只读 API（ADMIN_PHASE2_DESIGN §5 F6）。供 main-web 的
// 管理控制台经 INTERNAL_TOKEN 代理调用，给运营「会话/额度/审核事件」可见性与排障。
// INTENT: 只读、脱敏——绝不回明文 message.content / moderation.details；尊重 DB 边界
// （main 不直连 chat DB，统一走这里）。鉴权在 web.ts 用 x-internal-token 完成，本模块只查数。
// INVARIANTS: 仅 GET；未知路径 404；返回不含明文聊天内容；运营口径只纳入
// core.chat_user_view 中 active 且未删除的权威用户，旧 chat 行保留但默认排除。
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../generated/client/client.js";
import { chatPrisma } from "./db.js";
import { env } from "./env.js";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { pipelineEndpoint } from "@idream/shared/env";

export interface ChatAdminRequest {
  method: string;
  path: string; // /internal/admin/...
  query?: Record<string, string>;
}

export interface ChatAdminResponse {
  status: number;
  body: unknown;
}

const PREFIX = "/internal/admin";

export async function dispatchChatAdmin(req: ChatAdminRequest): Promise<ChatAdminResponse> {
  if (!req.path.startsWith(PREFIX)) return { status: 404, body: { error: "not_found" } };
  if (req.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
  const rest = req.path.slice(PREFIX.length).replace(/\/+$/, "");

  try {
    if (rest === "/overview") return { status: 200, body: await overview() };
    if (rest === "/provider-health") return { status: 200, body: await providerHealth() };
    if (rest === "/sessions") return { status: 200, body: await sessions(req.query) };
    if (rest === "/usage") return { status: 200, body: await usage(req.query) };
    if (rest === "/moderation-events") {
      return { status: 200, body: await moderationEvents(req.query) };
    }
  } catch (error) {
    if (error instanceof ChatAdminCursorError) {
      return { status: 400, body: { error: "invalid_cursor", message: error.message } };
    }
    if (error instanceof z.ZodError) {
      return { status: 400, body: { error: "invalid_query", issues: error.issues } };
    }
    throw error;
  }
  return { status: 404, body: { error: "not_found", path: req.path } };
}

async function overview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = startOfUtcDay();
  const rows = await chatPrisma.$queryRaw<Array<{
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
    unlimitedEntitlements: number;
    activeAuthorityUsers: number;
    excludedActiveSessions: number;
    excludedArchivedSessions: number;
    excludedDeletedSessions: number;
    excludedMessages24h: number;
    excludedModerationEvents24h: number;
    excludedUsageRowsToday: number;
    excludedMessagesUsedToday: number;
  }>>`
    WITH session_scope AS (
      SELECT
        s.status AS session_status,
        s.deleted_at AS session_deleted_at,
        (
          u.user_id IS NOT NULL
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND u.data_class = 'customer'
        ) AS included
      FROM chat.chat_sessions s
      LEFT JOIN core.chat_user_view u ON u.user_id = s.user_id
    ),
    message_scope AS (
      SELECT
        m.role,
        (
          u.user_id IS NOT NULL
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND u.data_class = 'customer'
        ) AS included
      FROM chat.messages m
      JOIN chat.chat_sessions s ON s.id = m.session_id
      LEFT JOIN core.chat_user_view u ON u.user_id = s.user_id
      WHERE m.created_at >= ${since}
    ),
    moderation_scope AS (
      SELECT
        e.status AS event_status,
        (
          u.user_id IS NOT NULL
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND u.data_class = 'customer'
        ) AS included
      FROM chat.chat_moderation_events e
      LEFT JOIN chat.messages m
        ON e.target_type = 'message'
       AND m.id = e.target_id
      LEFT JOIN chat.chat_sessions message_session
        ON message_session.id = m.session_id
      LEFT JOIN chat.chat_sessions target_session
        ON e.target_type = 'session'
       AND target_session.id = e.target_id
      LEFT JOIN core.chat_user_view u
        ON u.user_id = CASE
          WHEN e.target_type = 'message' THEN message_session.user_id
          WHEN e.target_type = 'session' THEN target_session.user_id
          WHEN e.target_type = 'user' THEN e.target_id
          ELSE NULL
        END
      WHERE e.created_at >= ${since}
    ),
    usage_scope AS (
      SELECT
        cu.messages_used,
        (
          u.user_id IS NOT NULL
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND u.data_class = 'customer'
        ) AS included
      FROM chat.chat_usage cu
      LEFT JOIN core.chat_user_view u ON u.user_id = cu.user_id
      WHERE cu.period_start = ${today}
    ),
    entitlement_scope AS (
      SELECT
        ce.unlimited_messages,
        (
          u.user_id IS NOT NULL
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND u.data_class = 'customer'
        ) AS included
      FROM billing.chat_entitlement_view ce
      LEFT JOIN core.chat_user_view u ON u.user_id = ce.user_id
    ),
    session_metrics AS (
      SELECT
        count(*) FILTER (
          WHERE included
            AND session_status = 'active'
            AND session_deleted_at IS NULL
        )::int AS active_sessions,
        count(*) FILTER (
          WHERE included AND session_status = 'archived'
        )::int AS archived_sessions,
        count(*) FILTER (
          WHERE included AND session_status = 'deleted'
        )::int AS deleted_sessions,
        count(*) FILTER (
          WHERE NOT included
            AND session_status = 'active'
            AND session_deleted_at IS NULL
        )::int AS excluded_active_sessions,
        count(*) FILTER (
          WHERE NOT included AND session_status = 'archived'
        )::int AS excluded_archived_sessions,
        count(*) FILTER (
          WHERE NOT included AND session_status = 'deleted'
        )::int AS excluded_deleted_sessions
      FROM session_scope
    ),
    message_metrics AS (
      SELECT
        count(*) FILTER (WHERE included)::int AS messages_24h,
        count(*) FILTER (
          WHERE included AND role = 'user'
        )::int AS user_messages_24h,
        count(*) FILTER (
          WHERE included AND role = 'assistant'
        )::int AS assistant_messages_24h,
        count(*) FILTER (WHERE NOT included)::int AS excluded_messages_24h
      FROM message_scope
    ),
    moderation_metrics AS (
      SELECT
        count(*) FILTER (WHERE included)::int AS moderation_events_24h,
        count(*) FILTER (
          WHERE included AND event_status = 'blocked'
        )::int AS blocked_moderation_24h,
        count(*) FILTER (
          WHERE included AND event_status = 'flagged'
        )::int AS flagged_moderation_24h,
        count(*) FILTER (
          WHERE NOT included
        )::int AS excluded_moderation_events_24h
      FROM moderation_scope
    ),
    usage_metrics AS (
      SELECT
        COALESCE(
          sum(messages_used) FILTER (WHERE included),
          0
        )::double precision AS messages_used_today,
        count(*) FILTER (
          WHERE included AND messages_used >= ${FREE_DAILY_MESSAGES}
        )::int AS users_at_daily_limit,
        count(*) FILTER (
          WHERE NOT included
        )::int AS excluded_usage_rows_today,
        COALESCE(
          sum(messages_used) FILTER (WHERE NOT included),
          0
        )::double precision AS excluded_messages_used_today
      FROM usage_scope
    ),
    entitlement_metrics AS (
      SELECT
        count(*) FILTER (
          WHERE included AND unlimited_messages
        )::int AS unlimited_entitlements
      FROM entitlement_scope
    ),
    authority_metrics AS (
      SELECT count(*)::int AS active_authority_users
      FROM core.chat_user_view
      WHERE status = 'active'
        AND deleted_at IS NULL
        AND data_class = 'customer'
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
      entitlement_metrics.unlimited_entitlements AS "unlimitedEntitlements",
      authority_metrics.active_authority_users AS "activeAuthorityUsers",
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
    CROSS JOIN entitlement_metrics
    CROSS JOIN authority_metrics
  `;
  const scoped = rows[0];
  if (!scoped) throw new Error("Chat admin overview scope query returned no row");
  return {
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
    unlimitedEntitlements: scoped.unlimitedEntitlements,
    freeDailyLimit: FREE_DAILY_MESSAGES,
    windowHours: 24,
    dataScope: {
      userAuthority: "core.chat_user_view",
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
  };
}

async function providerHealth() {
  const checkedAt = new Date().toISOString();
  const [chatModel] = await Promise.all([chatModelHealth()]);
  return {
    checkedAt,
    items: [
      chatModel,
      {
        provider: "chat_moderation",
        adapter: env.MODERATION_PROVIDER,
        status: env.MODERATION_PROVIDER === "mock" ? "mock" : "configured",
        ok: true,
        model: null,
        endpoint: env.MODERATION_PROVIDER === "mock" ? null : endpointLabel(env.MODERATION_SERVICE_URL),
        latencyMs: null,
        httpStatus: null,
        error: null,
      },
    ],
  };
}

async function chatModelHealth() {
  const startedAt = Date.now();
  const provider = env.CHAT_MODEL_PROVIDER;
  if (provider === "mock") {
    return {
      provider: "chat_model",
      adapter: provider,
      status: "mock",
      ok: false,
      model: env.CHAT_MODEL_NAME,
      endpoint: null,
      latencyMs: null,
      httpStatus: null,
      modelListed: null,
      error: "CHAT_MODEL_PROVIDER=mock",
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(env.CHAT_MODEL_TIMEOUT_MS, 3_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatModelsEndpoint(env.CHAT_MODEL_BASE_URL), {
      headers: env.CHAT_MODEL_API_KEY
        ? { authorization: `Bearer ${env.CHAT_MODEL_API_KEY}` }
        : undefined,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    const modelListed = modelListIncludes(body, env.CHAT_MODEL_NAME);
    const ok = response.ok && modelListed !== false;
    return {
      provider: "chat_model",
      adapter: provider,
      status: ok ? "ok" : response.ok ? "model_not_listed" : "http_error",
      ok,
      model: env.CHAT_MODEL_NAME,
      endpoint: endpointLabel(env.CHAT_MODEL_BASE_URL),
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
      modelListed,
      error: ok ? null : response.ok ? "configured model was not present in /models" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      provider: "chat_model",
      adapter: provider,
      status: "unreachable",
      ok: false,
      model: env.CHAT_MODEL_NAME,
      endpoint: endpointLabel(env.CHAT_MODEL_BASE_URL),
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      modelListed: null,
      error: controller.signal.aborted
        ? `provider health timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const listLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const sessionsQuerySchema = z.object({
  userId: z.string().trim().min(1).max(200).optional(),
  characterId: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "archived", "deleted", "all"]).optional(),
  limit: listLimitSchema,
  cursor: z.string().min(1).optional(),
}).strict();
const usageQuerySchema = z.object({
  userId: z.string().trim().min(1).max(200).optional(),
  limit: listLimitSchema,
  cursor: z.string().min(1).optional(),
}).strict();
const moderationEventsQuerySchema = z.object({
  status: z.enum(["all", "blocked", "flagged", "passed"]).optional(),
  layer: z.enum(["all", "input", "output"]).optional(),
  policyCode: z.string().trim().min(1).max(200).optional(),
  targetType: z.string().trim().min(1).max(100).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
  limit: listLimitSchema,
  cursor: z.string().min(1).optional(),
}).strict();

async function sessions(rawQuery?: Record<string, string>) {
  const query = sessionsQuerySchema.parse(rawQuery ?? {});
  const { userId, characterId, status, limit } = query;
  const queryIdentity = { userId, characterId, status: status && status !== "all" ? status : "all" };
  const cursorKeys = decodeChatAdminCursor(query.cursor, "sessions", queryIdentity);
  const conditions: Prisma.Sql[] = [
    Prisma.sql`u.status = 'active'`,
    Prisma.sql`u.deleted_at IS NULL`,
    Prisma.sql`u.data_class = 'customer'`,
  ];
  if (userId) conditions.push(Prisma.sql`s.user_id = ${userId}`);
  if (characterId) conditions.push(Prisma.sql`s.character_id = ${characterId}`);
  if (status && status !== "all") {
    conditions.push(Prisma.sql`s.status = ${status}`);
  } else {
    conditions.push(Prisma.sql`s.status <> 'deleted'`);
  }
  if (cursorKeys) {
    const lastMessageValue = cursorKeys[0];
    const createdAt = chatCursorDate(cursorKeys, 1, "sessions");
    const id = chatCursorString(cursorKeys, 2, "sessions");
    if (lastMessageValue === null) {
      conditions.push(Prisma.sql`
        s.last_message_at IS NULL
        AND (
          s.created_at < ${createdAt}
          OR (s.created_at = ${createdAt} AND s.id < ${id})
        )
      `);
    } else {
      const lastMessageAt = chatCursorDate(cursorKeys, 0, "sessions");
      conditions.push(Prisma.sql`
        (
          s.last_message_at < ${lastMessageAt}
          OR (
            s.last_message_at = ${lastMessageAt}
            AND s.created_at < ${createdAt}
          )
          OR (
            s.last_message_at = ${lastMessageAt}
            AND s.created_at = ${createdAt}
            AND s.id < ${id}
          )
          OR s.last_message_at IS NULL
        )
      `);
    }
  }
  // Apply the authority join before LIMIT so a prefix of orphan/E2E rows cannot
  // consume the page and manufacture a false empty state.
  const scopedIds = await chatPrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT s.id
    FROM chat.chat_sessions s
    JOIN core.chat_user_view u ON u.user_id = s.user_id
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY
      s.last_message_at DESC NULLS LAST,
      s.created_at DESC,
      s.id DESC
    LIMIT ${limit + 1}
  `);
  const pageIds = scopedIds.slice(0, limit).map((row) => row.id);
  const unorderedRows = await chatPrisma.chatSession.findMany({
    where: { id: { in: pageIds } },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      userId: true,
      characterId: true,
      title: true,
      status: true,
      memoryEnabled: true,
      lastMessageAt: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          role: true,
          status: true,
          safetyStatus: true,
          model: true,
          tokenCount: true,
          createdAt: true,
        },
      },
      _count: { select: { messages: true } },
    },
  });
  const rowsById = new Map(unorderedRows.map((row) => [row.id, row]));
  const page = pageIds
    .map((id) => rowsById.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  // 不回明文 content：只暴露元数据 + 消息计数。
  const items = page.map((row) => ({
    id: row.id,
    userId: row.userId,
    characterId: row.characterId,
    title: row.title,
    status: row.status,
    memoryEnabled: row.memoryEnabled,
    messageCount: row._count.messages,
    lastMessageId: row.messages[0]?.id ?? null,
    lastMessageRole: row.messages[0]?.role ?? null,
    lastMessageStatus: row.messages[0]?.status ?? null,
    lastSafetyStatus: row.messages[0]?.safetyStatus ?? null,
    lastModel: row.messages[0]?.model ?? null,
    lastTokenCount: row.messages[0]?.tokenCount ?? null,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  return {
    items,
    pageInfo: chatAdminPageInfo("sessions", queryIdentity, page, scopedIds.length > limit, (row) => [
      row.lastMessageAt?.toISOString() ?? null,
      row.createdAt.toISOString(),
      row.id,
    ]),
  };
}

async function usage(rawQuery?: Record<string, string>) {
  const query = usageQuerySchema.parse(rawQuery ?? {});
  const { userId, limit } = query;
  const periodStart = startOfUtcDay();
  const queryIdentity = { userId, periodStart: periodStart.toISOString() };
  const cursorKeys = decodeChatAdminCursor(query.cursor, "usage", queryIdentity);
  const conditions: Prisma.Sql[] = [
    Prisma.sql`u.status = 'active'`,
    Prisma.sql`u.deleted_at IS NULL`,
    Prisma.sql`u.data_class = 'customer'`,
    Prisma.sql`cu.period_start = ${periodStart}`,
  ];
  if (userId) conditions.push(Prisma.sql`cu.user_id = ${userId}`);
  if (cursorKeys) {
    const messagesUsed = chatCursorNumber(cursorKeys, 0, "usage");
    const updatedAt = chatCursorDate(cursorKeys, 1, "usage");
    const id = chatCursorString(cursorKeys, 2, "usage");
    conditions.push(Prisma.sql`
      (
        cu.messages_used < ${messagesUsed}
        OR (
          cu.messages_used = ${messagesUsed}
          AND cu.updated_at < ${updatedAt}
        )
        OR (
          cu.messages_used = ${messagesUsed}
          AND cu.updated_at = ${updatedAt}
          AND cu.id < ${id}
        )
      )
    `);
  }
  const scopedIds = await chatPrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT cu.id
    FROM chat.chat_usage cu
    JOIN core.chat_user_view u ON u.user_id = cu.user_id
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY cu.messages_used DESC, cu.updated_at DESC, cu.id DESC
    LIMIT ${limit + 1}
  `);
  const pageIds = scopedIds.slice(0, limit).map((row) => row.id);
  const unorderedRows = await chatPrisma.chatUsage.findMany({
    where: { id: { in: pageIds } },
    orderBy: [{ messagesUsed: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      userId: true,
      sessionId: true,
      messagesUsed: true,
      periodStart: true,
      periodEnd: true,
      updatedAt: true,
    },
  });
  const rowsById = new Map(unorderedRows.map((row) => [row.id, row]));
  const page = pageIds
    .map((id) => rowsById.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  const items = await Promise.all(
    page.map(async (row) => {
      const [entitlement, activeSessions, messages24h] = await Promise.all([
        chatPrisma.chatEntitlementView.findUnique({ where: { userId: row.userId } }),
        chatPrisma.chatSession.count({
          where: { userId: row.userId, status: "active", deletedAt: null },
        }),
        chatPrisma.message.count({
          where: {
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            session: { userId: row.userId },
          },
        }),
      ]);
      const unlimitedMessages = entitlement?.unlimitedMessages ?? false;
      const freeRemaining = unlimitedMessages
        ? null
        : Math.max(0, FREE_DAILY_MESSAGES - row.messagesUsed);
      return {
        userId: row.userId,
        sessionId: row.sessionId,
        modelTier: entitlement?.modelTier ?? "free",
        unlimitedMessages,
        memoryMultiplier: entitlement?.memoryMultiplier ?? 1,
        voiceEnabled: entitlement?.voiceEnabled ?? false,
        messagesUsed: row.messagesUsed,
        freeDailyLimit: FREE_DAILY_MESSAGES,
        freeRemaining,
        quotaStatus: unlimitedMessages
          ? "unlimited"
          : row.messagesUsed >= FREE_DAILY_MESSAGES
            ? "free_at_limit"
            : "free_remaining",
        activeSessions,
        messages24h,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        updatedAt: row.updatedAt,
      };
    }),
  );
  return {
    items,
    freeDailyLimit: FREE_DAILY_MESSAGES,
    pageInfo: chatAdminPageInfo("usage", queryIdentity, page, scopedIds.length > limit, (row) => [
      row.messagesUsed,
      row.updatedAt.toISOString(),
      row.id,
    ]),
  };
}

async function moderationEvents(rawQuery?: Record<string, string>) {
  const query = moderationEventsQuerySchema.parse(rawQuery ?? {});
  const { limit, status, layer, policyCode, targetType, targetId } = query;
  const queryIdentity = { status, layer, policyCode, targetType, targetId };
  const cursorKeys = decodeChatAdminCursor(query.cursor, "moderation_events", queryIdentity);
  const conditions: Prisma.Sql[] = [
    Prisma.sql`u.status = 'active'`,
    Prisma.sql`u.deleted_at IS NULL`,
    Prisma.sql`u.data_class = 'customer'`,
  ];
  if (status && status !== "all") {
    conditions.push(Prisma.sql`e.status = ${status}`);
  }
  if (layer && layer !== "all") {
    conditions.push(Prisma.sql`e.layer = ${layer}`);
  }
  if (policyCode) {
    conditions.push(Prisma.sql`e.policy_code = ${policyCode}`);
  }
  if (targetType && targetType !== "all") {
    conditions.push(Prisma.sql`e.target_type = ${targetType}`);
  }
  if (targetId) {
    conditions.push(Prisma.sql`e.target_id = ${targetId}`);
  }
  if (cursorKeys) {
    const createdAt = chatCursorDate(cursorKeys, 0, "moderation_events");
    const id = chatCursorString(cursorKeys, 1, "moderation_events");
    conditions.push(Prisma.sql`
      (
        e.created_at < ${createdAt}
        OR (e.created_at = ${createdAt} AND e.id < ${id})
      )
    `);
  }
  // Resolve event ownership and apply authority scope before keyset LIMIT. This
  // keeps later authoritative rows reachable even when many newer orphan test
  // events exist. details is intentionally never selected.
  const rows = await chatPrisma.$queryRaw<Array<{
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
      e.target_type AS "targetType",
      e.target_id AS "targetId",
      e.layer,
      e.status,
      e.policy_code AS "policyCode",
      e.confidence,
      e.created_at AS "createdAt"
    FROM chat.chat_moderation_events e
    LEFT JOIN chat.messages m
      ON e.target_type = 'message'
     AND m.id = e.target_id
    LEFT JOIN chat.chat_sessions message_session
      ON message_session.id = m.session_id
    LEFT JOIN chat.chat_sessions target_session
      ON e.target_type = 'session'
     AND target_session.id = e.target_id
    JOIN core.chat_user_view u
      ON u.user_id = CASE
        WHEN e.target_type = 'message' THEN message_session.user_id
        WHEN e.target_type = 'session' THEN target_session.user_id
        WHEN e.target_type = 'user' THEN e.target_id
        ELSE NULL
      END
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limit + 1}
  `);
  const items = rows.slice(0, limit);
  return {
    items,
    pageInfo: chatAdminPageInfo("moderation_events", queryIdentity, items, rows.length > limit, (row) => [
      row.createdAt.toISOString(),
      row.id,
    ]),
  };
}

class ChatAdminCursorError extends Error {}

function cursorQueryHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decodeChatAdminCursor(raw: string | undefined, scope: string, queryIdentity: unknown) {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!isRecord(value) || value.version !== 1 || value.scope !== scope || value.queryHash !== cursorQueryHash(queryIdentity)) {
      throw new Error("cursor query mismatch");
    }
    const keys = value.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("cursor keys are invalid");
    }
    return keys as unknown[];
  } catch {
    throw new ChatAdminCursorError(`${scope} cursor is invalid for the selected query`);
  }
}

function chatCursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw new ChatAdminCursorError(`${scope} cursor key is invalid`);
  return value;
}

function chatCursorNumber(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ChatAdminCursorError(`${scope} cursor key is invalid`);
  return value;
}

function chatCursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = new Date(chatCursorString(keys, index, scope));
  if (Number.isNaN(value.getTime())) throw new ChatAdminCursorError(`${scope} cursor timestamp is invalid`);
  return value;
}

function chatAdminPageInfo<T>(
  scope: string,
  queryIdentity: unknown,
  page: readonly T[],
  hasNextPage: boolean,
  keys: (row: T) => readonly (string | number | boolean | null)[],
) {
  const last = page.at(-1);
  return {
    hasNextPage,
    endCursor: hasNextPage && last
      ? Buffer.from(JSON.stringify({
          version: 1,
          scope,
          queryHash: cursorQueryHash(queryIdentity),
          keys: keys(last),
        }), "utf8").toString("base64url")
      : null,
  };
}

function chatModelsEndpoint(baseUrl: string): URL {
  return pipelineEndpoint(baseUrl, "/models");
}

function modelListIncludes(value: unknown, model: string): boolean | null {
  if (!isRecord(value)) return null;
  const data = value.data;
  if (!Array.isArray(data)) return null;
  return data.some((item) => isRecord(item) && item.id === model);
}

function endpointLabel(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
