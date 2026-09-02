// Thin HTTP adapter for local AgentRuns. Product Chat CRUD lives in Main.
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  verifyBffContext,
  type BffContext,
} from "@idream/shared/bff";
import { chatFsRootFingerprint } from "@idream/shared";
import {
  ACCOUNT_DELETION_V2_INGEST_PATH,
  CHAT_RUNTIME_DIAGNOSTICS_PATH,
  COMPANION_MEMORY_PURGE_PATH,
  COMPANION_MEMORY_REBUILD_PREPARE_PATH,
  COMPANION_MEMORY_REBUILD_PROMOTE_PATH,
  chatExecutionSnapshotSchema,
} from "@idream/shared/contracts";
import { consumeAccountDeletionRequest } from "./account-deletion.js";
import { certifyAgentRuntime } from "./agent-runtime/runtime.js";
import {
  findAgentRunByAssistant,
  purgeAgentRunsForTurn,
  purgeAgentRunsThroughAttempt,
} from "./agent-run-store.js";
import { acceptAgentRun, cancelAgentRun } from "./agent-runner.js";
import {
  prepareCompanionMemory,
  promoteCompanionMemory,
  purgeCompanionMemory,
} from "./companion-memory.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { runtimeReadiness, type RuntimeReadiness } from "./runtime-readiness.js";
import { createSseResponse, streamKey } from "./stream.js";

