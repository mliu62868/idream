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
  sendMessage,
  setNoMemory,
} from "./service.js";
import { deleteSession } from "./privacy.js";
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
  if (!req.path.startsWith(PREFIX)) return json(404, { error: "not_found" });
  const rest = req.path.slice(PREFIX.length).replace(/\/+$/, "");
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

  // /messages/:id/regenerate  and  /messages/:id/stream
  if (segs[0] === "messages" && segs.length === 3) {
    const messageId = segs[1];
    if (segs[2] === "regenerate" && method === "POST") {
      return json(202, await regenerate({ userId, messageId }));
    }
    if (segs[2] === "stream" && method === "GET") {
      return { kind: "sse", streamKey: streamKey(messageId), lastEventId: req.query?.lastEventId };
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
