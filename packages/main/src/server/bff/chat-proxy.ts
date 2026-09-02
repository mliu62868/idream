// Main owns Companion Chat product state. This module is now a façade over the
// Main Turn Ledger; only AgentRun admission, cancellation and SSE cross to Chat.
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { getAuthCtx } from "@/server/lib/auth";
import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  archiveChatSession,
  chatVoiceAuthority,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  renameChatSession,
  setChatMemory,
} from "@/server/modules/chat/turn-ledger";
import {
  beginAdmittedChatTurn,
  cancelAdmittedChatTurn,
  editAndAdmitChatTurn,
  regenerateAndAdmitChatTurn,
} from "@/server/modules/chat/agent-run-admission";
import { clearCompanionMemory } from "@/server/modules/chat/companion-memory-authority";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization",
};

export function chatServiceEnabled(): boolean {
  return Boolean(env.CHAT_SERVICE_URL);
}

export type ChatMessageVoiceAuthority = {
  schemaVersion: 1;
  sessionId: string;
  messageId: string;
  characterId: string;
  text: string;
  attempt: number;
  sceneVersion: number;
  scene: unknown;
  characterContentVersionId: string | null;
  characterReleaseId: string | null;
};

/** Voice reads the selected final reply from Main; Chat is never queried. */
export async function fetchChatMessageVoiceAuthority(
  request: Request,
  input: { sessionId: string; messageId: string; testOnlyText?: string; characterId?: string },
): Promise<ChatMessageVoiceAuthority> {
  const auth = await getAuthCtx(request);
  if (!auth.userId) throw Errors.unauthorized("Sign in required");
  return await chatVoiceAuthority(auth.userId, input.sessionId, input.messageId);
}

/** Public `/api/v1/chat|messages/*` façade. Product reads/writes stay in Main. */
export async function proxyChatRequest(request: Request, segments: string[]): Promise<Response> {
  const auth = await getAuthCtx(request);
  if (!auth.userId) return errorResponse(Errors.unauthorized("Sign in required"));
  try {
    return await routeMainChat(request, segments, auth.userId);
  } catch (error) {
    return errorResponse(error);
  }
}

async function routeMainChat(request: Request, segments: string[], userId: string): Promise<Response> {
  const method = request.method;
  const body = method === "GET" || method === "HEAD" ? {} : await jsonBody(request);
  const root = segments[0];
  const path = root === "chat" ? segments.slice(1) : segments;

  if (root === "chat" && path[0] === "memory" && path[1] && path.length === 2) {
    if (method === "DELETE") {
      requireAgentRuntime();
      return json(await clearCompanionMemory(userId, path[1]));
    }
  }

  if (root === "chat" && path[0] === "sessions" && path.length === 1) {
    if (method === "GET") return json(await listChatSessions(userId));
    if (method === "POST") {
      const session = await createChatSession(userId, {
        characterId: text(body.characterId),
        title: optionalText(body.title),
        entryExposureId: optionalText(body.entryExposureId),
        entryJourneyId: optionalText(body.journeyId),
        entryPlacementId: optionalText(body.placementId),
      });
      return envelope({ session }, 201);
    }
  }

  if (root === "chat" && path[0] === "sessions" && path[1]) {
    const sessionId = path[1];
    if (path.length === 2) {
      if (method === "GET") return envelope({ session: await getChatSession(userId, sessionId) });
      if (method === "PATCH") return json(await renameChatSession(userId, sessionId, text(body.title)));
      if (method === "DELETE") {
        await deleteChatSession(userId, sessionId);
        return json({ ok: true });
      }
    }
    if (path.length === 3 && path[2] === "messages" && method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required");
      return envelope(await beginAdmittedChatTurn({
        userId,
        sessionId,
        content: text(body.content),
        idempotencyKey,
      }), 202);
    }
    if (path.length === 3 && path[2] === "archive" && method === "POST") {
      return json(await archiveChatSession(userId, sessionId));
    }
    if (path.length === 3 && path[2] === "memory" && method === "POST") {
      return json(await setChatMemory(userId, sessionId, Boolean(body.memoryEnabled)));
    }
    if (path.length === 3 && path[2] === "no-memory" && method === "POST") {
      return json(await setChatMemory(userId, sessionId, false));
    }
    if (
      path.length === 5 && path[2] === "messages" && path[4] === "voice-authority" && method === "GET"
    ) {
      return json(await chatVoiceAuthority(userId, sessionId, path[3]));
    }
  }

  if ((root === "messages" || (root === "chat" && path[0] === "messages")) && path[1]) {
    const messageId = path[1];
    if (path.length === 2 && method === "DELETE") {
      await deleteChatMessage(userId, messageId);
      return json({ ok: true });
    }
    if (path.length === 2 && method === "PATCH") {
      return json(await editAndAdmitChatTurn(userId, messageId, text(body.content)), 202);
    }
    if (path.length === 3 && path[2] === "regenerate" && method === "POST") {
      return json(await regenerateAndAdmitChatTurn(userId, messageId), 202);
    }
    if (path.length === 3 && path[2] === "cancel" && method === "POST") {
      return json(await cancelAdmittedChatTurn(userId, messageId));
    }
    if (path.length === 3 && path[2] === "stream" && method === "GET") {
      return proxyAgentStream(request, userId, messageId);
    }
  }

  throw Errors.notFound("Chat route not found");
}

