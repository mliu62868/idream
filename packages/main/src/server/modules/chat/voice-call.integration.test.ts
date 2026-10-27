import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceCallSchema } from "@idream/shared/contracts";
import { characterVoiceCallHistorySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { providers } from "@/server/providers";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { compileUserCharacterContent, materializeUserCharacterContentVersion } from "@/server/modules/ourdream/character-soul";
import { api, createUser, createCharacter, grantCoins, purgeTestData, dreamcoinBalance } from "@/server/test/helpers";
import { createChatSession, commitChatTerminal, executionSnapshot } from "./turn-ledger";
import { expireVoiceCalls, readCharacterVoiceCalls } from "./voice-call";
import { reclaimExpiredVoiceClip } from "../ourdream/voice-clip";
import { entitlementMap } from "../ourdream/subscription-lifecycle";
import { readableCharacter } from "../ourdream/generation-character-authority";
import type { VoiceClipPort } from "@/server/providers/types";
import { GET as readCallHistory } from "@/app/api/v2/admin/characters/[id]/voice-calls/route";

const P = "zt-call-audit-";
const previous = { voice: providers.voice, provider: env.VOICE_PROVIDER, language: env.POCKET_TTS_LANGUAGE, asr: env.ASR_PROVIDER, token: env.ASR_API_TOKEN };
let serial = 0;
const originalSynthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
const synthesize = vi.fn<VoiceClipPort["synthesize"]>(originalSynthesize);
const asr = vi.fn(async (id: string) => Response.json({ requestId: id, status: "completed", text: "Hello, tell me one good thing about your day.", audioDurationMs: 800, expiresAt: Date.now() + 120_000 }));
const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
  const url = String(input);
  if (url === `${env.POCKET_TTS_API_URL.replace(/\/$/, "")}/health`) return Response.json({
    voice_cloning: false, catalog_ready: true, catalog_voices: ["anna"], runtime: "pocket_tts", runtime_version: "3.0.2",
    acceleration: "cpu", model_loaded: true, model: env.POCKET_TTS_MODEL, language: "english", system_voice_ready: true,
    model_revision: "controlled-call-model", config_fingerprint: "controlled-call-config",
  });
  if (url === `${env.FISH_AUDIO_API_URL.replace(/\/$/, "")}/health`) return Response.json({ error: "controlled-character-voice-outage" }, { status: 503 });
  if (url === `${env.ASR_API_URL.replace(/\/$/, "")}/health`) return Response.json({ ready: true, provider: "mlx-whisper", model: "mlx-community/whisper-large-v3-mlx", modelRevision: "49e6aa286ad60c14352c404340ded53710378a11", runtimeVersion: "0.4.3", device: "metal", precision: "float16" });
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
  env.ASR_PROVIDER = "mlx-whisper"; env.ASR_API_TOKEN = "call-handler-test-token";
  vi.stubGlobal("fetch", fetcher);
  const voice = createVoicePortsForKey("pocket_tts");
  providers.voice = { clip: { providerKey: "pocket_tts", synthesize }, identity: voice.identity };
  await prisma.featureFlag.upsert({ where: { key: "voice_gen" }, create: { key: "voice_gen", label: "Voice", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] }, update: { enabled: true } });
});
beforeEach(() => { synthesize.mockClear(); synthesize.mockImplementation(originalSynthesize); asr.mockClear(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => {
  vi.restoreAllMocks(); providers.voice = previous.voice; env.VOICE_PROVIDER = previous.provider; env.POCKET_TTS_LANGUAGE = previous.language;
  env.ASR_PROVIDER = previous.asr; env.ASR_API_TOKEN = previous.token;
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
  const quote = await run(f, "POST", "/quote", { body }); expect(quote.response.status, JSON.stringify(quote.value)).toBe(200);
  const intent = { ...body, quoteToken: quote.value.quoteToken };
  const connected = await run(f, "POST", "", { body: intent }); expect(connected.response.status, JSON.stringify(connected.value)).toBe(200);
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
  await completeReply(record.turnId!);
  return id;
}
async function completeReply(turnId: string, content = "I found a bright yellow flower beside the path.") {
  const snapshot = await executionSnapshot(turnId);
  await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content, model: "controlled-fixture", promptTokens: 5, completionTokens: 8,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "controlled-call-test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
  return snapshot;
}

async function archive(f: Fixture) {
  const response = await proxyChatRequest(new Request(`http://localhost/api/v1/chat/sessions/${f.sessionId}/archive`, {
    method: "POST", headers: { "x-idream-user-id": f.userId, "x-idream-viewer-scope": `user:${f.userId}` },
  }), ["chat", "sessions", f.sessionId, "archive"]);
  return { response, value: await response.json() };
}
async function clearMemory(f: Fixture) {
  const response = await proxyChatRequest(new Request(`http://localhost/api/v1/chat/memory/${f.characterId}`, {
    method: "DELETE", headers: { "x-idream-user-id": f.userId, "x-idream-viewer-scope": `user:${f.userId}` },
  }), ["chat", "memory", f.characterId]);
  return { response, value: await response.json() };
}
async function waitForBlockedCalls(holder: number, count: number) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await prisma.$queryRaw<Array<{ count: bigint }>>`WITH RECURSIVE blocked AS (
      SELECT pid FROM pg_stat_activity WHERE ${holder} = ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
    ) SELECT COUNT(DISTINCT pid) AS count FROM blocked`;
    if (Number(result[0]?.count) >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} real operations queued behind the scoped user lock`);
}

describe("canonical Call recording, recovery and settlement", () => {
  it.each(["active", "muted", "disconnected"])("rejects memory clear without changing any relationship state while an empty %s Call has not ended", async status => {
    const f = await fixture(), call = await start(f, 0);
    const pin = await prisma.chatContextDirective.create({ data: {
      id: randomUUID(), userId: f.userId, characterId: f.characterId, kind: "pinned_memory", content: "My notebook is Cedar.",
    } });
    if (status !== "active") expect((await run(f, "POST", `/${call.id}/${status === "muted" ? "mute" : "disconnect"}`, { token: call.leaseToken })).response.status).toBe(200);
    const before = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    const rejected = await clearMemory(f);
    expect.soft(rejected.response.status).toBe(409);
    expect.soft(JSON.stringify(rejected.value)).toContain("End your voice call before clearing this Character's memory");
    expect.soft(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).toMatchObject({
      status: "active", activeKey: before.activeKey, memoryEnabled: before.memoryEnabled, contextRevision: before.contextRevision,
    });
    expect.soft(await prisma.chatContextDirective.findUniqueOrThrow({ where: { id: pin.id } })).toMatchObject({ status: "active", content: "My notebook is Cedar.", version: 1 });
    expect.soft(await prisma.mainOutboxEvent.count({ where: { aggregateType: "chat_relationship", aggregateId: `${f.userId}:${f.characterId}` } })).toBe(0);
    expect.soft(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id }, select: { status: true, activeKey: true, settledAt: true } })).toMatchObject({ status, activeKey: f.userId, settledAt: null });
    expect.soft((await run(f, "GET", `/${call.id}`, { token: call.leaseToken })).response.status).toBe(200);
    expect.soft((await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken })).response.status).toBe(200);
    expect((await clearMemory(f)).response.status).toBe(200);
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).toMatchObject({ status: "archived", activeKey: null, memoryEnabled: false });
    expect(await prisma.chatContextDirective.findUniqueOrThrow({ where: { id: pin.id } })).toMatchObject({ status: "archived", content: "", version: 2 });
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id }, select: { status: true, activeKey: true } })).toMatchObject({ status: "ended", activeKey: null });
    expect(await prisma.voiceCallUtterance.count({ where: { callId: call.id } })).toBe(0);
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
    expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
    expect(await dreamcoinBalance(f.userId)).toBe(20); expect(asr).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
  });
  it.each(["active", "muted", "disconnected"])("keeps an empty %s Call controllable by rejecting archive until it has ended", async status => {
    const f = await fixture(), call = await start(f, 0);
    if (status !== "active") expect((await run(f, "POST", `/${call.id}/${status === "muted" ? "mute" : "disconnect"}`, { token: call.leaseToken })).response.status).toBe(200);
    const rejected = await archive(f);
    expect(rejected.response.status).toBe(409);
    expect(JSON.stringify(rejected.value)).toContain("End your voice call before archiving this chat");
    expect((await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).status).toBe("active");
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status, activeKey: f.userId, settledAt: null });
    expect((await run(f, "GET", `/${call.id}`, { token: call.leaseToken })).response.status).toBe(200);
    expect((await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken })).response.status).toBe(200);
    expect((await archive(f)).response.status).toBe(200);
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "ended", activeKey: null });
    expect(await prisma.voiceCallUtterance.count({ where: { callId: call.id } })).toBe(0);
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
    expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
    expect(await dreamcoinBalance(f.userId)).toBe(20); expect(asr).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
  });
  it.each(["start-first", "archive-first"])("serializes Call creation and archive through their real shared user lock (%s)", async order => {
    const f = await fixture();
    const body = { id: randomUUID(), clientLeaseToken: randomUUID(), language: "en", maxCostDreamcoins: 0, maxDurationMs: 180_000 };
    const quote = await run(f, "POST", "/quote", { body }); expect(quote.response.status, JSON.stringify(quote.value)).toBe(200);
    const intent = { ...body, quoteToken: quote.value.quoteToken };
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let holder = 0;
    const held = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${f.userId} FOR UPDATE`;
      holder = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      ready(); await releasePromise;
    }, { timeout: 10000 });
    await readyPromise;
    try {
      const first = order === "start-first" ? run(f, "POST", "", { body: intent }) : archive(f);
      await waitForBlockedCalls(holder, 1);
      const second = order === "start-first" ? archive(f) : run(f, "POST", "", { body: intent });
      await waitForBlockedCalls(holder, 2); release(); await held;
      const [a, b] = await Promise.all([first, second]);
      const started = order === "start-first" ? a : b, archived = order === "start-first" ? b : a;
      expect(started.response.status).toBe(order === "start-first" ? 200 : 410);
      expect(archived.response.status).toBe(order === "start-first" ? 409 : 200);
      expect((await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).status).toBe(order === "start-first" ? "active" : "archived");
      expect(await prisma.voiceCall.count({ where: { userId: f.userId, status: { not: "ended" } } })).toBe(order === "start-first" ? 1 : 0);
      if (order === "start-first") expect((await run(f, "POST", `/${body.id}/end`, { token: body.clientLeaseToken })).response.status).toBe(200);
      expect(await dreamcoinBalance(f.userId)).toBe(20); expect(asr).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
    } finally { release(); await held; }
  });

  it.each(["start-first", "clear-first"])("serializes Call creation and memory clear through their real shared user lock (%s)", async order => {
    const f = await fixture();
    const body = { id: randomUUID(), clientLeaseToken: randomUUID(), language: "en", maxCostDreamcoins: 0, maxDurationMs: 180_000 };
    const quote = await run(f, "POST", "/quote", { body }); expect(quote.response.status, JSON.stringify(quote.value)).toBe(200);
    const intent = { ...body, quoteToken: quote.value.quoteToken };
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let holder = 0;
    const held = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${f.userId} FOR UPDATE`;
      holder = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      ready(); await releasePromise;
    }, { timeout: 10000 });
    await readyPromise;
    try {
      const first = order === "start-first" ? run(f, "POST", "", { body: intent }) : clearMemory(f);
      await waitForBlockedCalls(holder, 1);
      const second = order === "start-first" ? clearMemory(f) : run(f, "POST", "", { body: intent });
      await waitForBlockedCalls(holder, 2); release(); await held;
      const [a, b] = await Promise.all([first, second]);
      const started = order === "start-first" ? a : b, cleared = order === "start-first" ? b : a;
      expect(started.response.status).toBe(order === "start-first" ? 200 : 410);
      expect(cleared.response.status).toBe(order === "start-first" ? 409 : 200);
      expect((await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).status).toBe(order === "start-first" ? "active" : "archived");
      expect(await prisma.voiceCall.count({ where: { userId: f.userId, status: { not: "ended" } } })).toBe(order === "start-first" ? 1 : 0);
      if (order === "start-first") {
        expect((await run(f, "POST", `/${body.id}/end`, { token: body.clientLeaseToken })).response.status).toBe(200);
        expect((await clearMemory(f)).response.status).toBe(200);
      }
      expect(await prisma.voiceCallUtterance.count({ where: { callId: body.id } })).toBe(0);
      expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
      expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
      expect(await dreamcoinBalance(f.userId)).toBe(20); expect(asr).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
    } finally { release(); await held; }
  });

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
  it.each([
    { gatewayStatus: 422, detail: "invalid_audio", expectedStatus: 400 },
    { gatewayStatus: 410, detail: "unknown_request", expectedStatus: 410 },
  ])("settles a definitive ASR $gatewayStatus failure and admits the next recording", async ({ gatewayStatus, detail, expectedStatus }) => {
    const f = await fixture(), call = await start(f), id = randomUUID(), audio = await recording();
    asr.mockResolvedValueOnce(Response.json({ requestId: id, status: "pending", retryAfterMs: 100 }));
    expect((await run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio })).response.status).toBe(200);
    asr.mockResolvedValueOnce(Response.json({ detail }, { status: gatewayStatus }));
    const rejected = await run(f, "GET", `/${call.id}/utterances/${id}`, { token: call.leaseToken });
    expect(rejected.response.status).toBe(expectedStatus);
    expect.soft(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "failed", errorCode: detail, turnId: null });
    const replay = await run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio });
    expect.soft(replay.response.status).toBe(200); expect.soft(replay.value).toMatchObject({ status: "failed", errorCode: detail });
    expect.soft(asr).toHaveBeenCalledTimes(2);
    expect.soft((await run(f, "POST", `/${call.id}/utterances/${randomUUID()}`, { token: call.leaseToken, audio })).response.status).toBe(200);
    expect(synthesize).not.toHaveBeenCalled(); expect(await dreamcoinBalance(f.userId)).toBe(20);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it.each([429, 503])("preserves the same recording after transient ASR %s and recovers without resubmitting audio", async gatewayStatus => {
    const f = await fixture(), call = await start(f), id = randomUUID(), audio = await recording();
    asr.mockResolvedValueOnce(Response.json({ detail: "temporarily_unavailable" }, { status: gatewayStatus }));
    expect((await run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio })).response.status).toBe(gatewayStatus);
    expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "transcribing", turnId: null });
    const resumed = await run(f, "GET", `/${call.id}/utterances/${id}`, { token: call.leaseToken });
    expect(resumed.response.status).toBe(200); expect(resumed.value.assistantMessageId).toBeTruthy();
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(1);
    expect(asr).toHaveBeenCalledTimes(2); expect(synthesize).not.toHaveBeenCalled(); expect(await dreamcoinBalance(f.userId)).toBe(20);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("does not overwrite an interrupted recording when its ASR failure arrives late", async () => {
    const f = await fixture(), call = await start(f), id = randomUUID(), audio = await recording();
    let complete!: (value: Response) => void;
    asr.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const pending = run(f, "POST", `/${call.id}/utterances/${id}`, { token: call.leaseToken, audio });
    while (!complete) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await run(f, "POST", `/${call.id}/interrupt`, { token: call.leaseToken })).response.status).toBe(200);
    complete(Response.json({ requestId: id, status: "failed", errorCode: "no_speech" }));
    await pending;
    expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "cancelled", turnId: null });
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
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
  it("keeps active Call consent authoritative and replays its delivered reply through ordinary Play once", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const utteranceBefore = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: utteranceBefore.assistantMessageId!, intent: "play" };
    const quote = await api("POST", "generation/voice/quote", { userId: f.userId, body });
    expect(quote.status, JSON.stringify(quote.json)).toBe(200);
    const bypass = await api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false,
      body: { ...body, quoteToken: quote.data.quote.quoteToken } });
    expect(bypass.status).toBe(409); expect(synthesize).not.toHaveBeenCalled();
    expect(await prisma.voiceClipRequest.count({ where: { userId: f.userId } })).toBe(0);

    const delivered = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken });
    expect(delivered.response.status, JSON.stringify(delivered.value)).toBe(201);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { voiceCallUtteranceId: id } });
    const usage = await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } });
    const spends = await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId, reason: "generation_spend" } });
    const ordinary = await api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false, body });
    expect(ordinary.status, JSON.stringify(ordinary.json)).toBe(200);
    expect(ordinary.data.assetId).toBe(delivered.value.data.assetId);
    const replay = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken });
    expect(replay.response.status).toBe(200); expect(replay.value.data.assetId).toBe(ordinary.data.assetId);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(await prisma.voiceClipRequest.findMany({ where: { userId: f.userId } })).toEqual([original]);
    expect(usage).toHaveLength(1); expect(await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } })).toEqual(usage);
    expect(spends).toHaveLength(1); expect(await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId, reason: "generation_spend" } })).toEqual(spends);
    expect(await dreamcoinBalance(f.userId)).toBe(18);
    expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "delivered", voiceRequestId: original.id, costDreamcoins: 2 });
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("rejects ordinary retry when a concurrent Call claims and fails the reply after the initial empty read", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect((await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken })).response.status).toBe(200);
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    const quote = await api("POST", "generation/voice/quote", { userId: f.userId, body });
    expect(quote.status, JSON.stringify(quote.json)).toBe(200);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const originalRead = prisma.voiceCallUtterance.findFirst.bind(prisma.voiceCallUtterance);
    // Read the disconnected Call from the real database, then delay the
    // ordinary request after its empty request and active-Call checks.
    const read = vi.spyOn(prisma.voiceCallUtterance, "findFirst").mockImplementationOnce(args => {
      expect(args).toMatchObject({ where: { assistantMessageId: linked.assistantMessageId, replyAttempt: 1 } });
      const query = originalRead(args), then = query.then.bind(query);
      const observed = then(result => { expect(result).toBeNull(); entered(); return result; });
      query.then = (onFulfilled, onRejected) => observed.then(result => hold.then(() => result)).then(onFulfilled, onRejected);
      return query;
    });
    const pending = api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false,
      body: { ...body, quoteToken: quote.data.quote.quoteToken } });
    let cleanupToken = call.leaseToken;
    try {
      await Promise.race([ready, pending.then(() => { throw new Error("Ordinary playback did not reach its active-Call check"); })]);
      expect(await prisma.voiceClipRequest.count({ where: { userId: f.userId } })).toBe(0);
      const resumed = await run(f, "POST", `/${call.id}/resume`);
      expect(resumed.response.status).toBe(200); cleanupToken = resumed.value.call.leaseToken;
      synthesize.mockResolvedValueOnce({ ok: false, error: { code: "controlled_call_failure", message: "Call synthesis failed", retryable: true } });
      const failed = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: cleanupToken });
      expect(failed.response.status, JSON.stringify(failed.value)).toBe(500);
      const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId: f.userId } });
      expect(original).toMatchObject({ status: "failed", attemptNo: 1, voiceCallUtteranceId: id,
        executionAuthority: { version: 1, kind: "call", callUtteranceId: id, replyAttempt: 1, leaseToken: cleanupToken } });
      release();
      const rejected = await pending;
      expect(rejected.status, JSON.stringify(rejected.json)).toBe(409);
      expect(await prisma.voiceClipRequest.findMany({ where: { userId: f.userId } })).toEqual([original]);
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(await prisma.mediaAsset.count({ where: { ownerId: f.userId } })).toBe(0);
      expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
      expect(await dreamcoinBalance(f.userId)).toBe(20);
    } finally {
      release(); await pending; read.mockRestore();
      await run(f, "POST", `/${call.id}/end`, { token: cleanupToken });
    }
  });
  it("reuses ordinary playback after Call resume without attributing the earlier charge to the Call", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect((await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken })).response.status).toBe(200);
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    const quote = await api("POST", "generation/voice/quote", { userId: f.userId, body });
    expect(quote.status, JSON.stringify(quote.json)).toBe(200);
    const ordinary = await api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false,
      body: { ...body, quoteToken: quote.data.quote.quoteToken } });
    expect(ordinary.status, JSON.stringify(ordinary.json)).toBe(201);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId: f.userId } });
    expect(original.voiceCallUtteranceId).toBeNull();
    const usage = await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } });
    const spends = await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId, reason: "generation_spend" } });

    const resumed = await run(f, "POST", `/${call.id}/resume`);
    expect(resumed.response.status).toBe(200);
    const reused = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: resumed.value.call.leaseToken });
    expect(reused.response.status, JSON.stringify(reused.value)).toBe(200); expect(reused.value.data.assetId).toBe(ordinary.data.assetId);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(await prisma.voiceClipRequest.findMany({ where: { userId: f.userId } })).toEqual([original]);
    expect(usage).toHaveLength(1); expect(await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } })).toEqual(usage);
    expect(spends).toHaveLength(1); expect(await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId, reason: "generation_spend" } })).toEqual(spends);
    expect(await dreamcoinBalance(f.userId)).toBe(18);
    expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "delivered", voiceRequestId: original.id, mediaAssetId: ordinary.data.assetId, durationMs: 0, costDreamcoins: 0,
    });
    const ended = await run(f, "POST", `/${call.id}/end`, { token: resumed.value.call.leaseToken });
    expect(ended.value.call).toMatchObject({ costDreamcoins: 0, voiceDurationMs: 0 });
  });
  it.each(["end", "disconnect", "lease-takeover"])("does not attach or return an ordinary cached clip after Call %s", async action => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect((await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken })).response.status).toBe(200);
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    const quote = await api("POST", "generation/voice/quote", { userId: f.userId, body });
    expect(quote.status, JSON.stringify(quote.json)).toBe(200);
    const ordinary = await api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false,
      body: { ...body, quoteToken: quote.data.quote.quoteToken } });
    expect(ordinary.status, JSON.stringify(ordinary.json)).toBe(201);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId: f.userId } });
    expect(original.voiceCallUtteranceId).toBeNull();
    const usage = await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } });
    const spends = await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId, reason: "generation_spend" } });
    const resumed = await run(f, "POST", `/${call.id}/resume`);
    expect(resumed.response.status).toBe(200);
    const token = resumed.value.call.leaseToken;
    let cleanupToken = token;

    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const originalAggregate = prisma.voiceCallUtterance.aggregate.bind(prisma.voiceCallUtterance);
    const aggregate = vi.spyOn(prisma.voiceCallUtterance, "aggregate").mockImplementationOnce(args => {
      const query = originalAggregate(args), then = query.then.bind(query);
      query.then = (onFulfilled, onRejected) => hold.then(() => then(onFulfilled, onRejected));
      entered(); return query;
    });
    const pending = run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token });
    try {
      await Promise.race([ready, pending.then(() => { throw new Error("Call voice budget lookup was not reached"); })]);
      expect((await run(f, "POST", `/${call.id}/${action === "lease-takeover" ? "disconnect" : action}`, { token })).response.status).toBe(200);
      if (action === "lease-takeover") {
        const takeover = await run(f, "POST", `/${call.id}/resume`);
        expect(takeover.response.status).toBe(200);
        cleanupToken = takeover.value.call.leaseToken;
        expect(cleanupToken).not.toBe(token);
      }
      const stopped = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
      release();
      const rejected = await pending;
      expect(rejected.response.status, JSON.stringify(rejected.value)).toBe(410);
      expect(rejected.value.data?.contentUrl).toBeUndefined();
      expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toEqual(stopped);
      expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
      expect(await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } })).toEqual(usage);
      expect(await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId, reason: "generation_spend" } })).toEqual(spends);
      expect(synthesize).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(f.userId)).toBe(18);
    } finally {
      release(); await pending; aggregate.mockRestore();
      if (action !== "end") await run(f, "POST", `/${call.id}/end`, { token: cleanupToken });
    }
  });
  it.each(["end", "mute", "interrupt", "lease-takeover"])("does not settle an ordinary failed request retried by Call after %s", async action => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect((await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken })).response.status).toBe(200);
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    const quote = await api("POST", "generation/voice/quote", { userId: f.userId, body });
    expect(quote.status, JSON.stringify(quote.json)).toBe(200);
    synthesize.mockResolvedValueOnce({ ok: false, error: { code: "controlled_voice_retry", message: "Retry this ordinary Play", retryable: true } });
    const failed = await api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false,
      body: { ...body, quoteToken: quote.data.quote.quoteToken } });
    expect(failed.status, JSON.stringify(failed.json)).toBe(500);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId: f.userId } });
    expect(original).toMatchObject({ status: "failed", voiceCallUtteranceId: null, mediaAssetId: null });
    const resumed = await run(f, "POST", `/${call.id}/resume`);
    expect(resumed.response.status).toBe(200);
    const token = resumed.value.call.leaseToken;
    let cleanupToken = token;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    synthesize.mockImplementationOnce(async input => { entered(); await hold; return originalSynthesize(input); });
    const pending = run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token });
    try {
      await Promise.race([ready, pending.then(() => { throw new Error("Call did not retry the ordinary voice request"); })]);
      expect((await run(f, "POST", `/${call.id}/${action === "lease-takeover" ? "disconnect" : action}`, { token })).response.status).toBe(200);
      if (action === "lease-takeover") {
        const takeover = await run(f, "POST", `/${call.id}/resume`);
        expect(takeover.response.status).toBe(200);
        cleanupToken = takeover.value.call.leaseToken;
        expect(cleanupToken).not.toBe(token);
      }
      release();
      const rejected = await pending;
      expect(rejected.response.status, JSON.stringify(rejected.value)).toBe(410);
      expect(rejected.value.data?.contentUrl).toBeUndefined();
      expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
        status: "failed", voiceCallUtteranceId: null, billingAuthority: original.billingAuthority,
        providerPayload: original.providerPayload, mediaAssetId: null, errorCode: "voice_call_delivery_revoked",
      });
      expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: action === "lease-takeover" ? "linked" : "cancelled", mediaAssetId: null, costDreamcoins: 0, settledAt: null });
      const usage = await prisma.voiceUsageFact.findMany({ where: { requestId: original.id } });
      expect(usage).toHaveLength(1); expect(usage[0]).toMatchObject({ mediaAssetId: null, costDreamcoins: 0 });
      expect(usage[0].durationMs).toBeGreaterThan(0);
      expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
      expect(await prisma.mediaAsset.count({ where: { ownerId: f.userId, type: "voice" } })).toBe(0);
      expect(synthesize).toHaveBeenCalledTimes(2); expect(await dreamcoinBalance(f.userId)).toBe(20);
    } finally {
      release(); await pending;
      if (action !== "end") await run(f, "POST", `/${call.id}/end`, { token: cleanupToken });
    }
  });
  it("settles a failed ordinary Play retried by Call inside its budget without changing the original request ownership", async () => {
    const f = await fixture(), call = await start(f, 2), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken });
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    synthesize.mockResolvedValueOnce({ ok: false, error: { code: "controlled_voice_retry", message: "Retry ordinary Play", retryable: true } });
    expect((await api("POST", "generation/voice", { userId: f.userId, body })).status).toBe(500);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId: f.userId } });
    expect(original).toMatchObject({ voiceCallUtteranceId: null, executionAuthority: { version: 1, kind: "standalone" } });
    const resumed = await run(f, "POST", `/${call.id}/resume`), token = resumed.value.call.leaseToken;
    const delivered = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token });
    expect(delivered.response.status, JSON.stringify(delivered.value)).toBe(201);
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      voiceCallUtteranceId: null, attemptNo: 2, billingAuthority: original.billingAuthority,
      executionAuthority: { version: 1, kind: "call", callUtteranceId: id, replyAttempt: 1, leaseToken: token },
    });
    const settled = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect(settled).toMatchObject({ status: "delivered", voiceRequestId: original.id, costDreamcoins: 2 });
    expect(settled.durationMs).toBeGreaterThan(0); expect(settled.settledAt).not.toBeNull();
    const next = await utterance(f, { ...call, leaseToken: token });
    const budget = await run(f, "POST", `/${call.id}/utterances/${next}/voice`, { token });
    expect(budget.response.status).toBe(200); expect(budget.value.data.contentUrl).toBeUndefined();
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(await prisma.voiceClipRequest.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.voiceUsageFact.count({ where: { requestId: original.id } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(1);
    expect(await dreamcoinBalance(f.userId)).toBe(18);
    expect((await run(f, "POST", `/${call.id}/end`, { token })).value.call.costDreamcoins).toBe(2);
  });
  it("rejects Call replay waiting on an ordinary in-flight clip when the Call ends before that clip is delivered", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken });
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    let providerEntered!: () => void, release!: () => void, waiting!: () => void;
    const ready = new Promise<void>(resolve => { providerEntered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const claimWaiting = new Promise<void>(resolve => { waiting = resolve; });
    synthesize.mockImplementationOnce(async input => { providerEntered(); await hold; return originalSynthesize(input); });
    const ordinary = api("POST", "generation/voice", { userId: f.userId, body });
    await Promise.race([ready, ordinary.then(() => { throw new Error("Ordinary synthesis did not start"); })]);
    const resumed = await run(f, "POST", `/${call.id}/resume`), token = resumed.value.call.leaseToken;
    const originalRead = prisma.voiceClipRequest.findUniqueOrThrow.bind(prisma.voiceClipRequest);
    const read = vi.spyOn(prisma.voiceClipRequest, "findUniqueOrThrow").mockImplementationOnce(args => { waiting(); return originalRead(args); });
    const pending = run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token });
    try {
      await Promise.race([claimWaiting, pending.then(() => { throw new Error("Call did not wait for the original voice claim"); })]);
      expect((await run(f, "POST", `/${call.id}/end`, { token })).response.status).toBe(200);
      release();
      expect((await ordinary).status).toBe(201);
      const rejected = await pending;
      expect(rejected.response.status, JSON.stringify(rejected.value)).toBe(410);
      expect(rejected.value.data?.contentUrl).toBeUndefined();
      expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "cancelled", mediaAssetId: null, costDreamcoins: 0, settledAt: null });
      expect(synthesize).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(f.userId)).toBe(18);
      expect(await prisma.voiceClipRequest.count({ where: { userId: f.userId } })).toBe(1);
      expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(1);
    } finally { release(); await ordinary; await pending; read.mockRestore(); }
  });
  it.each(["same-lease", "lease-takeover"])("operator recovery preserves the persisted Call execution lease (%s)", async condition => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    synthesize.mockRejectedValueOnce(new Error("Controlled interrupted Call transport"));
    expect((await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken })).response.status).toBe(500);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { voiceCallUtteranceId: id } });
    expect(original.executionAuthority).toEqual({ version: 1, kind: "call", callUtteranceId: id, replyAttempt: 1, leaseToken: call.leaseToken });
    expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ voiceRequestId: original.id, settledAt: null });
    await prisma.voiceClipRequest.update({ where: { id: original.id }, data: { leaseExpiresAt: new Date(0) } });
    let token = call.leaseToken;
    if (condition === "lease-takeover") {
      await run(f, "POST", `/${call.id}/disconnect`, { token });
      token = (await run(f, "POST", `/${call.id}/resume`)).value.call.leaseToken;
      expect(token).not.toBe(call.leaseToken);
    }
    try {
      const before = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } });
      const recover = () => reclaimExpiredVoiceClip({ characterId: f.characterId, requestId: original.id, deps: { entitlementMap, readableCharacter } });
      if (condition === "lease-takeover") {
        await expect(recover()).rejects.toMatchObject({ status: 410 });
        expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toEqual(before);
        expect(synthesize).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(f.userId)).toBe(20);
        const explicit = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token });
        expect(explicit.response.status, JSON.stringify(explicit.value)).toBe(201);
      } else {
        expect(await recover()).toMatchObject({ status: "succeeded", requestId: original.id, attemptNo: 2 });
      }
      expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
        voiceCallUtteranceId: id, executionAuthority: { version: 1, kind: "call", callUtteranceId: id, replyAttempt: 1, leaseToken: token },
      });
      expect(synthesize).toHaveBeenCalledTimes(2); expect(await dreamcoinBalance(f.userId)).toBe(18);
      expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "delivered", costDreamcoins: 2 });
    } finally { await run(f, "POST", `/${call.id}/end`, { token }); }
  });
  it("recovers a later explicit ordinary attempt without inheriting a cancelled Call's historical binding", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    await run(f, "POST", `/${call.id}/disconnect`, { token: call.leaseToken });
    const body = { characterId: f.characterId, sessionId: f.sessionId, messageId: linked.assistantMessageId!, intent: "play" };
    synthesize.mockResolvedValueOnce({ ok: false, error: { code: "controlled_voice_retry", message: "Retry ordinary Play", retryable: true } });
    expect((await api("POST", "generation/voice", { userId: f.userId, body })).status).toBe(500);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId: f.userId } });
    const token = (await run(f, "POST", `/${call.id}/resume`)).value.call.leaseToken;
    synthesize.mockRejectedValueOnce(new Error("Controlled interrupted Call takeover"));
    expect((await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token })).response.status).toBe(500);
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      voiceCallUtteranceId: null, attemptNo: 2, executionAuthority: { version: 1, kind: "call", callUtteranceId: id, replyAttempt: 1, leaseToken: token },
    });
    await run(f, "POST", `/${call.id}/end`, { token });
    const cancelled = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    expect(cancelled).toMatchObject({ status: "cancelled", voiceRequestId: original.id, settledAt: null });
    await prisma.voiceClipRequest.update({ where: { id: original.id }, data: { leaseExpiresAt: new Date(0) } });
    await expect(reclaimExpiredVoiceClip({ characterId: f.characterId, requestId: original.id, deps: { entitlementMap, readableCharacter } }))
      .rejects.toMatchObject({ status: 410 });
    synthesize.mockRejectedValueOnce(new Error("Controlled interrupted explicit ordinary retry"));
    expect((await api("POST", "generation/voice", { userId: f.userId, autoGenerationQuote: false, body })).status).toBe(500);
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      voiceCallUtteranceId: null, attemptNo: 3, executionAuthority: { version: 1, kind: "standalone" },
    });
    await prisma.voiceClipRequest.update({ where: { id: original.id }, data: { leaseExpiresAt: new Date(0) } });
    expect(await reclaimExpiredVoiceClip({ characterId: f.characterId, requestId: original.id, deps: { entitlementMap, readableCharacter } }))
      .toMatchObject({ status: "succeeded", attemptNo: 4 });
    expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toEqual(cancelled);
    expect(synthesize).toHaveBeenCalledTimes(4); expect(await dreamcoinBalance(f.userId)).toBe(18);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(1);
  });
  it("fails closed for historical Call execution without a lease and permits a new explicit Call attempt", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    synthesize.mockRejectedValueOnce(new Error("Controlled legacy interrupted Call"));
    expect((await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken })).response.status).toBe(500);
    const original = await prisma.voiceClipRequest.findFirstOrThrow({ where: { voiceCallUtteranceId: id } });
    // Reconstruct a pre-migration row, without weakening the current-attempt
    // guard to erase an authorization from a live production request.
    await prisma.voiceClipRequest.delete({ where: { id: original.id } });
    await prisma.voiceClipRequest.create({ data: {
      ...original, executionAuthority: Prisma.DbNull, leaseExpiresAt: new Date(0),
      synthesisPayload: original.synthesisPayload ?? Prisma.DbNull, billingAuthority: original.billingAuthority ?? Prisma.DbNull,
      providerPayload: original.providerPayload ?? Prisma.JsonNull, error: original.error ?? Prisma.DbNull,
    } });
    const before = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } });
    await expect(reclaimExpiredVoiceClip({ characterId: f.characterId, requestId: original.id, deps: { entitlementMap, readableCharacter } }))
      .rejects.toMatchObject({ status: 409, details: { reason: "voice_execution_authority_missing" } });
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toEqual(before);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const explicit = await run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken });
    expect(explicit.response.status, JSON.stringify(explicit.value)).toBe(201);
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      voiceCallUtteranceId: id, attemptNo: 2,
      executionAuthority: { version: 1, kind: "call", callUtteranceId: id, replyAttempt: 1, leaseToken: call.leaseToken },
    });
    expect(synthesize).toHaveBeenCalledTimes(2); expect(await dreamcoinBalance(f.userId)).toBe(18);
    await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
  });
  it("rejects foreign user, viewer scope, lease and revoked age acceptance at the Call voice endpoint", async () => {
    const f = await fixture(), other = await fixture(), call = await start(f), id = await utterance(f, call);
    const path = `/${call.id}/utterances/${id}/voice`;
    expect((await run(f, "POST", path, { userId: "", token: call.leaseToken })).response.status).toBe(401);
    expect((await run(f, "POST", path, { userId: other.userId, token: call.leaseToken })).response.status).toBe(404);
    expect((await run(f, "POST", path, { scope: `user:${other.userId}`, token: call.leaseToken })).response.status).toBe(409);
    expect((await run(f, "POST", path, { token: randomUUID() })).response.status).toBe(410);
    expect((await run(f, "POST", path)).response.status).toBe(410);
    await prisma.ageGateAcceptance.deleteMany({ where: { userId: f.userId } });
    try {
      const ageRejected = await run(f, "POST", path, { token: call.leaseToken });
      expect(ageRejected.response.status).toBe(403);
      expect(JSON.stringify(ageRejected.value)).toContain("age_gate_required");
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
      expect(await dreamcoinBalance(f.userId)).toBe(20);
      expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "linked", voiceRequestId: null, mediaAssetId: null, settledAt: null });
    } finally {
      await prisma.ageGateAcceptance.create({ data: { userId: f.userId } });
      await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
    }
  });
  it("rejects a Call reply regenerated through the real route after its initial attempt check", async () => {
    const f = await fixture(), call = await start(f), id = await utterance(f, call);
    const linked = await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const originalAggregate = prisma.voiceCallUtterance.aggregate.bind(prisma.voiceCallUtterance);
    // The first aggregate is speakUtterance's budget read, after it accepted
    // attempt 1. Only its completion is delayed; all writes use real commands.
    const aggregate = vi.spyOn(prisma.voiceCallUtterance, "aggregate").mockImplementationOnce(args => {
      const query = originalAggregate(args);
      const then = query.then.bind(query);
      query.then = (onFulfilled, onRejected) => hold.then(() => then(onFulfilled, onRejected));
      entered(); return query;
    });
    const pending = run(f, "POST", `/${call.id}/utterances/${id}/voice`, { token: call.leaseToken });
    try {
      await ready;
      const regenerated = await api("POST", `chat/messages/${linked.assistantMessageId}/regenerate`, {
        userId: f.userId, body: {}, headers: { "x-idream-viewer-scope": `user:${f.userId}` },
      });
      expect(regenerated.status, JSON.stringify(regenerated.json)).toBe(202);
      expect(regenerated.json).toMatchObject({ attempt: 2, assistantMessageId: linked.assistantMessageId });
      const replacement = await completeReply(linked.turnId!, "This is the new reply, outside the original spoken turn.");
      expect(replacement.attempt).toBe(2);
      release();
      const rejected = await pending;
      expect(rejected.response.status, JSON.stringify(rejected.value)).toBe(409);
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.voiceUsageFact.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
      expect(await dreamcoinBalance(f.userId)).toBe(20);
      expect(await prisma.voiceCallUtterance.findUniqueOrThrow({ where: { id } })).toMatchObject({ replyAttempt: 1, status: "linked", voiceRequestId: null, mediaAssetId: null });
    } finally {
      release(); await pending; aggregate.mockRestore();
      await run(f, "POST", `/${call.id}/end`, { token: call.leaseToken });
    }
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
    expect(quote.response.status, JSON.stringify(quote.value)).toBe(200); expect(quote.value.voiceFallback).toBe(true);
    const connected = await run(f, "POST", "", { body: { ...body, quoteToken: quote.value.quoteToken } });
    expect(connected.response.status, JSON.stringify(connected.value)).toBe(200);
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
