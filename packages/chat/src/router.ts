// SPEC: chat/web request dispatch (design §11). Pure-ish router so it's unit
// testable without a socket; web.ts is a thin Node http adapter around it.
// Auth: the caller (web.ts) has already verified the BFF signature and resolved
// userId — the router re-checks authz against views inside each service call.
import {
  ChatError,
  archiveSession,
  createSession,
  getSession,
  listSessions,
  regenerate,
  renameSession,
  sendMessage,
  setNoMemory,
} from "./service.js";
import { deleteMessage, deleteSession } from "./privacy.js";
import { deleteMemory, listMemories, updateMemory } from "./memories.js";
import {
  deleteRelationship,
  getRelationshipState,
  listRelationships,
  setRelationship,
  type RelationshipStage,
} from "./relationship.js";
import { streamKey } from "./stream.js";

export interface ChatRequest {
  method: string;
  path: string; // e.g. /api/v1/chat/sessions/abc/messages
  userId: string;
  body?: unknown;
  query?: Record<string, string>;
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
    return {
      kind: "json",
      status: 500,
      body: { error: "internal", message: error instanceof Error ? error.message : "error" },
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
      return json(201, await createSession({ userId, characterId: str(b.characterId), title: optStr(b.title) }));
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
      return json(202, await sendMessage({ userId, sessionId, content: str(b.content) }));
    }
    if (segs.length === 3 && segs[2] === "archive" && method === "POST") {
      return json(200, await archiveSession({ userId, sessionId }));
    }
    if (segs.length === 3 && segs[2] === "memory" && method === "POST") {
      const b = body(req);
      return json(200, await setNoMemory({ userId, sessionId, memoryEnabled: Boolean(b.memoryEnabled) }));
    }
  }

  // /messages/:id  (delete) and /messages/:id/{regenerate,stream}
  if (segs[0] === "messages" && segs.length === 2 && method === "DELETE") {
    await deleteMessage({ userId, messageId: segs[1] });
    return json(200, { ok: true });
  }
  if (segs[0] === "messages" && segs.length === 3) {
    const messageId = segs[1];
    if (segs[2] === "regenerate" && method === "POST") {
      return json(202, await regenerate({ userId, messageId }));
    }
    if (segs[2] === "stream" && method === "GET") {
      return { kind: "sse", streamKey: streamKey(messageId), lastEventId: req.query?.lastEventId };
    }
  }

  // /streams/:assistantMessageId  — PRD §8.2 alias for the SSE token stream.
  if (segs[0] === "streams" && segs.length === 2 && method === "GET") {
    return { kind: "sse", streamKey: streamKey(segs[1]), lastEventId: req.query?.lastEventId };
  }

  // /memories  and  /memories/:id  (long-term memory management, PRD §8.2)
  if (segs[0] === "memories" && segs.length === 1 && method === "GET") {
    return json(200, { memories: await listMemories(userId, req.query?.characterId) });
  }
  if (segs[0] === "memories" && segs.length === 2) {
    const memoryId = segs[1];
    if (method === "PATCH") {
      const updated = await updateMemory(userId, memoryId, str(body(req).text));
      if (!updated) return json(404, { error: "memory_not_found" });
      return json(200, updated);
    }
    if (method === "DELETE") {
      const removed = await deleteMemory(userId, memoryId);
      return json(removed ? 200 : 404, removed ? { ok: true } : { error: "memory_not_found" });
    }
  }

  // /relationships  and  /relationships/:characterId  (companion bond, PRD §8.2)
  if (segs[0] === "relationships" && segs.length === 1 && method === "GET") {
    return json(200, { relationships: await listRelationships(userId) });
  }
  if (segs[0] === "relationships" && segs.length === 2) {
    const characterId = segs[1];
    if (method === "GET") return json(200, await getRelationshipState(userId, characterId));
    if (method === "PATCH") {
      const b = body(req);
      return json(
        200,
        await setRelationship(userId, characterId, {
          summary: optStr(b.summary),
          stage: optStr(b.stage) as RelationshipStage | undefined,
        }),
      );
    }
    if (method === "DELETE") {
      await deleteRelationship(userId, characterId);
      return json(200, { ok: true });
    }
  }

  return json(404, { error: "not_found", path: req.path });
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
