// SPEC: chat 服务内部 admin 只读 API（ADMIN_PHASE2_DESIGN §5 F6）。供 main-web 的
// 管理控制台经 INTERNAL_TOKEN 代理调用，给运营「会话/额度/审核事件」可见性与排障。
// INTENT: 只读、脱敏——绝不回明文 message.content / moderation.details；尊重 DB 边界
// （main 不直连 chat DB，统一走这里）。鉴权在 web.ts 用 x-internal-token 完成，本模块只查数。
// INVARIANTS: 仅 GET；未知路径 404；返回不含明文聊天内容。
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

  if (rest === "/overview") return { status: 200, body: await overview() };
  if (rest === "/provider-health") return { status: 200, body: await providerHealth() };
  if (rest === "/sessions") return { status: 200, body: await sessions(req.query) };
  if (rest === "/usage") return { status: 200, body: await usage(req.query) };
  if (rest === "/moderation-events") {
    return { status: 200, body: await moderationEvents(req.query) };
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

async function sessions(query?: Record<string, string>) {
  const userId = cleanParam(query?.userId);
  const characterId = cleanParam(query?.characterId);
  const status = cleanParam(query?.status);
  const limit = clampLimit(query?.limit);
  const where: Prisma.ChatSessionWhereInput = {};
  if (userId) where.userId = userId;
  if (characterId) where.characterId = characterId;
  if (status && status !== "all") where.status = status;
  else where.status = { not: "deleted" };
  const rows = await chatPrisma.chatSession.findMany({
    where,
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    take: limit,
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
  const items = rows.map((row) => ({
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
  return { items };
}

async function usage(query?: Record<string, string>) {
  const userId = cleanParam(query?.userId);
  const limit = clampLimit(query?.limit);
  const periodStart = startOfUtcDay();
  const rows = await chatPrisma.chatUsage.findMany({
    where: {
      periodStart,
      ...(userId ? { userId } : {}),
    },
    orderBy: [{ messagesUsed: "desc" }, { updatedAt: "desc" }],
    take: limit,
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

  const items = await Promise.all(
    rows.map(async (row) => {
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
  return { items, freeDailyLimit: FREE_DAILY_MESSAGES };
}

async function moderationEvents(query?: Record<string, string>) {
  const limit = clampLimit(query?.limit);
  const status = cleanParam(query?.status);
  const layer = cleanParam(query?.layer);
  const policyCode = cleanParam(query?.policyCode);
  const targetType = cleanParam(query?.targetType);
  const targetId = cleanParam(query?.targetId);
  const where: Prisma.ChatModerationEventWhereInput = {};
  if (status && status !== "all") where.status = status;
  if (layer && layer !== "all") where.layer = layer;
  if (policyCode) where.policyCode = policyCode;
  if (targetType && targetType !== "all") where.targetType = targetType;
  if (targetId) where.targetId = targetId;
  const items = await chatPrisma.chatModerationEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
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
  return { items };
}

function cleanParam(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, parsed));
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
