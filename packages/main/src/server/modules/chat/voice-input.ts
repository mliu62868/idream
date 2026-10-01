import { z } from "zod";
import { VOICE_INPUT_LANGUAGES, VOICE_INPUT_MAX_DURATION_MS, VOICE_INPUT_MAX_UPLOAD_BYTES, VOICE_INPUT_RESULT_TTL_MS, voiceInputCapabilitySchema } from "@idream/shared/contracts";
import { getAuthCtx, requireAgeGate, requireAgeVerified } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { asrConfigured, asrReady, requestAsr } from "@/server/providers/asr/parakeet-redux";
import { assertChatSessionServingAuthority } from "./turn-ledger";
import { readVoiceUpload } from "@/server/providers/asr/upload";

const privateHeaders = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache", vary: "Cookie, Authorization" };
type Conversation = { kind: "session" | "group"; id: string };
async function authorize(request: Request, userId: string, conversation: Conversation) {
  const auth = await getAuthCtx(request);
  if (auth.userId !== userId) throw Errors.unauthorized("Sign in required");
  requireAgeGate(auth);
  requireAgeVerified(auth);
  if (request.headers.get("x-idream-viewer-scope") !== `user:${userId}`) throw Errors.conflict("Your account changed. Reload before using voice input");
  if (conversation.kind === "session") {
    const session = await prisma.recentChat.findFirst({ where: { userId, sessionId: conversation.id }, select: { status: true, groupId: true, characterId: true, characterReleaseId: true } });
    if (!session) throw Errors.notFound("Chat session not found");
    if (session.groupId) throw Errors.conflict("Open this conversation from its group chat");
    if (session.status !== "active") throw Errors.gone("Chat session is archived");
    await assertChatSessionServingAuthority(prisma, userId, session);
  } else {
    const group = await prisma.groupConversation.findFirst({ where: { userId, id: conversation.id }, select: { status: true } });
    if (!group) throw Errors.notFound("Group conversation not found");
    if (group.status !== "active") throw Errors.gone("Group conversation is archived");
    const characterId = request.headers.get("x-idream-voice-character-id")?.trim();
    if (!characterId || characterId.length > 160) throw Errors.badRequest("Choose the group voice input recipient");
    const member = await prisma.recentChat.findFirst({
      where: { userId, groupId: conversation.id, characterId },
      select: { status: true, characterId: true, characterReleaseId: true },
    });
    if (!member) throw Errors.notFound("Choose a Character who belongs to this group");
    if (member.status !== "active") throw Errors.gone("Group recipient is archived");
    await assertChatSessionServingAuthority(prisma, userId, member);
  }
}

/** Dispatch before chat's JSON reader: these uploads never become Turns/assets. */
export async function routeVoiceInput(request: Request, path: string[], userId: string): Promise<Response | null> {
  if (!(path[0] === "sessions" || path[0] === "groups") || !path[1]) return null;
  if (!((path[2] === "voice-input" && path.length === 3) || (path[2] === "transcriptions" && (path.length === 3 || path.length === 4)))) return null;
  const conversation: Conversation = { kind: path[0] === "sessions" ? "session" : "group", id: path[1] };
  await authorize(request, userId, conversation);
  const respond = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status, headers: privateHeaders });
  if (path[2] === "voice-input" && request.method === "GET") {
    const supported = asrConfigured();
    const available = supported && await asrReady();
    return respond(voiceInputCapabilitySchema.parse({ supported, available,
      ...(!available ? { reason: supported ? "unavailable" : "not_configured" } : {}), ownerScope: `user:${userId}`,
      languages: VOICE_INPUT_LANGUAGES, maxDurationMs: VOICE_INPUT_MAX_DURATION_MS,
      maxUploadBytes: VOICE_INPUT_MAX_UPLOAD_BYTES, resultTtlMs: VOICE_INPUT_RESULT_TTL_MS,
    }));
  }
  const method = request.method;
  if (!(path[2] === "transcriptions" && ((method === "POST" && path.length === 3) || ((method === "GET" || method === "DELETE") && path.length === 4)))) throw Errors.notFound("Voice input route not found");
  const key = method === "POST" ? request.headers.get("idempotency-key") : path[3];
  const parsed = z.uuid().safeParse(key);
  if (!parsed.success) throw Errors.badRequest("A UUID recording Idempotency-Key/requestId is required");
  const scope = { userId, conversationId: `${conversation.kind}:${conversation.id}`, requestId: parsed.data };
  const audio = method === "POST" ? await readVoiceUpload(request) : undefined;
  // Uploading may outlive account/session eligibility; recheck before inference.
  if (audio) await authorize(request, userId, conversation);
  const result = await requestAsr(method, scope, audio);
  try { await authorize(request, userId, conversation); }
  catch (error) { await requestAsr("DELETE", scope).catch(() => {}); throw error; }
  return respond(result, result.status === "pending" ? 202 : 200);
}
