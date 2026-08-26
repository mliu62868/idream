// SPEC: chat/web request dispatch (design §11). Pure-ish router so it's unit
// testable without a socket; web.ts is a thin Node http adapter around it.
// Auth: the caller (web.ts) has already verified the BFF signature and resolved
// userId — the router re-checks authz against views inside each service call.
import type { Prisma } from "../generated/client/client.js";
import { ChatError } from "./errors.js";
import { CompanionProjectionClaimBusyError } from "./file-mutations.js";
import { logger } from "./logger.js";
import {
  archiveSession,
  archiveSessionTx,
  assertMessageStreamAccess,
  confirmImageAttachment,
  createSession,
  editUserMessage,
  getSession,
  getMessageVoiceAuthority,
  listSessions,
  regenerate,
  renameSession,
  sendMessage,
  setNoMemory,
} from "./service.js";
import { deleteMessage, deleteSession } from "./privacy.js";
import {
  getRelationshipState,
  listRelationships,
} from "./relationship.js";
import { chatPrisma } from "./db.js";
import {
  assertNoPendingChatFileMutationsTx,
  projectChatFileMutations,
  recordChatFileMutation,
  runWithProjectedChatFiles,
  withReadableChatFileSnapshot,
} from "./file-mutations.js";
import { streamKey } from "./stream.js";
import { lockUser } from "./turn-lock.js";

export interface ChatRequest {
  method: string;
  path: string; // e.g. /api/v1/chat/sessions/abc/messages
  userId: string;
  body?: unknown;
  query?: Record<string, string>;
  idempotencyKey?: string;
}

export type ChatResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "sse"; streamKey: string; lastEventId?: string };

const PREFIX = "/api/v1/chat";
const MESSAGES_PREFIX = "/api/v1/messages";

export async function dispatchChat(req: ChatRequest): Promise<ChatResponse> {
  try {
    return await route(req);
  } catch (error) {
    if (error instanceof ChatError) {
      return { kind: "json", status: error.status, body: { error: error.code, message: error.message } };
    }
    if (error instanceof CompanionProjectionClaimBusyError) {
      return {
        kind: "json",
        status: 409,
        body: {
          error: "relationship_busy",
          message: "the previous turn is still being saved; try again in a moment",
        },
      };
    }
    // INVARIANT: 未分类的异常不把 message 交给客户端 —— 它可能带着内部标识符或
    // provider 报文。原文进日志，客户端只拿到一个稳定的 code。
    logger.error({ err: error }, "unhandled chat request failure");
    return {
      kind: "json",
      status: 500,
      body: { error: "internal", message: "the chat service could not complete this request" },
    };
  }
}

