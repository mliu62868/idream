// SPEC: chat/web HTTP server (design §1, §3). Thin Node adapter over dispatchChat.
// Verifies the BFF signature (main-web signs the internal user context) before
// dispatch; in dev/test with no secret, falls back to x-idream-user-id. SSE
// streams tokens from the Redis stream.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BFF_HEADER, BFF_USER_HEADER, verifyBffContext, type BffContext } from "@idream/shared/bff";
import { dispatchChatAdmin } from "./admin.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { dispatchChat, type ChatRequest } from "./router.js";
import { createSseResponse } from "./stream.js";
import { persistInboundEvent } from "./inbox.js";
import { enqueue } from "./queue.js";
import { CHAT_QUEUES, idempotencyKeys } from "@idream/shared/contracts";

const BFF_TTL_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

const privateJsonHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "content-type": "application/json",
  pragma: "no-cache",
  vary: "Authorization, Cookie, X-iDream-BFF, X-iDream-BFF-User",
};

export function createChatServer() {
  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error({ err: error }, "unhandled request error");
      if (!res.headersSent) res.writeHead(500, privateJsonHeaders);
      res.end(JSON.stringify({ error: "internal" }));
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  if (url.pathname === "/healthz") {
    res.writeHead(200, privateJsonHeaders);
    res.end(JSON.stringify({ ok: true, service: "chat" }));
    return;
  }

  // Internal admin API (main-web proxy only). Authed by shared INTERNAL_TOKEN,
  // NOT the BFF user signature — these are service-to-service, user-agnostic reads.
  if (url.pathname.startsWith("/internal/")) {
    const token = header(req, "x-internal-token");
    if (!env.INTERNAL_TOKEN || token !== env.INTERNAL_TOKEN) {
      res.writeHead(401, privateJsonHeaders);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/internal/events/ingest" && req.method === "POST") {
      const raw = await readBody(req);
      const event = safeJson(raw);
      const ack = await persistInboundEvent(event);
      if (ack.acknowledged && ack.receiptId) {
        await enqueue({
          queue: CHAT_QUEUES.inboxConsume,
          payload: { receiptId: ack.receiptId },
          dedupeKey: idempotencyKeys.chatInbox(ack.receiptId),
        }).catch(() => undefined);
      }
      res.writeHead(ack.acknowledged ? 200 : 409, privateJsonHeaders);
      res.end(JSON.stringify(ack));
      return;
    }
    const result = await dispatchChatAdmin({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });
    res.writeHead(result.status, privateJsonHeaders);
    res.end(jsonStringify(result.body));
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error;
    res.writeHead(413, privateJsonHeaders);
    res.end(JSON.stringify({ error: "payload_too_large" }));
    return;
  }
  const auth = resolveUser(req, raw, url.pathname);
  if (!auth.ok) {
    res.writeHead(401, privateJsonHeaders);
    res.end(JSON.stringify({ error: "unauthorized", reason: auth.reason }));
    return;
  }
  const isMessageSend =
    req.method === "POST" &&
    /^\/api\/v1\/chat\/sessions\/[^/]+\/messages\/?$/.test(url.pathname);
  const idempotencyKey = header(req, "idempotency-key")?.trim();
  if (isMessageSend && !idempotencyKey) {
    res.writeHead(400, privateJsonHeaders);
    res.end(JSON.stringify({
      error: "idempotency_key_required",
      message: "Idempotency-Key is required",
    }));
    return;
  }

  const request: ChatRequest = {
    method: req.method ?? "GET",
    path: url.pathname,
    userId: auth.userId,
    body: raw ? safeJson(raw) : undefined,
    query: Object.fromEntries(url.searchParams.entries()),
    idempotencyKey,
  };

  const result = await dispatchChat(request);

  if (result.kind === "sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-cache, no-store, no-transform",
      connection: "keep-alive",
      pragma: "no-cache",
      vary: "Authorization, Cookie, X-iDream-BFF, X-iDream-BFF-User",
      "x-accel-buffering": "no",
    });
    // Resume cursor precedence: explicit ?lastEventId= → EventSource's Last-Event-ID
    // header (sent automatically on auto-reconnect). Without the header, a dropped
    // SSE connection replays from 0 and duplicates every delta on reconnect.
    const response = createSseResponse(
      result.streamKey,
      result.lastEventId ?? request.query?.lastEventId ?? header(req, "last-event-id"),
    );
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    nodeStream.pipe(res);
    req.on("close", () => nodeStream.destroy());
    return;
  }

  res.writeHead(result.status, privateJsonHeaders);
  res.end(jsonStringify(result.body));
}

/** BigInt-safe JSON (chat.* has BigInt columns like logExtractedSeq). */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

interface AuthOk { ok: true; userId: string }
interface AuthFail { ok: false; reason: string }

export function resolveUser(
  req: IncomingMessage,
  body: string,
  path: string,
): AuthOk | AuthFail {
  const secret = env.BFF_SIGNING_SECRET;
  // Test-only escape hatch. Development and preview use the same signed
  // trust boundary as production so a reachable chat port never trusts a
  // caller-provided identity.
  if (!secret) {
    if (process.env.APP_ENV !== "test") {
      return { ok: false, reason: "missing_bff_secret" };
    }
    const userId = header(req, "x-idream-user-id");
    return userId ? { ok: true, userId } : { ok: false, reason: "no_user" };
  }

  const signature = header(req, BFF_HEADER);
  const ctxRaw = header(req, BFF_USER_HEADER);
  if (!signature || !ctxRaw) return { ok: false, reason: "missing_bff" };
  let context: BffContext;
  try {
    context = JSON.parse(ctxRaw) as BffContext;
  } catch {
    return { ok: false, reason: "bad_context" };
  }
  const verdict = verifyBffContext({
    secret,
    signature,
    context,
    method: req.method ?? "GET",
    path,
    body,
    now: Date.now(),
    ttlMs: BFF_TTL_MS,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, userId: context.userId };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// SPEC: signed BFF context is the runtime trust boundary in every environment.
// Only APP_ENV=test may use the plaintext header fixture.
export function assertBffSecretReady(): void {
  if (process.env.APP_ENV !== "test" && !env.BFF_SIGNING_SECRET) {
    throw new Error(
      "CHAT_BFF_SIGNING_SECRET is required outside APP_ENV=test (refusing to trust plaintext x-idream-user-id headers)",
    );
  }
}

export function startWeb(): ReturnType<typeof createChatServer> {
  assertBffSecretReady();
  const server = createChatServer();
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, "chat/web listening"));
  return server;
}