const BFF_TTL_MS = 30_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface BunHttpServer {
  readonly port: number | undefined;
  timeout(request: Request, seconds: number): void;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

declare const Bun: {
  serve(options: {
    hostname?: string;
    port?: number;
    fetch(request: Request, server: BunHttpServer): Response | Promise<Response>;
  }): BunHttpServer;
};

export interface ChatServerOptions {
  hostname?: string;
  port?: number;
}

export function createChatServer(
  readiness: RuntimeReadiness = runtimeReadiness,
  options: ChatServerOptions = {},
) {
  return Bun.serve({
    ...(options.hostname ? { hostname: options.hostname } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    async fetch(request, server) {
      try {
        const url = new URL(request.url);
        if (requestOwnsTimeout(url)) {
          // Full certification and transcript rebuilds own stricter internal
          // budgets than Bun's short HTTP idle timeout.
          server.timeout(request, 0);
        }
        const response = await handleChatRequest(request, readiness);
        if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
          server.timeout(request, 0);
        }
        return response;
      } catch (error) {
        logger.error({ err: error }, "unhandled AgentRun HTTP failure");
        return json(500, { error: "internal" });
      }
    },
  });
}

export function requestOwnsTimeout(url: URL): boolean {
  return url.pathname === COMPANION_MEMORY_REBUILD_PREPARE_PATH
    || (url.pathname === "/readyz" && url.searchParams.get("full") === "1");
}

export async function handleChatRequest(
  request: Request,
  readiness: RuntimeReadiness,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return json(200, { ok: true, service: "chat" });
  if (url.pathname === "/readyz") {
    await readiness.refreshDependencies();
    const snapshot = readiness.snapshot();
    if (!readiness.canAcceptTurns()) return json(503, {
      ok: false,
      service: "chat",
      ...snapshot,
    });
    if (url.searchParams.get("full") === "1") {
      try {
        return json(200, {
          ok: true,
          service: "chat",
          ...snapshot,
          certification: await certifyAgentRuntime(),
        });
      } catch (error) {
        return json(503, {
          ok: false,
          service: "chat",
          ...snapshot,
          certificationError: error instanceof Error ? error.message : "certification_failed",
        });
      }
    }
    return json(200, {
      ok: readiness.canAcceptTurns(),
      service: "chat",
      ...snapshot,
    });
  }
  if (url.pathname === "/api/v1/chat/runtime-authority" && request.method === "GET") {
    const signed = resolveBff(request, "", url.pathname);
    if (!signed.ok) return json(401, { error: "unauthorized", reason: signed.reason });
    return json(200, {
      chatFsRootFingerprint: chatFsRootFingerprint(env.CHAT_FS_ROOT),
      sourceRevision: env.SOURCE_REVISION?.trim() || null,
      productAuthority: "main_postgresql",
      localAuthority: "terminal_candidate_and_bounded_trace",
    });
  }

  if (url.pathname === CHAT_RUNTIME_DIAGNOSTICS_PATH && request.method === "GET") {
    if (!internal(request)) return json(401, { error: "unauthorized" });
    await readiness.refreshDependencies();
    return json(200, {
      version: 1,
      service: "chat",
      checkedAt: new Date().toISOString(),
      sourceRevision: env.SOURCE_REVISION?.trim() || null,
      runtime: readiness.snapshot(),
      provider: {
        adapter: env.CHAT_MODEL_PROVIDER,
        model: env.CHAT_MODEL_NAME,
        endpoint: env.CHAT_MODEL_PROVIDER === "mock" ? null : env.CHAT_MODEL_BASE_URL,
      },
    });
  }

  if (url.pathname === "/internal/agent-runs" && request.method === "POST") {
    if (!internal(request)) return json(401, { error: "unauthorized" });
    await readiness.refreshDependencies();
    if (!readiness.canAcceptTurns()) return json(503, { error: "service_not_ready" });
    const raw = await readBody(request);
    const signed = resolveBff(request, raw, url.pathname);
    if (!signed.ok || !signed.context.authority) {
      return json(401, { error: "invalid_main_authority", reason: signed.ok ? "missing_authority" : signed.reason });
    }
    const snapshot = chatExecutionSnapshotSchema.parse(JSON.parse(raw));
    if (snapshot.userId !== signed.context.userId) {
      return json(409, { error: "turn_authority_mismatch" });
    }
    const admitted = await acceptAgentRun({
      schemaVersion: 1,
      admittedAt: new Date().toISOString(),
      snapshot,
      authority: signed.context.authority,
    });
    if (admitted.tombstoned) {
      return json(409, { error: "agent_run_attempt_tombstoned" });
    }
    return json(202, { ok: true, duplicate: admitted.duplicate, terminal: admitted.terminal });
  }

  if (url.pathname === ACCOUNT_DELETION_V2_INGEST_PATH && request.method === "POST") {
    if (!internal(request)) return json(401, { error: "unauthorized" });
    const raw = await readBody(request);
    return json(200, await consumeAccountDeletionRequest(JSON.parse(raw)));
  }

  if (
    request.method === "POST" &&
    (url.pathname === COMPANION_MEMORY_PURGE_PATH
      || url.pathname === COMPANION_MEMORY_REBUILD_PREPARE_PATH
      || url.pathname === COMPANION_MEMORY_REBUILD_PROMOTE_PATH)
  ) {
    if (!internal(request)) return json(401, { error: "unauthorized" });
    await readiness.refreshDependencies();
    if (!readiness.canAcceptTurns()) return json(503, { error: "service_not_ready" });
    try {
      if (url.pathname === COMPANION_MEMORY_PURGE_PATH) {
        const result = await purgeCompanionMemory(request);
        return json(200, { ok: true, ...result });
      }
      if (url.pathname === COMPANION_MEMORY_REBUILD_PREPARE_PATH) {
        const rebuilt = await prepareCompanionMemory(request);
        return json(200, { ok: true, rebuilt });
      }
      const rebuilt = await promoteCompanionMemory(request);
      return json(200, { ok: true, rebuilt });
    } catch (error) {
      logger.warn({ err: error }, "companion memory request rejected");
      return json(400, { error: "invalid_companion_memory_request" });
    }
  }

  const cancel = url.pathname.match(/^\/internal\/agent-runs\/([^/]+)\/(\d+)\/cancel$/u);
  if (cancel && request.method === "POST") {
    if (!internal(request)) return json(401, { error: "unauthorized" });
    return json(200, { ok: true, active: await cancelAgentRun(decodeURIComponent(cancel[1]), Number(cancel[2])) });
  }

  const purgeRun = url.pathname.match(/^\/internal\/agent-runs\/([^/]+)\/purge$/u);
  if (purgeRun && request.method === "POST") {
    if (!internal(request)) return json(401, { error: "unauthorized" });
    const raw = await readBody(request);
    const body = raw ? JSON.parse(raw) as { throughAttempt?: unknown } : {};
    const throughAttempt = typeof body.throughAttempt === "number" &&
        Number.isSafeInteger(body.throughAttempt) && body.throughAttempt > 0
      ? body.throughAttempt
      : null;
    return json(200, {
      ok: true,
      purged: throughAttempt === null
        ? await purgeAgentRunsForTurn(decodeURIComponent(purgeRun[1]))
        : await purgeAgentRunsThroughAttempt(decodeURIComponent(purgeRun[1]), throughAttempt),
    });
  }

  const stream = url.pathname.match(/^\/api\/v1\/(?:chat\/)?messages\/([^/]+)\/stream$/u);
  if (stream && request.method === "GET") {
    const signed = resolveBff(request, "", url.pathname);
    if (!signed.ok) return json(401, { error: "unauthorized", reason: signed.reason });
    const assistantMessageId = decodeURIComponent(stream[1]);
    const index = await findAgentRunByAssistant(assistantMessageId);
    if (!index || index.userId !== signed.context.userId) return json(404, { error: "agent_run_not_found" });
    const requestedAttempt = positiveAttempt(url.searchParams.get("attempt"));
    if (requestedAttempt !== undefined && requestedAttempt !== index.attempt) {
      return json(409, { error: "agent_run_attempt_mismatch" });
    }
    return createSseResponse(
      streamKey(assistantMessageId),
      url.searchParams.get("lastEventId") ?? request.headers.get("last-event-id"),
      index.attempt,
    );
  }

  return json(404, { error: "not_found" });
}

type BffResult =
  | { ok: true; context: BffContext }
  | { ok: false; reason: string };

function resolveBff(request: Request, body: string, path: string): BffResult {
  const secret = env.BFF_SIGNING_SECRET;
  if (!secret) {
    if (process.env.APP_ENV !== "test") return { ok: false, reason: "missing_bff_secret" };
    const userId = request.headers.get("x-idream-user-id");
    return userId
      ? { ok: true, context: { userId, authTime: Date.now() } }
      : { ok: false, reason: "no_user" };
  }
  const signature = request.headers.get(BFF_HEADER);
  const raw = request.headers.get(BFF_USER_HEADER);
  if (!signature || !raw) return { ok: false, reason: "missing_bff" };
  let context: BffContext;
  try {
    context = JSON.parse(raw) as BffContext;
  } catch {
    return { ok: false, reason: "bad_context" };
  }
  const verdict = verifyBffContext({
    secret,
    signature,
    context,
    method: request.method,
    path,
    body,
    now: Date.now(),
    ttlMs: BFF_TTL_MS,
  });
  return verdict.ok ? { ok: true, context } : { ok: false, reason: verdict.reason };
}

function internal(request: Request): boolean {
  return Boolean(env.INTERNAL_TOKEN) && request.headers.get("x-internal-token") === env.INTERNAL_TOKEN;
}

async function readBody(request: Request): Promise<string> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error("AgentRun input exceeds 2 MiB");
  }
  return raw;
}

function positiveAttempt(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function json(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache",
      vary: "Authorization, X-iDream-BFF, X-iDream-BFF-User",
    },
  });
}

export function assertBffSecretReady(): void {
  if (process.env.APP_ENV !== "test" && !env.BFF_SIGNING_SECRET) {
    throw new Error("CHAT_BFF_SIGNING_SECRET is required outside APP_ENV=test");
  }
}

export function startWeb(): ReturnType<typeof createChatServer> {
  assertBffSecretReady();
  const server = createChatServer(runtimeReadiness, { port: env.PORT });
  logger.info({ port: server.port }, "Chat listening");
  return server;
}
