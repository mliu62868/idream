// Main owns Companion Chat product state. This module is now a façade over the
// Main Turn Ledger; only AgentRun admission, cancellation and SSE cross to Chat.
import { prisma } from "@/server/lib/db";
import { getAuthCtx } from "@/server/lib/auth";
import { AppError, Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  archiveChatSession,
  chatStreamAuthority,
  chatVoiceAuthority,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  deleteGroupChatConversation,
  getChatSession,
  listChatSessions,
  renameChatSession,
  selectChatReplyVersion,
  setChatMemory,
} from "@/server/modules/chat/turn-ledger";
import {
  beginAdmittedChatTurn,
  cancelAdmittedChatTurn,
  editAndAdmitChatTurn,
  regenerateAndAdmitChatTurn,
} from "@/server/modules/chat/agent-run-admission";
import { clearCompanionMemory } from "@/server/modules/chat/companion-memory-authority";
import { parseChatTranscriptPage } from "@/server/modules/chat/chat-read-model";
import { requireChatAgentRuntime, signedChatBffHeaders } from "@/server/modules/chat/chat-runtime-endpoint";
import { createChatContextDirective, deleteChatContextDirective, listChatContextDirectives, updateChatContextDirective } from "@/server/modules/chat/context-directives";
import { getChatExperiencePreference, updateChatExperiencePreference } from "@/server/modules/chat/experience-preferences";
import { getProactiveSettings, updateProactiveSettings } from "@/server/modules/chat/proactive-messages";
import { routeVoiceInput } from "@/server/modules/chat/voice-input";
import { routeVoiceCall } from "@/server/modules/chat/voice-call";
import { createGroupConversation, getGroupConversation, groupSpeakerSession, listGroupCandidates, listGroupConversations, updateGroupConversation } from "@/server/modules/chat/group-conversations";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization",
};

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
  const root = segments[0];
  const path = root === "chat" ? segments.slice(1) : segments;
  if (root === "chat") {
    const voiceInput = await routeVoiceInput(request, path, userId);
    if (voiceInput) return voiceInput;
    const voiceCall = await routeVoiceCall(request, path, userId);
    if (voiceCall) return voiceCall;
  }
  const body = method === "GET" || method === "HEAD" ? {} : await jsonBody(request);

  if (root === "chat" && path[0] === "groups") {
    if (path.length === 1) {
      if (method === "GET") return json({ ownerScope: `user:${userId}`, groups: await listGroupConversations(userId) });
      if (method === "POST") {
        if (request.headers.get("x-idream-viewer-scope") !== `user:${userId}`) throw Errors.conflict("Your account changed. Reload before creating a group", { reason: "viewer_changed" });
        return envelope({ group: await createGroupConversation(userId, body) }, 201);
      }
    }
    if (path[1] === "candidates" && path.length === 2 && method === "GET") {
      const query = new URL(request.url).searchParams;
      return json(await listGroupCandidates(userId, query.get("q") ?? "", query.get("cursor") ?? undefined));
    }
    const groupId = path[1];
    if (groupId && path.length === 2) {
      if (method === "GET") {
        const query = new URL(request.url).searchParams;
        return envelope({ session: await getGroupConversation(userId, groupId, query.get("speaker") ?? undefined, parseChatTranscriptPage(query)) });
      }
      if (method === "PATCH") {
        // Same guard as creation: new members are bound to the account the picker was loaded for.
        if ("addCharacterIds" in body && request.headers.get("x-idream-viewer-scope") !== `user:${userId}`) throw Errors.conflict("Your account changed. Reload before adding Characters", { reason: "viewer_changed" });
        return json(await updateGroupConversation(userId, groupId, body));
      }
      if (method === "DELETE") {
        await deleteGroupChatConversation(userId, groupId);
        return json({ ok: true });
      }
    }
    if (groupId && path.length === 3 && path[2] === "messages" && method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required");
      const speaker = await groupSpeakerSession(userId, groupId, text(body.characterId));
      const result = await beginAdmittedChatTurn({ userId, sessionId: speaker.sessionId, content: text(body.content), idempotencyKey, sendProtocolVersion: sendProtocolVersion(body), allowPaidImage: paidImageRequest(body) });
      return envelope({ ...result, userMessage: { ...result.userMessage, ...speaker }, assistant: { ...result.assistant, ...speaker } }, 202);
    }
    throw Errors.notFound("Group chat route not found");
  }

  if (root === "chat" && path[0] === "memory" && path[1] && path.length === 2) {
    if (method === "DELETE") {
      requireChatAgentRuntime();
      return json(await clearCompanionMemory(userId, path[1]));
    }
  }

  if (root === "chat" && path[0] === "sessions" && path.length === 1) {
    if (method === "GET") return json(await listChatSessions(userId));
    if (method === "POST") {
      // Optional guard: a caller that states which account it is acting for (e.g. the
      // Release hand-off carrying an unsent draft) must not land in another account.
      const scope = request.headers.get("x-idream-viewer-scope");
      if (scope !== null && scope !== `user:${userId}`) throw Errors.conflict("Your account changed. Reload to continue.", { reason: "viewer_changed" });
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
    if (path[2] === "proactive" && path.length === 3) {
      if (method === "GET") return json(await getProactiveSettings(userId, sessionId));
      if (method === "PUT") return json(await updateProactiveSettings(userId, sessionId, body));
    }
    if (path[2] === "experience" && path.length === 3) {
      if (method === "GET") return json(await getChatExperiencePreference(userId, sessionId));
      if (method === "PUT") return json(await updateChatExperiencePreference(userId, sessionId, body));
    }
    if (path[2] === "context-directives") {
      if (path.length === 3 && method === "GET") return json(await listChatContextDirectives(userId, sessionId));
      if (path.length === 3 && method === "POST") return json(await createChatContextDirective(userId, sessionId, body, request.headers.get("idempotency-key")), 201);
      if (path.length === 4 && method === "PATCH") return json(await updateChatContextDirective(userId, sessionId, path[3], body));
      if (path.length === 4 && method === "DELETE") return json(await deleteChatContextDirective(userId, sessionId, path[3], body));
    }
    if (path.length === 2) {
      if (method === "GET") return envelope({ session: await getChatSession(userId, sessionId, parseChatTranscriptPage(new URL(request.url).searchParams)) });
      if (method === "PATCH") return json(await renameChatSession(userId, sessionId, text(body.title)));
      if (method === "DELETE") {
        await deleteChatSession(userId, sessionId);
        return json({ ok: true });
      }
    }
    if (path.length === 3 && path[2] === "messages" && method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required");
      const target = await prisma.recentChat.findFirst({ where: { sessionId, userId }, select: { groupId: true } });
      if (target?.groupId) throw Errors.conflict("Open this conversation from its group chat", { reason: "group_conversation" });
      return envelope(await beginAdmittedChatTurn({
        userId,
        sessionId,
        content: text(body.content),
        idempotencyKey,
        sendProtocolVersion: sendProtocolVersion(body),
        allowPaidImage: paidImageRequest(body),
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
      const { attempt } = body;
      if (attempt !== undefined && typeof attempt !== "number") throw Errors.badRequest("Edit requires a positive integer attempt");
      return json(await editAndAdmitChatTurn(userId, messageId, text(body.content), {
        expectedAttempt: attempt,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
        allowPaidImage: paidImageRequest(body),
      }), 202);
    }
    if (path.length === 4 && path[2] === "versions" && path[3] === "select" && method === "POST") {
      if (typeof body.ordinal !== "number" || typeof body.attempt !== "number") {
        throw Errors.badRequest("Selecting a reply version requires its ordinal and the observed attempt");
      }
      return json(await selectChatReplyVersion(userId, messageId, { ordinal: body.ordinal, expectedAttempt: body.attempt }));
    }
    if (path.length === 3 && path[2] === "regenerate" && method === "POST") {
      return json(await regenerateAndAdmitChatTurn(userId, messageId), 202);
    }
    if (path.length === 3 && path[2] === "cancel" && method === "POST") {
      if (typeof body.attempt !== "number") throw Errors.badRequest("Stop requires the observed attempt");
      return json(await cancelAdmittedChatTurn(userId, messageId, body.attempt));
    }
    if (path.length === 3 && path[2] === "stream" && method === "GET") {
      return proxyAgentStream(request, userId, messageId);
    }
  }

  throw Errors.notFound("Chat route not found");
}

// INTENT: the handshake (response headers) is bounded so a hung Chat releases
// the browser's request; the body is a long-lived SSE stream and is bounded
// only by the browser closing it.
const STREAM_HEADERS_TIMEOUT_MS = 10_000;
// Only transport-neutral headers cross the façade; Chat's internal headers
// (server, set-cookie, debug ids, content-encoding) never reach the browser.
const FORWARDED_STREAM_HEADERS = ["content-type", "x-accel-buffering", "retry-after"] as const;
// Statuses a page can act on keep their meaning; anything else is "unavailable".
const FORWARDED_STREAM_STATUSES = new Set([404, 409, 410, 429]);

async function proxyAgentStream(request: Request, userId: string, messageId: string): Promise<Response> {
  const base = requireChatAgentRuntime();
  const incoming = new URL(request.url);
  const requestedAttempt = incoming.searchParams.get("attempt");
  if (requestedAttempt !== null && !/^[1-9]\d*$/u.test(requestedAttempt)) {
    throw Errors.badRequest("Stream requires a positive integer attempt");
  }
  const authority = await chatStreamAuthority(userId, messageId,
    requestedAttempt === null ? undefined : Number(requestedAttempt));
  // Existing probe/quality callers omit attempt. Resolve their current product
  // identity once and pin it for this upstream handshake.
  incoming.searchParams.set("attempt", String(authority.attempt));
  const path = `/api/v1/messages/${encodeURIComponent(messageId)}/stream`;
  const target = `${base}${path}${incoming.search}`;
  const headers = signedChatBffHeaders({ userId, method: "GET", path, body: "" });
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers.set("last-event-id", lastEventId);
  const handshake = new AbortController();
  const handshakeTimer = setTimeout(() => {
    handshake.abort(new DOMException("Chat stream handshake timed out", "TimeoutError"));
  }, STREAM_HEADERS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(target, { method: "GET", headers, signal: AbortSignal.any([request.signal, handshake.signal]) });
  } catch (error) {
    if (request.signal.aborted) throw error;
    logger.warn({ err: error, messageId, attempt: authority.attempt }, "Chat stream handshake failed");
    throw Errors.unavailable("The reply stream is temporarily unavailable");
  } finally {
    clearTimeout(handshakeTimer);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    logger.warn({ status: response.status, messageId, attempt: authority.attempt }, "Chat stream handshake was refused");
    const status = FORWARDED_STREAM_STATUSES.has(response.status) ? response.status : 503;
    return json({ error: status === 503 ? "chat_stream_unavailable" : "chat_stream_refused", message: "The reply stream is not available" }, status);
  }
  try {
    // The handshake can outlive deletion or revision. Do not expose a body from
    // an identity that lost product authority while we waited for Chat.
    await chatStreamAuthority(userId, messageId, authority.attempt);
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  // The body passes through byte for byte, including SSE `retry:` fields.
  const responseHeaders = new Headers();
  for (const name of FORWARDED_STREAM_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  responseHeaders.set("cache-control", "private, no-cache, no-store, no-transform");
  responseHeaders.set("vary", "Cookie, Authorization");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function paidImageRequest(body: Record<string, unknown>): boolean | undefined {
  const value = body.allowPaidImage;
  if (value !== undefined && typeof value !== "boolean") throw Errors.badRequest("allowPaidImage must be a boolean");
  return value;
}

function sendProtocolVersion(body: Record<string, unknown>): string | undefined {
  const value = body.sendProtocolVersion;
  if (value !== undefined && typeof value !== "string") throw Errors.badRequest("sendProtocolVersion must be a string");
  return value;
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
  // Same rule as the Main envelope: client errors carry their details (e.g. why a
  // chat is gone and where to continue); server errors never do.
  return json({
    error: appError.code,
    message: appError.message,
    ...(appError.status < 500 && appError.details !== undefined ? { details: appError.details } : {}),
  }, appError.status);
}
