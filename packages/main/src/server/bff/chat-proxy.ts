// SPEC: main-web BFF reverse proxy for /api/v1/chat/* (design §1, §3). Verifies
// the user via main's session (cookie), signs an internal user context (HMAC over
// userId/authTime/method/path/body-hash, short TTL), and forwards to the chat
// service. The chat service STILL re-checks authz against views — the signature
// only proves authn. Streams the response through (for SSE).
// INVARIANT: never forwards the raw cookie; only the signed context crosses the
// trust boundary.
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { getAuthCtx } from "@/server/lib/auth";
import { env } from "@/server/lib/env";

const HOP_BY_HOP = new Set(["cookie", "host", "connection", "content-length", "transfer-encoding"]);

export function chatServiceEnabled(): boolean {
  return Boolean(env.CHAT_SERVICE_URL);
}

/** Proxy an /api/v1/chat/* request to the chat service. `segments` includes the
 *  leading "chat". Returns the chat service's Response (possibly streaming). */
export async function proxyChatRequest(request: Request, segments: string[]): Promise<Response> {
  const base = env.CHAT_SERVICE_URL;
  const secret = env.CHAT_BFF_SIGNING_SECRET;
  if (!base) return jsonError(503, "chat_unavailable", "CHAT_SERVICE_URL not configured");

  const auth = await getAuthCtx(request);
  if (!auth.userId) return jsonError(401, "unauthorized", "sign in required");

  const incoming = new URL(request.url);
  const path = `/api/v1/${segments.join("/")}`;
  const targetUrl = `${base.replace(/\/$/, "")}${path}${incoming.search}`;

  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }

  // Sign the internal user context (authn). No secret ⇒ dev mode: pass user header.
  if (secret) {
    const { signature, context } = signBffContext({
      secret,
      userId: auth.userId,
      method: request.method,
      path,
      body,
    });
    headers.set(BFF_HEADER, signature);
    headers.set(BFF_USER_HEADER, JSON.stringify(context));
  } else {
    headers.set("x-idream-user-id", auth.userId);
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: body || undefined,
    // @ts-expect-error Node fetch streaming flag for response bodies
    duplex: "half",
  });

  // Pass through status + body (streaming-safe for SSE).
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
