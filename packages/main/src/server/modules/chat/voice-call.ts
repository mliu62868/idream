import { createHash, randomUUID } from "node:crypto";
import { type Prisma, type VoiceCall, type VoiceCallUtterance } from "@prisma/client";
import { z } from "zod";
import { voiceCallSchema, voiceCallStartSchema, voiceClipBillingAuthoritySchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { getAuthCtx, requireAgeGate, requireAgeVerified } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import { generationCostFromAuthority, resolveGenerationPricingAuthority } from "@/server/lib/generation-pricing";
import { dreamcoinBalance } from "@/server/modules/billing/ledger";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import { providers } from "@/server/providers";
import { asrReady, requestAsr } from "@/server/providers/asr/parakeet-redux";
import { readVoiceUpload } from "@/server/providers/asr/upload";
import { createVoiceClip, characterVoiceTone, pinnedVoiceProviderPayloadSchema } from "../ourdream/voice-clip";
import { acceptVoiceClipQuote, signVoiceClipQuote } from "../ourdream/voice-clip-quote";
import { entitlementMap } from "../ourdream/subscription-lifecycle";
import { readableCharacter } from "../ourdream/generation-character-authority";
import { beginAdmittedChatTurn, cancelAdmittedChatTurn } from "./agent-run-admission";
import { assertChatSessionServingAuthority, chatTurnMessagesForOwner } from "./turn-ledger";

const LEASE_MS = 15_000;
const LIVE = ["active", "muted"];
type Start = z.infer<typeof voiceCallStartSchema>;

// SPEC: English local batch ASR/TTS supports turn-based calls, not streaming
// audio or a claim that every ASR-supported language is qualified for calls.
export async function voiceCallAvailability() {
  const local = env.VOICE_PROVIDER === "pocket-tts" && providers.voice.clip.providerKey === "pocket_tts" &&
    providers.voice.identity?.providerKey === "pocket_tts" && ["en", "english"].includes(env.POCKET_TTS_LANGUAGE.toLowerCase());
  const voice = local ? await providers.voice.identity?.inspectCapabilities() : null;
  const available = Boolean(env.CHAT_SERVICE_URL) && local && voice?.ok === true && await asrReady();
  return { status: available ? "available" as const : "unavailable" as const,
    ...(!available ? { reason: "local_english_audio_unavailable" } : {}), language: "en", transport: "turn-based" };
}
async function sessionAuthority(userId: string, sessionId: string) {
  const session = await prisma.recentChat.findFirst({ where: { userId, sessionId, groupId: null, status: "active" } });
  if (!session) throw Errors.notFound("Active single-character chat not found");
  await assertChatSessionServingAuthority(prisma, userId, session);
  return session;
}
async function callTerms(userId: string, sessionId: string, body: Start) {
  const session = await sessionAuthority(userId, sessionId);
  const entitlements = await entitlementMap(userId);
  const identity = await resolveCharacterVoiceAuthority({ characterId: session.characterId, systemDefaultOnly: entitlements.voice_enabled !== true });
  if (identity.providerKey !== "pocket_tts") throw Errors.unavailable("This voice is not qualified for English local calls");
  const character = await readableCharacter(session.characterId, userId);
  const providerPayload = pinnedVoiceProviderPayloadSchema.parse({
    providerKey: identity.providerKey, voiceId: identity.voiceId, voiceAuthority: identity.source,
    systemVoiceSettingVersion: identity.settingVersion, characterVoiceProfileVersion: identity.characterVoiceProfileVersion,
    tone: characterVoiceTone(character), delivery: identity.delivery,
  });
  const pricing = await resolveGenerationPricingAuthority("voice");
  const cost = generationCostFromAuthority(pricing, 1);
  const now = new Date();
  const fingerprint = canonicalJsonHash({ version: "voice-call-1", userId, sessionId, id: body.id, clientLeaseToken: body.clientLeaseToken,
    language: body.language, maxCostDreamcoins: body.maxCostDreamcoins, maxDurationMs: body.maxDurationMs, providerPayload });
  const billing = voiceClipBillingAuthoritySchema.parse({
    version: 1, userId, requestFingerprint: fingerprint, intent: "play", pricingFingerprint: canonicalJsonHash(pricing),
    overflowCostDreamcoins: cost, maxCostDreamcoins: Math.min(body.maxCostDreamcoins, cost),
    allowanceMinutes: typeof entitlements.voice_minutes === "number" ? entitlements.voice_minutes : 0,
    allowanceWindowStartsAt: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  });
  return { session, providerPayload, billing, fingerprint };
}
async function publicCall(call: VoiceCall) {
  const totals = await prisma.voiceCallUtterance.aggregate({ where: { callId: call.id }, _sum: { costDreamcoins: true, durationMs: true } });
  return voiceCallSchema.parse({
    id: call.id, sessionId: call.sessionId, characterId: call.characterId, status: call.status, language: call.language,
    leaseToken: call.leaseToken, leaseExpiresAt: call.leaseExpiresAt.toISOString(), deadlineAt: call.deadlineAt.toISOString(),
    startedAt: call.startedAt.toISOString(), endedAt: call.endedAt?.toISOString() ?? null, connectedMs: call.connectedMs,
    maxCostDreamcoins: call.maxCostDreamcoins, costDreamcoins: totals._sum.costDreamcoins ?? 0,
    voiceDurationMs: totals._sum.durationMs ?? 0, endReason: call.endReason,
  });
}
export async function getVoiceCallCapability(userId: string, sessionId: string, token?: string | null) {
  await sessionAuthority(userId, sessionId);
  await expireVoiceCalls(userId);
  const current = await prisma.voiceCall.findFirst({ where: { userId, sessionId }, orderBy: { createdAt: "desc" } });
  const other = await prisma.voiceCall.findFirst({ where: { activeKey: userId, sessionId: { not: sessionId } }, select: { sessionId: true } });
  return { sessionId, ...(await voiceCallAvailability()), balance: await dreamcoinBalance(userId), otherCallSessionId: other?.sessionId ?? null,
    call: current ? { ...await publicCall(current), leaseToken: current.leaseToken === token ? current.leaseToken : "" } : null };
}
export async function startVoiceCall(userId: string, sessionId: string, body: Start) {
  const existing = await prisma.voiceCall.findUnique({ where: { id: body.id } });
  if (existing) {
    if (existing.userId !== userId || existing.sessionId !== sessionId) throw Errors.notFound("Call not found");
    if (existing.maxCostDreamcoins !== body.maxCostDreamcoins || existing.deadlineAt.getTime() - existing.startedAt.getTime() !== body.maxDurationMs) throw Errors.conflict("Call key was already used with different terms");
    if (existing.leaseToken !== body.clientLeaseToken) throw Errors.conflict("This call is controlled by another tab");
    return publicCall(existing);
  }
  if ((await voiceCallAvailability()).status !== "available") throw Errors.unavailable("English local calls are unavailable");
  const terms = await callTerms(userId, sessionId, body);
  if (!body.quoteToken) throw Errors.conflict("Accept a Call quote before connecting");
  const billing = acceptVoiceClipQuote({ token: body.quoteToken, userId, requestFingerprint: terms.fingerprint, secret: env.BETTER_AUTH_SECRET });
  if (billing.allowanceMinutes !== terms.billing.allowanceMinutes) throw Errors.conflict("Voice allowance changed; request another quote");
  await expireVoiceCalls(userId);
  const now = new Date();
  const call = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const duplicate = await tx.voiceCall.findUnique({ where: { id: body.id } });
    if (duplicate) { if (duplicate.userId !== userId || duplicate.requestHash !== terms.fingerprint) throw Errors.conflict("Call key conflict"); return duplicate; }
    const active = await tx.voiceCall.findUnique({ where: { activeKey: userId } });
    if (active) throw Errors.conflict("Resume or end your existing call first", { callId: active.id });
    const session = await tx.recentChat.findFirst({ where: { sessionId, userId, status: "active", groupId: null } });
    if (!session) throw Errors.gone("The conversation is no longer active");
    await assertChatSessionServingAuthority(tx, userId, session);
    if (body.maxCostDreamcoins > await dreamcoinBalance(userId, tx)) throw Errors.paymentRequired("Call budget exceeds your balance");
    return tx.voiceCall.create({ data: {
      id: body.id, userId, sessionId, characterId: terms.session.characterId, activeKey: userId, requestHash: terms.fingerprint,
      providerPayload: toInputJson(terms.providerPayload), billingAuthority: toInputJson(billing), maxCostDreamcoins: body.maxCostDreamcoins,
      leaseToken: body.clientLeaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), deadlineAt: new Date(now.getTime() + body.maxDurationMs),
      lastHeartbeatAt: now, startedAt: now,
    } });
  });
  return publicCall(call);
}
function leaseIsLive(call: VoiceCall, leaseToken: string | null, now = new Date()) {
  return LIVE.includes(call.status) && call.leaseToken === leaseToken && call.leaseExpiresAt > now && call.deadlineAt > now;
}
async function ownedCall(userId: string, sessionId: string, id: string) {
  const call = await prisma.voiceCall.findFirst({ where: { id, userId, sessionId } });
  if (!call) throw Errors.notFound("Call not found");
  return call;
}
async function cancelUtterance(userId: string, utterance: VoiceCallUtterance) {
  await prisma.voiceCallUtterance.updateMany({ where: { id: utterance.id, settledAt: null, status: { in: ["transcribing", "linked"] } }, data: { status: "cancelled" } });
  if (utterance.assistantMessageId && utterance.replyAttempt) await cancelAdmittedChatTurn(userId, utterance.assistantMessageId, utterance.replyAttempt);
  await requestAsr("DELETE", { userId, conversationId: `call:${utterance.callId}`, requestId: utterance.id }).catch(() => {});
}
async function markPendingCancelled(tx: Prisma.TransactionClient, callId: string) {
  const pending = await tx.voiceCallUtterance.findMany({ where: { callId, status: { in: ["transcribing", "linked"] } } });
  await tx.voiceCallUtterance.updateMany({ where: { id: { in: pending.map(u => u.id) }, settledAt: null }, data: { status: "cancelled" } });
  return pending;
}
// Missing heartbeat never adds unobserved connected time. The hard deadline
// releases exclusive ownership even when the browser/process never returns.
export async function expireVoiceCalls(userId?: string) {
  const now = new Date();
  const calls = await prisma.voiceCall.findMany({ where: { ...(userId ? { userId } : {}), status: { not: "ended" },
    OR: [{ deadlineAt: { lte: now } }, { status: { in: LIVE }, leaseExpiresAt: { lte: now } }] }, take: 100 });
  for (const observed of calls) {
    const pending = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${observed.userId} FOR UPDATE`;
      const current = await tx.voiceCall.findUnique({ where: { id: observed.id } });
      if (!current || current.status === "ended" || (current.deadlineAt > now && (!LIVE.includes(current.status) || current.leaseExpiresAt > now))) return [];
      const ended = current.deadlineAt <= now;
      await tx.voiceCall.update({ where: { id: current.id }, data: {
        status: ended ? "ended" : "disconnected", ...(ended ? { endedAt: now, settledAt: now, activeKey: null, endReason: "duration_limit" } : {}),
      } });
      return markPendingCancelled(tx, current.id);
    });
    for (const utterance of pending) await cancelUtterance(observed.userId, utterance);
  }
}
async function controlCall(userId: string, sessionId: string, id: string, token: string | null, action: string) {
  await expireVoiceCalls(userId);
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const call = await tx.voiceCall.findFirst({ where: { id, userId, sessionId } });
    if (!call) throw Errors.notFound("Call not found");
    if (call.status === "ended") return { call, pending: [] as VoiceCallUtterance[] };
    const now = new Date();
    if (action !== "resume" && call.leaseToken !== token) throw Errors.conflict("This call is controlled by another tab");
    if (action === "resume" && call.status !== "disconnected") throw Errors.conflict("This call is still controlled by another tab");
    if (!["end", "resume"].includes(action) && call.status === "disconnected") throw Errors.gone("Resume this disconnected call first");
    const ended = action === "end";
    const increment = leaseIsLive(call, token, now) ? Math.min(LEASE_MS, now.getTime() - call.lastHeartbeatAt.getTime()) : 0;
    const updated = await tx.voiceCall.update({ where: { id }, data: {
      connectedMs: { increment }, lastHeartbeatAt: now,
      status: ended ? "ended" : action === "disconnect" ? "disconnected" : action === "mute" ? "muted" : action === "unmute" || action === "resume" ? "active" : call.status,
      leaseExpiresAt: new Date(Math.min(call.deadlineAt.getTime(), now.getTime() + LEASE_MS)),
      ...(action === "resume" ? { leaseToken: randomUUID() } : {}),
      ...(ended ? { endedAt: now, settledAt: now, endReason: "user_ended", activeKey: null } : {}),
    } });
    return { call: updated, pending: ["end", "mute", "interrupt", "disconnect"].includes(action) ? await markPendingCancelled(tx, id) : [] };
  });
  for (const utterance of result.pending) await cancelUtterance(userId, utterance);
  return publicCall(result.call);
}
async function utteranceState(call: VoiceCall, utterance: VoiceCallUtterance) {
  const turn = utterance.turnId ? await prisma.chatTurn.findUnique({ where: { id: utterance.turnId }, include: { attachments: true } }) : null;
  if (utterance.status === "linked" && turn && ["failed", "blocked", "cancelled"].includes(turn.assistantStatus)) {
    await prisma.voiceCallUtterance.updateMany({ where: { id: utterance.id, status: "linked", settledAt: null }, data: { status: "failed", errorCode: `chat_${turn.assistantStatus}` } });
    utterance = { ...utterance, status: "failed", errorCode: `chat_${turn.assistantStatus}` };
  }
  const messages = turn ? await chatTurnMessagesForOwner(call.userId, [turn]) : [];
  return { utteranceId: utterance.id, status: utterance.status, errorCode: utterance.errorCode,
    ...(turn ? { userMessage: messages.find(m => m.id === turn.userMessageId), assistant: messages.find(m => m.id === turn.assistantMessageId) } : {}),
    assistantMessageId: utterance.assistantMessageId, attempt: utterance.replyAttempt,
    assistantStatus: turn?.assistantStatus ?? null, contentUrl: utterance.mediaAssetId ? `/api/v1/media/${utterance.mediaAssetId}/content` : null,
    streamUrl: turn ? `/api/v1/messages/${turn.assistantMessageId}/stream?attempt=${turn.attempt}` : null, callId: call.id };
}
async function submitUtterance(call: VoiceCall, token: string | null, id: string, audio?: Blob) {
  if (!leaseIsLive(call, token) || call.status !== "active") throw Errors.gone("Call is not listening");
  let utterance = await prisma.voiceCallUtterance.findUnique({ where: { id } });
  if (utterance && utterance.callId !== call.id) throw Errors.conflict("Recording key belongs to another call");
  if (audio) {
    const digest = createHash("sha256").update(new Uint8Array(await audio.arrayBuffer())).digest("hex");
    if (utterance && utterance.audioDigest !== digest) throw Errors.conflict("Recording key has different audio");
    if (!utterance) utterance = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${call.userId} FOR UPDATE`;
      const current = await tx.voiceCall.findUniqueOrThrow({ where: { id: call.id } });
      if (!leaseIsLive(current, token) || current.status !== "active") throw Errors.gone("Call stopped while uploading");
      const duplicate = await tx.voiceCallUtterance.findUnique({ where: { id } });
      if (duplicate) { if (duplicate.callId !== call.id || duplicate.audioDigest !== digest) throw Errors.conflict("Recording key conflict"); return duplicate; }
      if (await tx.voiceCallUtterance.count({ where: { callId: call.id, status: { in: ["transcribing", "linked"] } } })) throw Errors.conflict("Wait for the current turn or interrupt it first");
      return tx.voiceCallUtterance.create({ data: { id, callId: call.id, audioDigest: digest } });
    });
  }
  if (!utterance) throw Errors.notFound("Recording not found");
  if (utterance.turnId || utterance.status !== "transcribing") return utteranceState(call, utterance);
  const result = await requestAsr(audio ? "POST" : "GET", { userId: call.userId, conversationId: `call:${call.id}`, requestId: id }, audio);
  if (result.status === "completed") {
    if (!leaseIsLive(await ownedCall(call.userId, call.sessionId, call.id), token)) throw Errors.gone("Call stopped during transcription");
    const begun = await beginAdmittedChatTurn({ userId: call.userId, sessionId: call.sessionId, content: result.text,
      idempotencyKey: `call:${call.id}:${id}`, voiceCall: { id: call.id, leaseToken: token!, utteranceId: id } });
    return { utteranceId: id, ...begun };
  }
  if (result.status === "failed" || result.status === "cancelled") await prisma.voiceCallUtterance.update({ where: { id }, data: { status: "failed", errorCode: result.status === "failed" ? result.errorCode : "cancelled" } });
  return { utteranceId: id, status: result.status,
    errorCode: result.status === "failed" ? result.errorCode : result.status === "cancelled" ? "cancelled" : undefined,
    retryAfterMs: result.status === "pending" ? result.retryAfterMs : undefined };
}
async function speakUtterance(request: Request, call: VoiceCall, token: string | null, id: string) {
  const utterance = await prisma.voiceCallUtterance.findFirst({ where: { id, callId: call.id } });
  if (!utterance?.assistantMessageId || utterance.status === "cancelled") throw Errors.conflict("This spoken turn is unavailable");
  if (!leaseIsLive(call, token) || call.status !== "active") throw Errors.gone("Call is no longer active");
  const reply = await prisma.chatTurn.findFirst({ where: { id: utterance.turnId!, attempt: utterance.replyAttempt!, assistantStatus: "sent" } });
  if (!reply) throw Errors.conflict("This spoken reply changed or is not ready");
  const terms = voiceClipBillingAuthoritySchema.parse(call.billingAuthority);
  const spent = (await prisma.voiceCallUtterance.aggregate({ where: { callId: call.id }, _sum: { costDreamcoins: true } }))._sum.costDreamcoins ?? 0;
  const remaining = Math.max(0, call.maxCostDreamcoins - spent);
  const onlyMinutes = remaining < terms.overflowCostDreamcoins;
  const voiceRequest = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({
    characterId: call.characterId, sessionId: call.sessionId, messageId: utterance.assistantMessageId, intent: onlyMinutes ? "prewarm" : "play",
  }) });
  return createVoiceClip(voiceRequest, { entitlementMap, readableCharacter }, {
    callUtteranceId: id,
    providerPayload: pinnedVoiceProviderPayloadSchema.parse(call.providerPayload),
    billingAuthority: fingerprint => ({ ...terms, requestFingerprint: fingerprint, intent: onlyMinutes ? "prewarm" : "play", maxCostDreamcoins: onlyMinutes ? 0 : terms.overflowCostDreamcoins }),

  });
}
/** Dispatch before Chat's JSON reader: uploads preserve their binary contract. */
export async function routeVoiceCall(request: Request, path: string[], userId: string): Promise<Response | null> {
  if (path[0] !== "sessions" || !path[1] || path[2] !== "voice-call") return null;
  const auth = await getAuthCtx(request);
  requireAgeGate(auth); requireAgeVerified(auth);
  if (auth.userId !== userId) throw Errors.unauthorized("Sign in required");
  if (request.headers.get("x-idream-viewer-scope") !== `user:${userId}`) throw Errors.conflict("Your account changed; reload before calling");
  const sessionId = path[1];
  await sessionAuthority(userId, sessionId);
  const reply = (data: unknown) => Response.json(data, { headers: { "cache-control": "private, no-store", vary: "Cookie, Authorization" } });
  if (path.length === 3 && request.method === "GET") return reply(await getVoiceCallCapability(userId, sessionId, request.headers.get("x-idream-call-lease")));
  if ((path.length === 3 || path[3] === "quote") && request.method === "POST") {
    const body = voiceCallStartSchema.parse(await request.json());
    if (path[3] === "quote") {
      const terms = await callTerms(userId, sessionId, body);
      return reply({ quoteToken: signVoiceClipQuote(terms.billing, env.BETTER_AUTH_SECRET), costPerReply: terms.billing.overflowCostDreamcoins,
        allowanceMinutes: terms.billing.allowanceMinutes, maxCostDreamcoins: body.maxCostDreamcoins, maxDurationMs: body.maxDurationMs,
        billingUnit: "generated reply audio; call time is free", language: "en", transport: "turn-based" });
    }
    return reply({ call: await startVoiceCall(userId, sessionId, body) });
  }
  const callId = z.uuid().parse(path[3]);
  await expireVoiceCalls(userId);
  const call = await ownedCall(userId, sessionId, callId);
  const token = request.headers.get("x-idream-call-lease");
  if (path.length === 4 && request.method === "GET") return reply({ call: { ...await publicCall(call), leaseToken: call.leaseToken === token ? token : "" }, utterances: await Promise.all((await prisma.voiceCallUtterance.findMany({ where: { callId }, orderBy: { createdAt: "asc" } })).map(u => utteranceState(call, u))) });
  if (path.length === 5 && ["heartbeat", "mute", "unmute", "resume", "end", "interrupt", "disconnect"].includes(path[4]) && request.method === "POST") return reply({ call: await controlCall(userId, sessionId, callId, token, path[4]) });
  if (path[4] === "utterances" && path[5]) {
    const id = z.uuid().parse(path[5]);
    if (path.length === 7 && path[6] === "voice" && request.method === "POST") return speakUtterance(request, call, token, id);
    if (path.length === 6 && ["POST", "GET"].includes(request.method)) return reply(await submitUtterance(call, token, id, request.method === "POST" ? await readVoiceUpload(request) : undefined));
  }
  throw Errors.notFound("Call route not found");
}
export async function readCharacterVoiceCalls(characterId: string) {
  const calls = await prisma.voiceCall.findMany({ where: { characterId }, orderBy: { createdAt: "desc" }, take: 50 });
  return { items: await Promise.all(calls.map(async call => ({ ...await publicCall(call), leaseToken: "", userId: call.userId,
    settledAt: call.settledAt?.toISOString() ?? null, provider: pinnedVoiceProviderPayloadSchema.parse(call.providerPayload).providerKey,
    utterances: await prisma.voiceCallUtterance.findMany({ where: { callId: call.id }, select: { id: true, turnId: true, replyAttempt: true, status: true, voiceRequestId: true, mediaAssetId: true, durationMs: true, costDreamcoins: true, errorCode: true } }),
  }))) };
}
