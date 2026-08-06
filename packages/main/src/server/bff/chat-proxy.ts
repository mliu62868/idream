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
import { isSyntheticMediaAsset } from "@/server/lib/media-asset-authority";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";

const HOP_BY_HOP = new Set(["cookie", "host", "connection", "content-length", "transfer-encoding"]);
const INBOUND_TRUST_HEADERS = new Set([
  "x-idream-bff",
  "x-idream-bff-user",
  "x-idream-role",
  "x-idream-user-id",
]);

/** Shown in place of a generated reply when input moderation blocks the turn. */
const BLOCKED_NOTICE = "I can’t help with that request.";

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
  scene: {
    schemaVersion: 1;
    version: number;
    location: string | null;
    time: string | null;
    participants: string[];
    emotionalBeat: string | null;
    unresolvedThreads: string[];
  } | null;
  characterContentVersionId: string | null;
  characterReleaseId: string | null;
};

/** Signed server-to-server read; Voice never accepts client-authored text/Scene. */
export async function fetchChatMessageVoiceAuthority(
  request: Request,
  input: { sessionId: string; messageId: string; testOnlyText?: string; characterId?: string },
): Promise<ChatMessageVoiceAuthority> {
  const base = env.CHAT_SERVICE_URL;
  const secret = env.CHAT_BFF_SIGNING_SECRET;
  const auth = await getAuthCtx(request);
  if (!auth.userId) throw new Error("sign in required");
  if (process.env.NODE_ENV === "test") {
    // INTENT: isolated Main integration tests do not boot the independently
    // migrated Chat service. Production has no fallback and fails closed.
    return {
      schemaVersion: 1,
      sessionId: input.sessionId,
      messageId: input.messageId,
      characterId: input.characterId ?? "test-character",
      text: input.testOnlyText ?? "test voice",
      attempt: 1,
      sceneVersion: 0,
      scene: null,
      characterContentVersionId: null,
      characterReleaseId: null,
    };
  }
  if (!base) {
    throw new Error("CHAT_SERVICE_URL not configured");
  }
  if (!secret && env.APP_ENV !== "test") throw new Error("CHAT_BFF_SIGNING_SECRET not configured");
  const path = `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/messages/${encodeURIComponent(input.messageId)}/voice-authority`;
  const headers = new Headers();
  if (secret) {
    const signed = signBffContext({ secret, userId: auth.userId, method: "GET", path, body: "" });
    headers.set(BFF_HEADER, signed.signature);
    headers.set(BFF_USER_HEADER, JSON.stringify(signed.context));
  } else {
    headers.set("x-idream-user-id", auth.userId);
  }
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, { method: "GET", headers });
  if (!response.ok) throw new Error(`Chat Voice authority HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as ChatMessageVoiceAuthority;
}

/** Proxy an /api/v1/chat/* request to the chat service. `segments` includes the
 *  leading "chat". Returns the chat service's Response (possibly streaming). */
export async function proxyChatRequest(request: Request, segments: string[]): Promise<Response> {
  const base = env.CHAT_SERVICE_URL;
  const secret = env.CHAT_BFF_SIGNING_SECRET;
  if (!base) return jsonError(503, "chat_unavailable", "CHAT_SERVICE_URL not configured");
  if (!secret && env.APP_ENV !== "test") {
    return jsonError(
      503,
      "chat_unavailable",
      "CHAT_BFF_SIGNING_SECRET not configured",
    );
  }

  const auth = await getAuthCtx(request);
  if (!auth.userId) return jsonError(401, "unauthorized", "sign in required");

  const incoming = new URL(request.url);
  const path = `/api/v1/${segments.join("/")}`;
  const targetUrl = `${base.replace(/\/$/, "")}${path}${incoming.search}`;

  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const normalized = k.toLowerCase();
    if (
      !HOP_BY_HOP.has(normalized) &&
      !INBOUND_TRUST_HEADERS.has(normalized)
    ) {
      headers.set(k, v);
    }
  }

  // Sign the internal user context. Plaintext identity exists only inside tests.
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
  applyPrivateNoStoreHeaders(respHeaders);
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
    select: {
      id: true,
      url: true,
      thumbnailUrl: true,
      width: true,
      height: true,
      metadata: true,
    },
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
        const isSynthetic = asset ? isSyntheticMediaAsset(asset.metadata) : false;
        return asset
          ? {
              ...attachment,
              mediaUrl: asset.url,
              thumbnailUrl: asset.thumbnailUrl ?? asset.url,
              width: attachment.width ?? asset.width,
              height: attachment.height ?? asset.height,
              isSynthetic,
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
  const headers = new Headers({ "content-type": "application/json" });
  applyPrivateNoStoreHeaders(headers);
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers,
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
  const headers = new Headers({ "content-type": "application/json" });
  applyPrivateNoStoreHeaders(headers);
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers,
  });
}

function applyPrivateNoStoreHeaders(headers: Headers) {
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  const vary = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  vary.add("Cookie");
  vary.add("Authorization");
  headers.set("vary", [...vary].join(", "));
}