async function route(req: ChatRequest): Promise<ChatResponse> {
  const { method, userId } = req;
  // Accept both conventions the main-web BFF proxies: the chat namespace
  // (/api/v1/chat/*) and bare message ops (/api/v1/messages/* → resource
  // "messages"), so regenerate/stream/delete reach the same handlers either way.
  let rest: string;
  if (req.path.startsWith(PREFIX)) {
    rest = req.path.slice(PREFIX.length);
  } else if (req.path.startsWith(MESSAGES_PREFIX)) {
    rest = `/messages${req.path.slice(MESSAGES_PREFIX.length)}`;
  } else {
    return json(404, { error: "not_found" });
  }
  rest = rest.replace(/\/+$/, "");
  const segs = rest.split("/").filter(Boolean); // [] | ["sessions"] | ["sessions",id] ...

  // /sessions
  if (segs[0] === "sessions" && segs.length === 1) {
    if (method === "GET") return json(200, await listSessions(userId));
    if (method === "POST") {
      const b = body(req);
      return json(201, await createSession({
        userId,
        characterId: str(b.characterId),
        title: optStr(b.title),
        entryExposureId: optStr(b.entryExposureId),
        entryJourneyId: optStr(b.journeyId),
        entryPlacementId: optStr(b.placementId),
      }));
    }
  }

  // /sessions/:id  and subroutes
  if (segs[0] === "sessions" && segs.length >= 2) {
    const sessionId = segs[1];
    if (segs.length === 2) {
      if (method === "GET") return json(200, await getSession({ userId, sessionId }));
      if (method === "PATCH") {
        return json(200, await renameSession({ userId, sessionId, title: str(body(req).title) }));
      }
      if (method === "DELETE") {
        await deleteSession({ userId, sessionId });
        return json(200, { ok: true });
      }
    }
    if (segs.length === 3 && segs[2] === "messages" && method === "POST") {
      const b = body(req);
      return json(202, await sendMessage({
        userId,
        sessionId,
        content: str(b.content),
        idempotencyKey: req.idempotencyKey,
      }));
    }
    if (
      segs.length === 5 &&
      segs[2] === "messages" &&
      segs[4] === "voice-authority" &&
      method === "GET"
    ) {
      return json(200, await getMessageVoiceAuthority({
        userId,
        sessionId,
        messageId: segs[3],
      }));
    }
    if (segs.length === 3 && segs[2] === "archive" && method === "POST") {
      return json(200, await archiveSession({ userId, sessionId }));
    }
    if (segs.length === 3 && segs[2] === "memory" && method === "POST") {
      const b = body(req);
      return json(200, await setNoMemory({ userId, sessionId, memoryEnabled: Boolean(b.memoryEnabled) }));
    }
    if (segs.length === 3 && segs[2] === "no-memory" && method === "POST") {
      return json(200, await setNoMemory({ userId, sessionId, memoryEnabled: false }));
    }
  }

  // /messages/:id  (delete) and /messages/:id/{regenerate,stream}
  if (segs[0] === "messages" && segs.length === 2 && method === "DELETE") {
    await deleteMessage({ userId, messageId: segs[1] });
    return json(200, { ok: true });
  }
  if (segs[0] === "messages" && segs.length === 2 && method === "PATCH") {
    return json(202, await editUserMessage({ userId, messageId: segs[1], content: str(body(req).content) }));
  }
  if (segs[0] === "messages" && segs.length === 3) {
    const messageId = segs[1];
    if (segs[2] === "regenerate" && method === "POST") {
      return json(202, await regenerate({ userId, messageId }));
    }
    if (segs[2] === "stream" && method === "GET") {
      await assertMessageStreamAccess({ userId, messageId });
      return { kind: "sse", streamKey: streamKey(messageId), lastEventId: req.query?.lastEventId };
    }
  }

  // /attachments/:id/confirm — user explicitly accepts a proposed chat image.
  if (segs[0] === "attachments" && segs.length === 3 && segs[2] === "confirm" && method === "POST") {
    return json(202, await confirmImageAttachment({ userId, attachmentId: segs[1] }));
  }

  // /streams/:assistantMessageId  — PRD §8.2 alias for the SSE token stream.
  if (segs[0] === "streams" && segs.length === 2 && method === "GET") {
    await assertMessageStreamAccess({ userId, messageId: segs[1] });
    return { kind: "sse", streamKey: streamKey(segs[1]), lastEventId: req.query?.lastEventId };
  }


  // /relationships  and  /relationships/:characterId  (companion bond, PRD §8.2)
  if (segs[0] === "relationships" && segs.length === 1 && method === "GET") {
    const relationships = await withReadableChatFileSnapshot(
      userId,
      () => listRelationships(userId),
    );
    return json(200, { relationships });
  }
  if (segs[0] === "relationships" && segs.length === 2) {
    const characterId = segs[1];
    // SPEC: stage/summary are derived Chat authority, never client-authored state.
    // INTENT: the old PATCH route let any signed-in client jump straight from
    // `new` to `committed` and inject text that later entered the model prompt.
    if (method === "PATCH") {
      return json(405, { error: "method_not_allowed" });
    }
    if (method === "GET") {
      const relationship = await withReadableChatFileSnapshot(
        userId,
        () => getRelationshipState(userId, characterId),
      );
      return json(200, relationship);
    }
    if (method === "DELETE") {
      // SPEC: 重置 = 忘掉这个角色记住的一切，并从一段新对话重新开始。
      // INTENT: 只清文件层是**看不出来**的 —— 角色的记忆有两条通道，长期记忆
      // （侧车工作区，现已按重置纪元投影）和眼前这段会话的上下文。用户重置后
      // 若仍留在原会话里，模型照样读着整段记录，重置在他看来什么也没发生。
      // 归档而不是删除：历史仍在抽屉里读得到，只是不再进入下一轮上下文。
      const archived = await withActiveUserFileIntent(userId, async (tx) => {
        const active = await tx.chatSession.findMany({
          where: {
            userId,
            characterId,
            status: "active",
            deletedAt: null,
          },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
        for (const session of active) {
          await archiveSessionTx(tx, { userId, sessionId: session.id });
        }
        await recordChatFileMutation(tx, userId, {
          kind: "relationship_delete",
          characterId,
        });
        return active.length;
      });
      return json(200, { ok: true, archivedSessions: archived });
    }
  }

  return json(404, { error: "not_found", path: req.path });
}

async function withActiveUserFileIntent<T>(
  userId: string,
  plan: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const result = await runWithProjectedChatFiles(
    userId,
    () => chatPrisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await assertNoPendingChatFileMutationsTx(tx, userId);
      const user = await tx.chatUserView.findUnique({ where: { userId } });
      if (!user || user.status !== "active" || user.deletedAt) {
        throw new ChatError("user_inactive", "user not active", 403);
      }
      return plan(tx);
    }),
  );
  await projectChatFileMutations(userId);
  return result;
}

function json(status: number, body: unknown): ChatResponse {
  return { kind: "json", status, body };
}
function body(req: ChatRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  if (typeof v !== "string") throw new ChatError("bad_request", "expected string field", 400);
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function limitedStr(v: unknown, max: number, field: string): string {
  const value = str(v);
  if (value.length > max) throw new ChatError("bad_request", `${field} exceeds ${max} characters`, 400);
  return value;
}
