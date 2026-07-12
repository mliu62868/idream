// SPEC: chat 服务内部 admin 只读 API（ADMIN_PHASE2_DESIGN §5 F6）。供 main-web 的
// 管理控制台经 INTERNAL_TOKEN 代理调用，给运营「会话/额度/审核事件」可见性与排障。
// INTENT: 只读、脱敏——绝不回明文 message.content / moderation.details；尊重 DB 边界
// （main 不直连 chat DB，统一走这里）。鉴权在 web.ts 用 x-internal-token 完成，本模块只查数。
// INVARIANTS: 仅 GET；未知路径 404；返回不含明文聊天内容。
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../generated/client/client.js";
import { chatPrisma } from "./db.js";
import { env } from "./env.js";
import { FREE_DAILY_MESSAGES } from "./limits.js";

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
  const [
    activeSessions,
    archivedSessions,
    deletedSessions,
    messages24h,
    userMessages24h,
    assistantMessages24h,
    moderationEvents24h,
    blockedModeration24h,
    flaggedModeration24h,
    usageToday,
    usersAtDailyLimit,
    unlimitedEntitlements,
  ] = await Promise.all([
    chatPrisma.chatSession.count({ where: { status: "active", deletedAt: null } }),
    chatPrisma.chatSession.count({ where: { status: "archived" } }),
    chatPrisma.chatSession.count({ where: { status: "deleted" } }),
    chatPrisma.message.count({ where: { createdAt: { gte: since } } }),
    chatPrisma.message.count({ where: { role: "user", createdAt: { gte: since } } }),
    chatPrisma.message.count({ where: { role: "assistant", createdAt: { gte: since } } }),
    chatPrisma.chatModerationEvent.count({ where: { createdAt: { gte: since } } }),
    chatPrisma.chatModerationEvent.count({ where: { status: "blocked", createdAt: { gte: since } } }),
    chatPrisma.chatModerationEvent.count({ where: { status: "flagged", createdAt: { gte: since } } }),
    chatPrisma.chatUsage.aggregate({
      where: { periodStart: today },
      _sum: { messagesUsed: true },
    }),
    chatPrisma.chatUsage.count({
      where: { periodStart: today, messagesUsed: { gte: FREE_DAILY_MESSAGES } },
    }),
    chatPrisma.chatEntitlementView.count({ where: { unlimitedMessages: true } }),
  ]);
  return {
    activeSessions,
    archivedSessions,
    deletedSessions,
    messages24h,
    userMessages24h,
    assistantMessages24h,
    moderationEvents24h,
    blockedModeration24h,
    flaggedModeration24h,
    messagesUsedToday: usageToday._sum.messagesUsed ?? 0,
    usersAtDailyLimit,
    unlimitedEntitlements,
    freeDailyLimit: FREE_DAILY_MESSAGES,
    windowHours: 24,
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
      latencyMs: 0,
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
  const where: Prisma.ChatSessionWhereInput = {};
  if (userId) where.userId = userId;
  if (characterId) where.characterId = characterId;
  if (status && status !== "all") where.status = status;
  else where.status = { not: "deleted" };
  if (cursorKeys) {
    const lastMessageValue = cursorKeys[0];
    const createdAt = chatCursorDate(cursorKeys, 1, "sessions");
    const id = chatCursorString(cursorKeys, 2, "sessions");
    where.AND = lastMessageValue === null
      ? { lastMessageAt: null, OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] }
      : {
          OR: [
            { lastMessageAt: { lt: chatCursorDate(cursorKeys, 0, "sessions") } },
            { lastMessageAt: chatCursorDate(cursorKeys, 0, "sessions"), createdAt: { lt: createdAt } },
            { lastMessageAt: chatCursorDate(cursorKeys, 0, "sessions"), createdAt, id: { lt: id } },
            { lastMessageAt: null },
          ],
        };
  }
  const rows = await chatPrisma.chatSession.findMany({
    where,
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
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
  // 不回明文 content：只暴露元数据 + 消息计数。
  const page = rows.slice(0, limit);
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
    pageInfo: chatAdminPageInfo("sessions", queryIdentity, page, rows.length > limit, (row) => [
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
  const cursorWhere: Prisma.ChatUsageWhereInput | undefined = cursorKeys ? (() => {
    const messagesUsed = chatCursorNumber(cursorKeys, 0, "usage");
    const updatedAt = chatCursorDate(cursorKeys, 1, "usage");
    const id = chatCursorString(cursorKeys, 2, "usage");
    return { OR: [
      { messagesUsed: { lt: messagesUsed } },
      { messagesUsed, updatedAt: { lt: updatedAt } },
      { messagesUsed, updatedAt, id: { lt: id } },
    ] };
  })() : undefined;
  const rows = await chatPrisma.chatUsage.findMany({
    where: {
      periodStart,
      ...(userId ? { userId } : {}),
      AND: cursorWhere,
    },
    orderBy: [{ messagesUsed: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
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

  const page = rows.slice(0, limit);
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
    pageInfo: chatAdminPageInfo("usage", queryIdentity, page, rows.length > limit, (row) => [
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
  const where: Prisma.ChatModerationEventWhereInput = {};
  if (status && status !== "all") where.status = status;
  if (layer && layer !== "all") where.layer = layer;
  if (policyCode) where.policyCode = policyCode;
  if (targetType && targetType !== "all") where.targetType = targetType;
  if (targetId) where.targetId = targetId;
  if (cursorKeys) {
    const createdAt = chatCursorDate(cursorKeys, 0, "moderation_events");
    const id = chatCursorString(cursorKeys, 1, "moderation_events");
    where.AND = { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
  }
  const rows = await chatPrisma.chatModerationEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    // details（Json）可能含明文，故脱敏不返回。
    select: {
      id: true,
      targetType: true,
      targetId: true,
      layer: true,
      status: true,
      policyCode: true,
      confidence: true,
      createdAt: true,
    },
  });
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
  const url = new URL(baseUrl);
  if (url.pathname.endsWith("/models")) return url;
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/models`;
  return url;
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
