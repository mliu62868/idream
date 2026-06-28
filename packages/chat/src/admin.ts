// SPEC: chat 服务内部 admin 只读 API（ADMIN_PHASE2_DESIGN §5 F6）。供 main-web 的
// 管理控制台经 INTERNAL_TOKEN 代理调用，给运营「会话/额度/审核事件」可见性与排障。
// INTENT: 只读、脱敏——绝不回明文 message.content / moderation.details；尊重 DB 边界
// （main 不直连 chat DB，统一走这里）。鉴权在 web.ts 用 x-internal-token 完成，本模块只查数。
// INVARIANTS: 仅 GET；未知路径 404；返回不含明文聊天内容。
import { chatPrisma } from "./db.js";

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
  if (rest === "/sessions") return { status: 200, body: await sessions(req.query) };
  if (rest === "/moderation-events") {
    return { status: 200, body: await moderationEvents(req.query) };
  }
  return { status: 404, body: { error: "not_found", path: req.path } };
}

async function overview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [activeSessions, archivedSessions, messages24h, moderationEvents24h] = await Promise.all([
    chatPrisma.chatSession.count({ where: { status: "active", deletedAt: null } }),
    chatPrisma.chatSession.count({ where: { status: "archived" } }),
    chatPrisma.message.count({ where: { createdAt: { gte: since } } }),
    chatPrisma.chatModerationEvent.count({ where: { createdAt: { gte: since } } }),
  ]);
  return { activeSessions, archivedSessions, messages24h, moderationEvents24h, windowHours: 24 };
}

async function sessions(query?: Record<string, string>) {
  const userId = query?.userId?.trim() || undefined;
  const limit = clampLimit(query?.limit);
  const rows = await chatPrisma.chatSession.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      characterId: true,
      status: true,
      memoryEnabled: true,
      lastMessageAt: true,
      createdAt: true,
      _count: { select: { messages: true } },
    },
  });
  // 不回明文 content：只暴露元数据 + 消息计数。
  const items = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    characterId: row.characterId,
    status: row.status,
    memoryEnabled: row.memoryEnabled,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    messageCount: row._count.messages,
  }));
  return { items };
}

async function moderationEvents(query?: Record<string, string>) {
  const limit = clampLimit(query?.limit);
  const items = await chatPrisma.chatModerationEvent.findMany({
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

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, parsed));
}