async function proxyAgentStream(request: Request, userId: string, messageId: string): Promise<Response> {
  const base = requireAgentRuntime();
  const incoming = new URL(request.url);
  const path = `/api/v1/messages/${encodeURIComponent(messageId)}/stream`;
  const target = `${base}${path}${incoming.search}`;
  const headers = signedAgentHeaders(userId, "GET", path, "");
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers.set("last-event-id", lastEventId);
  const response = await fetch(target, { method: "GET", headers });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.set("cache-control", "private, no-cache, no-store, no-transform");
  responseHeaders.set("vary", "Cookie, Authorization");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

function signedAgentHeaders(
  userId: string,
  method: string,
  path: string,
  body: string,
): Headers {
  const headers = new Headers();
  const secret = env.CHAT_BFF_SIGNING_SECRET;
  if (!secret) {
    if (env.APP_ENV !== "test") throw Errors.unavailable("CHAT_BFF_SIGNING_SECRET not configured");
    headers.set("x-idream-user-id", userId);
    return headers;
  }
  const signed = signBffContext({ secret, userId, method, path, body });
  headers.set(BFF_HEADER, signed.signature);
  // HTTP header values are ByteStrings in Undici. Escaping non-ASCII keeps the
  // JSON semantic value intact while making the transport representation valid.
  headers.set(BFF_USER_HEADER, asciiJson(signed.context));
  return headers;
}

function requireAgentRuntime(): string {
  if (!env.CHAT_SERVICE_URL) throw Errors.unavailable("CHAT_SERVICE_URL not configured");
  if (!env.INTERNAL_TOKEN) throw Errors.unavailable("INTERNAL_TOKEN not configured");
  if (!env.CHAT_BFF_SIGNING_SECRET && env.APP_ENV !== "test") {
    throw Errors.unavailable("CHAT_BFF_SIGNING_SECRET not configured");
  }
  return env.CHAT_SERVICE_URL.replace(/\/$/u, "");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) return {};
  try {
    const parsed = record(JSON.parse(raw) as unknown);
    if (!parsed) throw new Error("body must be an object");
    return parsed;
  } catch {
    throw Errors.badRequest("Invalid JSON body");
  }
}

function text(value: unknown): string {
  if (typeof value !== "string") throw Errors.badRequest("Expected a string field");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: PRIVATE_HEADERS });
}

function envelope(data: unknown, status = 200): Response {
  return json({ ok: true, data }, status);
}

function errorResponse(error: unknown): Response {
  if (!(error instanceof AppError)) logger.error({ err: error }, "Main Chat façade failed");
  const appError = error instanceof AppError
    ? error
    : Errors.internal("The Chat request could not be completed");
  return json({ error: appError.code, message: appError.message }, appError.status);
}
