import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceCallSchema } from "@idream/shared/contracts";
import { characterVoiceCallHistorySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { providers } from "@/server/providers";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { compileUserCharacterContent, materializeUserCharacterContentVersion } from "@/server/modules/ourdream/character-soul";
import { createUser, createCharacter, grantCoins, purgeTestData, dreamcoinBalance } from "@/server/test/helpers";
import { createChatSession, commitChatTerminal, executionSnapshot } from "./turn-ledger";
import { expireVoiceCalls, readCharacterVoiceCalls } from "./voice-call";
import type { VoiceClipPort } from "@/server/providers/types";
import { GET as readCallHistory } from "@/app/api/v2/admin/characters/[id]/voice-calls/route";

const P = "zt-call-audit-";
const previous = { voice: providers.voice, provider: env.VOICE_PROVIDER, language: env.POCKET_TTS_LANGUAGE, asr: env.ASR_PROVIDER, token: env.PARAKEET_ASR_API_TOKEN };
let serial = 0;
const originalSynthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
const synthesize = vi.fn<VoiceClipPort["synthesize"]>(originalSynthesize);
const asr = vi.fn(async (id: string) => Response.json({ requestId: id, status: "completed", text: "Hello, tell me one good thing about your day.", audioDurationMs: 800, expiresAt: Date.now() + 120_000 }));
const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
  const url = String(input);
  if (url.endsWith("/health")) return Response.json({ ready: true, model: "moondream/parakeet-redux", modelRevision: "2bf128600aac4b16946f7ed8372e56117fe5e23b", runtimeVersion: "2.6.1" });
  if (url.includes("/v1/transcriptions")) {
    const id = new Headers(init?.headers).get("x-asr-request-id")!;
    if (init?.method === "DELETE") return Response.json({ requestId: id, status: "cancelled" });
    return asr(id);
  }
  if (url.endsWith("/internal/agent-runs")) {
    const snapshot = JSON.parse(String(init?.body));
    return Response.json({ ok: true, turnId: snapshot.turnId, attempt: snapshot.attempt, duplicate: false, terminal: false, deadlineAt: new Date(Date.now() + 120_000).toISOString() });
  }
  if (url.includes("/internal/agent-runs/")) return Response.json({ ok: true });
  throw new Error(`Unexpected transport in controlled Call test: ${url}`);
});
beforeAll(async () => {
  await purgeTestData(P);
  env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english";
  env.ASR_PROVIDER = "parakeet-redux"; env.PARAKEET_ASR_API_TOKEN = "call-handler-test-token";
  const voice = createVoicePortsForKey("pocket_tts");
  providers.voice = { clip: { providerKey: "pocket_tts", synthesize }, identity: voice.identity };
  vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false } });
  await prisma.featureFlag.upsert({ where: { key: "voice_gen" }, create: { key: "voice_gen", label: "Voice", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] }, update: { enabled: true } });
});
beforeEach(() => { synthesize.mockClear(); synthesize.mockImplementation(originalSynthesize); asr.mockClear(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => {
  vi.restoreAllMocks(); providers.voice = previous.voice; env.VOICE_PROVIDER = previous.provider; env.POCKET_TTS_LANGUAGE = previous.language;
  env.ASR_PROVIDER = previous.asr; env.PARAKEET_ASR_API_TOKEN = previous.token;
  await purgeTestData(P); await prisma.$disconnect();
});
async function fixture() {
  const userId = `${P}${++serial}`, characterId = `${userId}-character`;
  await createUser({ id: userId }); await prisma.ageGateAcceptance.create({ data: { userId } });
  const character = await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
  await prisma.$transaction(async tx => {
    const version = await materializeUserCharacterContentVersion({ tx, characterId, sourceId: null, createdById: userId, content: compileUserCharacterContent(character) });
    await tx.character.update({ where: { id: characterId }, data: { currentContentVersionId: version.id } });
  });
  await grantCoins(userId, 20, "call-test");
  const sessionId = (await createChatSession(userId, { characterId })).id;
  return { userId, characterId, sessionId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(f: Fixture, method: string, suffix = "", options: { body?: unknown; audio?: Blob; token?: string; userId?: string; scope?: string } = {}) {
  const actor = options.userId ?? f.userId;
  const form = new FormData(); if (options.audio) form.set("audio", options.audio, "recording.wav");
  const request = new Request(`http://localhost/api/v1/chat/sessions/${f.sessionId}/voice-call${suffix}`, { method,
    headers: { "x-idream-user-id": actor, "x-idream-viewer-scope": options.scope ?? `user:${actor}`,
      ...(options.token ? { "x-idream-call-lease": options.token } : {}), ...(options.body ? { "content-type": "application/json" } : {}) },
    body: options.audio ? form : options.body ? JSON.stringify(options.body) : undefined,
  });
  const response = await proxyChatRequest(request, ["chat", "sessions", f.sessionId, "voice-call", ...suffix.split("/").filter(Boolean)]);
  return { response, value: await response.json() };
}
async function start(f: Fixture, maxCostDreamcoins = 4, maxDurationMs = 180_000) {
  const body = { id: randomUUID(), clientLeaseToken: randomUUID(), language: "en", maxCostDreamcoins, maxDurationMs };
  const quote = await run(f, "POST", "/quote", { body }); expect(quote.response.status).toBe(200);
  const intent = { ...body, quoteToken: quote.value.quoteToken };
  const connected = await run(f, "POST", "", { body: intent }); expect(connected.response.status).toBe(200);
  return { ...voiceCallSchema.parse(connected.value.call), intent };
}
async function recording() {
  const wave = await originalSynthesize({ text: "recorded input", requestId: "fixture", attemptNo: 1, idempotencyKey: "fixture", voiceId: "alba" });
  if (!wave.ok) throw new Error("WAV fixture failed");
  return new Blob([Uint8Array.from(wave.data.body)], { type: wave.data.contentType });
}
async function utterance(f: Fixture, call: Awaited<ReturnType<typeof start>>) {
  const id = randomUUID();
  const result = await run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio: await recording() });
  expect(result.response.status).toBe(200); expect(result.value.assistantMessageId).toBeTruthy();
  const record = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
  const snapshot = await executionSnapshot(record.turnId!);
  await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: "I found a bright yellow flower beside the path.", model: "controlled-fixture", promptTokens: 5, completionTokens: 8,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "controlled-call-test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
  return id;
}
describe("canonical Call recording, recovery and settlement", () => {
  it("returns the original no_speech failure immediately and replays it without ASR, a Turn, TTS or coins", async () => {
    const f = await fixture(), call = await start(f), id = randomUUID(), audio = await recording();
    asr.mockResolvedValueOnce(Response.json({ requestId: id, status: "failed", errorCode: "no_speech" }));
    const failed = await run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio });
    expect(failed.response.status).toBe(200);
    expect(failed.value).toMatchObject({ utteranceId: id, status: "failed", errorCode: "no_speech" });
    const stored = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ status: "failed", errorCode: "no_speech", turnId: null, assistantMessageId: null, voiceRequestId: null, costDreamcoins: 0 });
    for (const method of ["GET", "POST"]) {
      const replay = await run(f, method, `/${call.id}/utterances/${id}`, { token: call.leaseToken, ...(method === "POST" ? { audio } : {}) });
      expect(replay.response.status).toBe(200); expect(replay.value).toMatchObject({ utteranceId: id, status: "failed", errorCode: "no_speech" });
    }
    expect(asr).toHaveBeenCalledOnce(); expect(synthesize).not.toHaveBeenCalled();
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
    expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
    const unchanged = await run(f, "GET", `/${call.id}`, { token: call.leaseToken });
    expect(unchanged.response.status).toBe(200);
    expect(voiceCallSchema.parse(unchanged.value.call)).toMatchObject({ status: "active", costDreamcoins: 0, voiceDurationMs: 0 });
    expect(await dreamcoinBalance(f.userId)).toBe(20);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("drives recorded multipart through ASR, Main Turn, voice delivery and free replay once", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const sent = await run(f, "GET", `/${call.id}/utterances/${id}`, { token: call.leaseToken });
    expect(sent.value.assistantStatus).toBe("sent"); expect(sent.value.userMessage.content).toContain("tell me");
    const voice = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken });
    expect(voice.response.status).toBe(201); expect(voice.value.data.contentUrl).toContain("/media/");
    expect((await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken })).response.status).toBe(200);
    expect(synthesize).toHaveBeenCalledTimes(1); expect(asr).toHaveBeenCalledTimes(1);
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(1);
    const u = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect(u).toMatchObject({ status: "delivered", replyAttempt: 1, costDreamcoins: 2 }); expect(u.durationMs).toBeGreaterThan(0);
    expect(await prisma.voiceUsageFact.count({ where: { requestId: u.voiceRequestId! } })).toBe(1); expect(await dreamcoinBalance(f.userId)).toBe(18);
    const ended = await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
    const replay = await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
    expect(replay.value.call).toEqual(ended.value.call); expect(await dreamcoinBalance(f.userId)).toBe(18);
    const history = characterVoiceCallHistorySchema.parse(await readCharacterVoiceCalls(f.characterId));
    expect(history.items[0]).toMatchObject({ status: "ended", costDreamcoins: 2, provider: "pocket_tts", leaseToken: "" });
    const operator = `${f.userId}-admin`; await createUser({ id: operator, role: "admin", dataClass: "internal" });
    const adminRequest = new Request(`http://localhost/api/v2/admin/characters/${f.characterId}/voice-calls`, { headers: { "x-idream-user-id": operator, "x-idream-role": "admin" } });
    const readable = await readCallHistory(adminRequest, { params: Promise.resolve({ id: f.characterId }) });
    expect(readable.status).toBe(200); expect((await readable.json()).data.items[0]).toMatchObject({ id: call.id, status: "ended", costDreamcoins: 2 });
    const forbidden = await readCallHistory(new Request(adminRequest.url, { headers: { "x-idream-user-id": f.userId } }), { params: Promise.resolve({ id: f.characterId }) });
    expect(forbidden.status).toBe(403);
  });
  it("reserves one Call, validates exact terms, and rejects foreign session/tab/recording identities", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    expect((await run(f, "POST", "", { body: call.intent })).value.call.id).toBe(call.id);
    expect((await run(f, "POST", "", { body: { ...call.intent, maxCostDreamcoins: 5 } })).response.status).toBe(409);
    const other = { ...call.intent, id: randomUUID(), clientLeaseToken: randomUUID() };
    const quote = await run(f, "POST", "/quote", { body: other });
    expect((await run(f, "POST", "", { body: { ...other, quoteToken: quote.value.quoteToken } })).response.status).toBe(409);
    expect((await run(f, "POST", `/${call.id}/mute`, { token: randomUUID() })).response.status).toBe(409);
    const hidden = await run(f, "GET", `/${call.id}`); expect(hidden.value.call.leaseToken).toBe("");
    expect((await run(f, "GET", "", { scope: "user:changed" })).response.status).toBe(409);
    expect((await run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio: new Blob(["changed audio"]) })).response.status).toBe(409);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("expires the owner lease without cancelling the reply, and Resume speaks that same reply once", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    await prisma.voiceCall.update({ where: { id: call.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    await expireVoiceCalls(f.userId);
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "disconnected", connectedMs: 0 });
    const kept = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect(kept.status).toBe("linked");
    expect((await prisma.chatTurn.findUniqueOrThrow({ where: { id: kept.turnId! } })).assistantStatus).toBe("sent");
    expect((await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken })).response.status).toBe(410);
    expect(synthesize).not.toHaveBeenCalled();
    const resumed = await run(f, "POST", `/${call.id}/resume`);
    expect(resumed.response.status).toBe(200); expect(resumed.value.call.id).toBe(call.id); expect(resumed.value.call.leaseToken).not.toBe(call.leaseToken);
    expect((await run(f, "POST", `/${call.id}/heartbeat`, { token: call.leaseToken })).response.status).toBe(409);
    const detail = await run(f, "GET", `/${call.id}`, { token: resumed.value.call.leaseToken });
    expect(detail.value.utterances).toEqual([expect.objectContaining({ utteranceId: id, status: "linked", assistantStatus: "sent" })]);
    expect((await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: resumed.value.call.leaseToken })).response.status).toBe(201);
    expect(synthesize).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(f.userId)).toBe(18);
    expect(await prisma.voiceCall.count({ where: { userId: f.userId } })).toBe(1);
    await run(f, "POST", `/${call.id}/end`, { token: resumed.value.call.leaseToken });
  });
  it("keeps the in-flight reply across an explicit tab disconnect but cancels it when the hard deadline ends the Call", async () => {
    const f = await fixture(), call = await start(f, 4, 60_000), id = await utterance(f, call);
    expect((await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken })).response.status).toBe(200);
    expect((await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).status).toBe("linked");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 61_000);
    await expireVoiceCalls(f.userId);
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "ended", endReason: "duration_limit" });
    expect((await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
    expect(await dreamcoinBalance(f.userId)).toBe(20);
  });
  it("falls back to the standard voice when a voice plan's Character voice cannot run a local Call", async () => {
    const f = await fixture();
    await prisma.entitlement.create({ data: { userId: f.userId, key: "voice_enabled", value: true, source: "subscription" } });
    const referenceId = `${f.characterId}-reference`, voiceId = `${f.characterId}-fish`;
    await prisma.mediaAsset.create({ data: { id: referenceId, ownerId: f.userId, characterId: f.characterId, type: "voice",
      url: `/user-content/${referenceId}/content.wav`, visibility: "private", contentType: "audio/wav", metadata: { filename: "voice.wav", sizeBytes: 2048 } } });
    await prisma.characterVoiceProfile.create({ data: { characterId: f.characterId, version: 1, provider: "fish_audio", providerVoiceId: voiceId,
      model: "fish", language: "english", status: "active", referenceAssetId: referenceId, sampleText: "Own voice", createdById: f.userId } });
    await prisma.character.update({ where: { id: f.characterId }, data: { voiceId } });
    const body = { id: randomUUID(), clientLeaseToken: randomUUID(), language: "en", maxCostDreamcoins: 2, maxDurationMs: 180_000 };
    const quote = await run(f, "POST", "/quote", { body });
    expect(quote.response.status).toBe(200); expect(quote.value.voiceFallback).toBe(true);
    const connected = await run(f, "POST", "", { body: { ...body, quoteToken: quote.value.quoteToken } });
    expect(connected.response.status).toBe(200);
    const stored = await prisma.voiceCall.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.providerPayload).toMatchObject({ providerKey: "pocket_tts", voiceAuthority: "system_default" });
    await run(f, "POST", `/${body.id}/end`, { token: body.clientLeaseToken });
  });
  it("enforces the total Call budget across replies without starting another synthesis", async () => {
    const f = await fixture(), call = await start(f, 2), first = await utterance(f, call);
    expect((await run(f, "POST", `/${call.id}/utterances/${first}/voice`, { token: call.leaseToken })).response.status).toBe(201);
    const second = await utterance(f, call);
    const stopped = await run(f, "POST", `/${call.id}/utterances/${second}/voice`, { token: call.leaseToken });
    expect(stopped.response.status).toBe(200); expect(stopped.value.data.contentUrl).toBeUndefined();
    expect(synthesize).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(f.userId)).toBe(18);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("does not admit late transcription after mute and replays one recording into one Main Turn", async () => {
    const f = await fixture(), call = await start(f), id = randomUUID();
    let release!: (response: Response) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    asr.mockImplementationOnce(async () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); });
    const pending = run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio: await recording() });
    await ready; await run(f, "POST", `/${call.id}/mute`, { token: call.leaseToken });
    release(Response.json({ requestId: id, status: "completed", text: "Late speech", audioDurationMs: 800, expiresAt: Date.now() + 120_000 }));
    expect((await pending).response.status).toBe(410); expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
    await run(f, "POST", `/${call.id}/unmute`, { token: call.leaseToken });
    const next = await utterance(f, call);
    const replay = await run(f, "POST", `/${call.id}/utterances/${next}`, { token: call.leaseToken, audio: await recording() });
    expect(replay.response.status).toBe(200); expect(replay.value.assistantStatus).toBe("sent");
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(1);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it.each(["interrupt", "mute", "end"])("rejects late TTS delivery and charges after %s", async action => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    synthesize.mockImplementationOnce(async input => { entered(); await hold; return originalSynthesize(input); });
    const inflight = run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken }); await ready;
    expect((await run(f, "POST", `/${call.id}/${action}`, { token: call.leaseToken })).response.status).toBe(200);
    release(); expect((await inflight).response.status).toBe(410);
    expect(await dreamcoinBalance(f.userId)).toBe(20);
    const request = await prisma.voiceClipRequest.findFirstOrThrow({ where: { voiceCallUtteranceId: id } });
    expect(request).toMatchObject({ status: "failed", mediaAssetId: null, errorCode: "voice_call_delivery_revoked" });
    expect(await prisma.voiceUsageFact.findFirstOrThrow({ where: { requestId: request.id } })).toMatchObject({ costDreamcoins: 0, mediaAssetId: null });
    expect(await prisma.mediaAsset.count({ where: { ownerId: f.userId, type: "voice" } })).toBe(0);
    if (action !== "end") await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("keeps consent and terminal settlement immutable and releases hard-deadline ownership", async () => {
    const f = await fixture(), call = await start(f, 4, 15_000);
    await expect(prisma.voiceCall.update({ where: { id: call.id }, data: { maxCostDreamcoins: 100 } })).rejects.toThrow(/immutable/);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 16_000);
    await expireVoiceCalls(f.userId);
    const ended = await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(ended).toMatchObject({ status: "ended", activeKey: null, connectedMs: 0, endReason: "duration_limit" }); expect(ended.settledAt).not.toBeNull();
    await expect(prisma.voiceCall.update({ where: { id: call.id }, data: { connectedMs: 10 } })).rejects.toThrow(/immutable/);
    expect(await dreamcoinBalance(f.userId)).toBe(20);
  });
});
