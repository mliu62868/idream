import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";

// SPEC: the one place Main resolves the Chat AgentRun runtime and signs a
// request for it. Admission, the SSE façade, durable lifecycle delivery and
// memory projection all reach Chat through these helpers.

/** URL of a Chat runtime path. Background deliveries treat a missing base as retryable. */
export function chatRuntimeUrl(path: string): string {
  const base = env.CHAT_SERVICE_URL?.trim();
  if (!base) throw new Error("CHAT_SERVICE_URL is required for Main to Chat delivery");
  return `${base.replace(/\/$/u, "")}${path}`;
}

/**
 * Product-facing guard: everything a signed AgentRun request needs. A missing
 * piece is a 503 the page can explain, never a half-configured request.
 */
export function requireChatAgentRuntime(): string {
  if (!env.CHAT_SERVICE_URL) throw Errors.unavailable("CHAT_SERVICE_URL not configured");
  if (!env.INTERNAL_TOKEN) throw Errors.unavailable("INTERNAL_TOKEN not configured");
  if (!env.CHAT_BFF_SIGNING_SECRET && env.APP_ENV !== "test") {
    throw Errors.unavailable("CHAT_BFF_SIGNING_SECRET not configured");
  }
  return env.CHAT_SERVICE_URL.replace(/\/$/u, "");
}

export function agentRunCancelPath(turnId: string, attempt: number): string {
  return `/internal/agent-runs/${encodeURIComponent(turnId)}/${attempt}/cancel`;
}

export function agentRunPurgePath(turnId: string): string {
  return `/internal/agent-runs/${encodeURIComponent(turnId)}/purge`;
}

export function internalChatHeaders(init?: Record<string, string>): Headers {
  return new Headers({ ...init, "x-internal-token": env.INTERNAL_TOKEN ?? "" });
}

/**
 * Signed BFF user context for a Chat request. Only the test environment may
 * fall back to the plain development identity header.
 */
export function signedChatBffHeaders(input: {
  userId: string;
  method: string;
  path: string;
  body: string;
  authority?: Parameters<typeof signBffContext>[0]["authority"];
  headers?: Headers;
}): Headers {
  const headers = input.headers ?? new Headers();
  const secret = env.CHAT_BFF_SIGNING_SECRET;
  if (!secret) {
    if (env.APP_ENV !== "test") throw Errors.unavailable("CHAT_BFF_SIGNING_SECRET not configured");
    headers.set("x-idream-user-id", input.userId);
    return headers;
  }
  const signed = signBffContext({
    secret,
    userId: input.userId,
    method: input.method,
    path: input.path,
    body: input.body,
    ...(input.authority ? { authority: input.authority } : {}),
  });
  headers.set(BFF_HEADER, signed.signature);
  // HTTP header values are ByteStrings in Undici. Escaping non-ASCII keeps the
  // JSON semantic value intact while making the transport representation valid.
  headers.set(BFF_USER_HEADER, asciiJson(signed.context));
  return headers;
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
