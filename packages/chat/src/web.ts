// SPEC: chat/web HTTP server (design §1, §3). Thin Node adapter over dispatchChat.
// Verifies the BFF signature (main-web signs the internal user context) before
// dispatch; in dev/test with no secret, falls back to x-idream-user-id. SSE
// streams tokens from the Redis stream.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BFF_HEADER, BFF_USER_HEADER, verifyBffContext, type BffContext } from "@idream/shared/bff";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { dispatchChat, type ChatRequest } from "./router.js";
import { createSseResponse } from "./stream.js";

const BFF_TTL_MS = 30_000;

export function createChatServer() {
  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error({ err: error }, "unhandled request error");
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "chat" }));
    return;
  }

  const raw = await readBody(req);
  const auth = resolveUser(req, raw, url.pathname);
  if (!auth.ok) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized", reason: auth.reason }));
    return;
  }

  const request: ChatRequest = {
    method: req.method ?? "GET",
    path: url.pathname,
    userId: auth.userId,
    body: raw ? safeJson(raw) : undefined,
    query: Object.fromEntries(url.searchParams.entries()),
  };

  const result = await dispatchChat(request);

  if (result.kind === "sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const response = createSseResponse(result.streamKey, result.lastEventId ?? request.query?.lastEventId);
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    nodeStream.pipe(res);
    req.on("close", () => nodeStream.destroy());
    return;
  }

  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(jsonStringify(result.body));
}

/** BigInt-safe JSON (chat.* has BigInt columns like logExtractedSeq). */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

interface AuthOk { ok: true; userId: string }
interface AuthFail { ok: false; reason: string }

function resolveUser(req: IncomingMessage, body: string, path: string): AuthOk | AuthFail {
  const secret = env.BFF_SIGNING_SECRET;
  // Dev/test escape hatch: no secret configured → trust the user header.
  if (!secret) {
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
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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

export function startWeb(): ReturnType<typeof createChatServer> {
  const server = createChatServer();
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, "chat/web listening"));
  return server;
}
