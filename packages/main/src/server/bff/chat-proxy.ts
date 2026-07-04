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
import { prisma } from "@/server/lib/db";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";

const HOP_BY_HOP = new Set(["cookie", "host", "connection", "content-length", "transfer-encoding"]);

/** Shown in place of a generated reply when input moderation blocks the turn. */
const BLOCKED_NOTICE = "I can’t help with that request.";

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

  // Shape-adapt the few endpoints the product frontend consumes: the chat service
  // speaks a lean raw protocol, while the frontend expects the monolith's
  // { ok, data } envelope with embedded/echoed objects. Adapt ONLY these 2xx JSON
  // responses; everything else (SSE streams, management endpoints) streams through.
  const adapted = await adaptForFrontend(request.method, segments, body, upstream, auth.userId);
  if (adapted) return adapted;

  // Pass through status + body (streaming-safe for SSE).
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

/** Reshape the 3 frontend-consumed chat responses into the { ok, data } contract. */
async function adaptForFrontend(
  method: string,
  segments: string[],
  reqBody: string,
  upstream: Response,
  userId: string,
): Promise<Response | null> {
  if (!upstream.ok) return null;
  if (!(upstream.headers.get("content-type") ?? "").includes("application/json")) return null;
  const s = segments; // includes leading "chat"

  // POST /chat/sessions → { data: { session: { id, ... } } }
  if (method === "POST" && s.length === 2 && s[0] === "chat" && s[1] === "sessions") {
    const session = (await upstream.json()) as { id?: string };
    return envelope({ session }, upstream.status);
  }

  // GET /chat/sessions/:id → { data: { session: { ..., character:{name}, messages } } }
  if (method === "GET" && s.length === 3 && s[0] === "chat" && s[1] === "sessions") {
    const raw = (await upstream.json()) as {
      session?: { characterId?: string } & Record<string, unknown>;
      messages?: Array<Record<string, unknown>>;
    };
    const session = raw.session ?? {};
    const characterId = session.characterId;
    const character = characterId
      ? await prisma.character.findUnique({
          where: { id: characterId },
          select: { creatorId: true, name: true },
        })
      : null;
    const messages = await enrichAttachmentMedia(raw.messages ?? [], userId);
    return envelope(
      {
        session: {
          ...session,
          character: {
            name: character?.name ?? "",
            canUpdateIdentity: character?.creatorId === userId,
          },
          messages,
        },
      },
      upstream.status,
    );
  }

  // POST /chat/sessions/:id/messages → { data: { userMessage, assistant, streamUrl } }
  if (method === "POST" && s.length === 4 && s[0] === "chat" && s[1] === "sessions" && s[3] === "messages") {
    const raw = (await upstream.json()) as {
      userMessageId?: string;
      assistantMessageId?: string;
      streamUrl?: string | null;
      status?: "generating" | "blocked";
      safety?: { layer: "input" | "output"; policyCode?: string };
    };
    const content = safeContent(reqBody);
    const blocked = raw.status === "blocked";
    // Blocked input carries no stream — the assistant turn is a terminal safety
    // notice the UI shows in place (design P0-B). Never hand the client a streamUrl.
    return envelope(
      {
        userMessage: { id: raw.userMessageId, role: "user", content },
        assistant: {
          id: raw.assistantMessageId,
          role: "assistant",
          content: blocked ? BLOCKED_NOTICE : "",
          status: raw.status ?? "generating",
        },
        streamUrl: blocked ? null : (raw.streamUrl ?? null),
        ...(raw.safety ? { safety: raw.safety } : {}),
      },
      upstream.status,
    );
  }

  return null;
}

async function enrichAttachmentMedia(messages: Array<Record<string, unknown>>, userId: string) {
  const ids = new Set<string>();
  for (const message of messages) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      if (!isRecord(attachment)) continue;
      const mediaAssetId = typeof attachment.mediaAssetId === "string" ? attachment.mediaAssetId : null;
      if (mediaAssetId) ids.add(mediaAssetId);
    }
  }
  if (ids.size === 0) return messages;

  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: [...ids] },
      deletedAt: null,
      ...isReusablePlatformAssetWhere(userId),
    },
    select: { id: true, url: true, thumbnailUrl: true, width: true, height: true },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return messages.map((message) => {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return {
      ...message,
      attachments: attachments.map((attachment) => {
        if (!isRecord(attachment)) return attachment;
        const mediaAssetId = typeof attachment.mediaAssetId === "string" ? attachment.mediaAssetId : null;
        const asset = mediaAssetId ? byId.get(mediaAssetId) : null;
        return asset
          ? {
              ...attachment,
              mediaUrl: asset.url,
              thumbnailUrl: asset.thumbnailUrl ?? asset.url,
              width: attachment.width ?? asset.width,
              height: attachment.height ?? asset.height,
            }
          : attachment;
      }),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function envelope(data: unknown, status: number): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeContent(reqBody: string): string {
  try {
    return String((JSON.parse(reqBody) as { content?: unknown }).content ?? "").trim();
  } catch {
    return "";
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
