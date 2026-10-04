import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { VoiceClipPort } from "@/server/providers/types";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { getVoiceDefaultSettings } from "@/server/modules/voice-defaults";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import * as voiceFactory from "@/server/providers/voice/factory";
import * as composition from "./video-composition";
import * as jobReads from "./generation-job-read-model";
import { PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE } from "@/server/modules/generation/production-video-profile";
import * as dispatchAuthority from "@/server/modules/generation/generation-attempt-authority";
import { videoSequenceDtoSchema } from "@idream/shared/contracts";
import { api, createCharacter, createMedia, createUser, dreamcoinBalance, expectError, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import { videoFixture, narrationFixture } from "@/server/test/video-fixtures";
import { advanceVideoSequences } from "./video-sequence";
import { reconcileUnknownGenerationRequest } from "@/server/modules/admin-v2/jobs/unknown-reconciliation";

const P = "zt-video-sequence-";
const profileId = `${P}profile`, sourceKeys: string[] = [];
let userId: string, characterId: string, nativeBytes: Uint8Array;
const prior = { provider: env.VOICE_PROVIDER, language: env.POCKET_TTS_LANGUAGE, voice: providers.voice };

async function purgeSequenceTestData(prefix: string) {
  const jobs = await prisma.generationJob.findMany({ where: { userId: { startsWith: prefix } }, select: { id: true } });
  await purgeTestData(prefix);
  // Attempts intentionally outlive User/Job deletion in production. Remove
  // this suite's unfinished fixtures so later publication guards see no work.
  await prisma.generationAttempt.deleteMany({ where: {
    requestId: { in: jobs.map(job => job.id) }, status: { in: ["queued", "running"] },
  } });
}

beforeAll(async () => {
  await purgeSequenceTestData(P);
  nativeBytes = await videoFixture({ width: 512, height: 512, frames: 73 });
  await prisma.generationModelProfile.create({ data: { id: profileId, ...PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE,
    runnerConfig: JSON.parse(JSON.stringify(PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE.runnerConfig)), allowedOrientations: ["2:3", "1:1"],
    label: "Local transport fixture: bounded video options", mode: "video", costMultiplier: 1, status: "active", enabled: true, publishedAt: new Date() } });
  await prisma.featureFlag.upsert({ where: { key: "video_gen" }, create: { key: "video_gen", label: "Video fixture", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] }, update: { enabled: true, rolloutPercent: 100 } });
  await prisma.featureFlag.upsert({ where: { key: "voice_gen" }, create: { key: "voice_gen", label: "Voice fixture", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] }, update: { enabled: true, rolloutPercent: 100 } });
  if (!await prisma.generationRecipe.findFirst({ where: { mode: "video", useCase: "character", status: "active" } })) await prisma.generationRecipe.create({ data: { id: `${P}recipe`, recipeKey: `${P}recipe`, label: "Video scene fixture", mode: "video", useCase: "character", body: "Animate the Character portrait.", negativeBase: "flicker", presetOrder: [], safetyHints: {}, sampleMatrix: [], dryRunSummary: {}, status: "active", publishedAt: new Date() } });
  if (!await prisma.pricingRule.findFirst({ where: { mode: "video", status: "active" } })) await prisma.pricingRule.create({ data: { id: `${P}price`, ruleKey: `${P}price`, label: "Video fixture price", mode: "video", baseCost: 100, status: "active" } });
});
beforeEach(async () => {
  await purgeSequenceTestData(`${P}user-`);
  ({ userId, characterId } = await createSequenceActor());
});
afterEach(() => { vi.restoreAllMocks(); env.VOICE_PROVIDER = prior.provider; env.POCKET_TTS_LANGUAGE = prior.language; providers.voice = prior.voice; });
afterAll(async () => {
  await purgeSequenceTestData(P);
  await prisma.generationModelProfile.deleteMany({ where: { id: profileId } });
  await prisma.generationRecipe.deleteMany({ where: { id: `${P}recipe` } });
  await prisma.pricingRule.deleteMany({ where: { id: `${P}price` } });
  for (const key of sourceKeys) await providers.blob.delete({ key });
});

function body(count = 2, audio = "generated") { return { characterId, orientation: "1:1", quality: "preview", audio, scenes: Array.from({ length: count }, (_, ordinal) => ({ prompt: `A controlled scene ${ordinal + 1}: slowly wave`, seconds: 3, ...(audio === "narration" ? { narration: "Hello from this scene." } : {}) })) }; }
function barrier() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function createSequenceActor() {
  const key = `${P}user-${randomUUID()}`;
  const actor = { userId: `${key}-owner`, characterId: `${key}-character`, sourceId: `${key}-source` };
  await createUser({ id: actor.userId }); await grantCoins(actor.userId, 1000);
  await prisma.entitlement.createMany({ data: ["video_generation", "premium_controls"].map(key => ({ userId: actor.userId, key, value: true, source: "test" })) });
  await createCharacter({ id: actor.characterId, creatorId: actor.userId, source: "user", visibility: "private" });
  const storageKey = `test-fixtures/${actor.sourceId}.png`; sourceKeys.push(storageKey);
  await providers.blob.putPrivate({ key: storageKey, body: await sharp({ create: { width: 512, height: 512, channels: 3, background: "#a86432" } }).png().toBuffer(), contentType: "image/png" });
  await createMedia({ id: actor.sourceId, ownerId: actor.userId, storageKey, contentType: "image/png" });
  await prisma.mediaAsset.update({ where: { id: actor.sourceId }, data: { characterId: actor.characterId, width: 512, height: 512 } });
  await prisma.character.update({ where: { id: actor.characterId }, data: { imageAssetId: actor.sourceId } });
  return actor;
}
async function quote(value = body(), actorId = userId) { const result = await api("POST", "generation/video-sequences/quote", { userId: actorId, ageGate: true, body: value }); expectOk(result); return result.data.quote; }
async function create(value = body(), key = randomUUID(), actorId = userId) {
  const price = await quote(value, actorId);
  const result = await api("POST", "generation/video-sequences", { userId: actorId, ageGate: true, headers: { "idempotency-key": key }, body: { ...value, quoteFingerprint: price.fingerprint } });
  expectOk(result, 202); return { sequence: videoSequenceDtoSchema.parse(result.data.sequence), price, key, request: { ...value, quoteFingerprint: price.fingerprint } };
}
async function mockedNativeSuccess() {
  const gen = await generationTestProviders();
  return vi.spyOn(gen.video, "generate").mockResolvedValue({ ok: true, data: { asset: { key: "real-local-fixture.mp4", body: nativeBytes, contentType: "video/mp4", width: 512, height: 512, seconds: 73 / 24 } } });
}
async function read(id: string) { const result = await api("GET", `generation/video-sequences/${id}`, { userId, ageGate: true }); expectOk(result); return videoSequenceDtoSchema.parse(result.data.sequence); }
async function finish(id: string, count = 2) {
  for (let index = 0; index < count; index++) { await runQueuedGenerationJobs(10); await advanceVideoSequences(); }
  return read(id);
}

describe("ordered video Requests, ledger settlement and packaging", () => {
  it("quotes actual bounded dimensions, atomically admits two paid children and replays one receipt", async () => {
    const { sequence, request, key } = await create();
    const jobs = sequence.scenes.map(scene => scene.job.id);
    expect(sequence.cost).toEqual({ charged: 200, refunded: 0, finalCharge: 200 }); expect(await dreamcoinBalance(userId)).toBe(800);
    expect(await prisma.generationAttempt.count({ where: { requestId: { in: jobs } } })).toBe(2);
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: `generation_initial_${jobs[0]}` } })).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: `generation_initial_${jobs[1]}` } })).toMatchObject({ status: "pending", attempts: 0 });
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobs[0] } })).controls).toMatchObject({ width: 512, height: 512, seconds: 3, generationProfileVersion: PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE.version, videoOptionsVersion: "redgraft-video-options-v1" });
    const replies = await Promise.all(Array.from({ length: 3 }, () => api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: request })));
    for (const reply of replies) { expectOk(reply, 202); expect(reply.data.sequence.id).toBe(sequence.id); }
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(2); expect(await dreamcoinBalance(userId)).toBe(800);
    const changed = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: { ...request, audio: "silent" } }); expectError(changed, 409);
  });

  it("rejects a stale quote, ownership theft and insufficient total balance without partial admission", async () => {
    const price = await quote();
    const stale = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": randomUUID() }, body: { ...body(), quoteFingerprint: "0".repeat(64) } }); expectError(stale, 409);
    const stranger = `${P}user-${randomUUID()}-stranger`; await createUser({ id: stranger }); await grantCoins(stranger, 1000); await prisma.entitlement.createMany({ data: ["video_generation", "premium_controls"].map(key => ({ userId: stranger, key, value: true, source: "test" })) });
    const stolen = await api("POST", "generation/video-sequences/quote", { userId: stranger, ageGate: true, body: body() }); expectError(stolen, 404);
    await grantCoins(userId, -850);
    const insufficient = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": randomUUID() }, body: { ...body(), quoteFingerprint: price.fingerprint } }); expectError(insufficient, 402);
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(0); expect(await prisma.generationJob.count({ where: { userId } })).toBe(0); expect(await dreamcoinBalance(userId)).toBe(150);
  });

  it("delivers both native scenes in order and publishes one composed artifact under concurrent finalizers", async () => {
    const native = await mockedNativeSuccess(), { sequence } = await create();
    await runQueuedGenerationJobs(10); expect(native).toHaveBeenCalledTimes(1);
    const partial = await read(sequence.id); expect(partial.scenes[0]?.assets).toHaveLength(1); expect(partial.scenes[1]?.job.status).toBe("queued");
    const gallery = async () => { const page = await api("GET", "media", { userId, ageGate: true, query: { type: "video" } }); expectOk(page); return page.data.items as Array<{ id: string; provenance: { label: string } | null }>; };
    // Until the composite exists, a paid scene clip is the user's only deliverable.
    expect((await gallery()).map(item => [item.id, item.provenance?.label])).toEqual([[partial.scenes[0]!.assets[0]!.id, "Video scene 1"]]);
    await advanceVideoSequences(); await runQueuedGenerationJobs(10); expect(native).toHaveBeenCalledTimes(2);
    await Promise.all([advanceVideoSequences(), advanceVideoSequences()]);
    const result = await read(sequence.id); expect(result.status).toBe("completed"); expect(result.asset).toMatchObject({ width: 512, height: 512, metadata: { audio: "generated", narrationIsLipSync: false } });
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_sequence" } } })).toBe(1);
    // Once delivered, the gallery shows the finished video alone; scenes stay downloadable from the sequence.
    expect((await gallery()).map(item => item.id)).toEqual([result.asset!.id]);
    expect(await dreamcoinBalance(userId)).toBe(800);
    const content = await api("GET", `media/${result.asset!.id}/content`, { userId, ageGate: true }); expectOk(content); expect(content.bytes!.byteLength).toBeGreaterThan(100);
    const stranger = `${P}user-${randomUUID()}-reader`; await createUser({ id: stranger });
    expectError(await api("GET", `media/${result.asset!.id}/content`, { userId: stranger, ageGate: true }), 404);
    // A rendered download link must return the actual file, not a JSON URL envelope.
    for (const asset of [result.asset!, ...result.scenes.flatMap(scene => scene.assets)]) {
      const url = new URL(asset.downloadUrl, "http://localhost");
      const path = url.pathname.replace(/^\/api\/v1\//, "");
      const query = Object.fromEntries(url.searchParams);
      const download = await api("GET", path, { userId, ageGate: true, query });
      expectOk(download);
      expect(download.headers.get("content-type")).toBe("video/mp4");
      expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(download.bytes!.byteLength).toBeGreaterThan(100);
      const inline = await api("GET", asset.url.replace(/^\/api\/v1\//, ""), { userId, ageGate: true });
      expect(download.bytes).toEqual(inline.bytes);
      expectError(await api("GET", path, { userId: stranger, ageGate: true, query }), 404);
    }
    await advanceVideoSequences(); expect(native).toHaveBeenCalledTimes(2);
  });

  it("stops after the first provider failure and refunds all unexecuted scenes exactly once", async () => {
    const gen = await generationTestProviders(), native = vi.spyOn(gen.video, "generate").mockResolvedValue({ ok: false, error: { code: "controlled_failure", message: "Controlled nonretryable fixture failure", retryable: false } });
    const { sequence } = await create(body(3)); await runQueuedGenerationJobs(10); await advanceVideoSequences(); await advanceVideoSequences();
    const result = await read(sequence.id); expect(result.status).toBe("failed"); expect(native).toHaveBeenCalledTimes(1);
    expect(result.scenes.map(scene => scene.job.status)).toEqual(["failed", "cancelled", "cancelled"]);
    expect(result.cost).toEqual({ charged: 300, refunded: 300, finalCharge: 0 }); expect(await dreamcoinBalance(userId)).toBe(1000);
    expect(await prisma.generationSettlementLink.count({ where: { requestId: { in: result.scenes.map(scene => scene.job.id) }, kind: "refund" } })).toBe(3);
  });

  it("an uncertain first provider outcome cannot dispatch later paid scenes", async () => {
    const { sequence } = await create(body(3));
    const attempt = await prisma.generationAttempt.findFirstOrThrow({
      where: { requestId: sequence.scenes[0]!.job.id }, orderBy: { attemptNo: "desc" },
    });
    // Unknown is a terminal transport fact; use its authority seam so this
    // fixture also satisfies the production event/sequence/time constraints.
    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:controlled-unknown`, attemptId: attempt.id,
      eventType: "generation.attempt.unknown.v1", outcome: "unknown",
      occurredAt: new Date(), payload: { reason: "Controlled uncertain provider outcome" },
    }));
    const native = await mockedNativeSuccess(); await advanceVideoSequences(); await advanceVideoSequences();
    const result = await read(sequence.id); expect(result.status).toBe("unknown"); expect(result.cost).toEqual({ charged: 300, refunded: 200, finalCharge: 100 });
    expect(result.scenes.slice(1).map(scene => scene.job.status)).toEqual(["cancelled", "cancelled"]); expect(native).not.toHaveBeenCalled();
    // Settling the Request (the stale-unknown sweeper's confirm_failed) gives the
    // sequence a definite outcome; the immutable unknown attempt must not pin it.
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: sequence.scenes[0]!.job.id } });
    await reconcileUnknownGenerationRequest({ requestId: job.id, actor: { id: `${userId}-operator`, role: "admin" },
      command: { resolution: "confirm_failed", entityVersion: job.version, reason: "Controlled settlement", providerEvidenceRefs: [`attempt:${attempt.id}`], confirmation: `${job.id}:confirm_failed` },
      idempotencyKey: `settle-${job.id}`, traceId: `settle-${job.id}` });
    await advanceVideoSequences();
    const settled = await read(sequence.id); expect(settled.status).toBe("failed"); expect(settled.cost).toEqual({ charged: 300, refunded: 300, finalCharge: 0 });
    expect(await dreamcoinBalance(userId)).toBe(1000);
  });

  it("delivers a ready sequence behind ten older unknown sequences without repeating generation or charges", async () => {
    const native = await mockedNativeSuccess(), { sequence } = await create(body(1, "silent"));
    await runQueuedGenerationJobs(10);
    expect((await read(sequence.id)).scenes[0]!.job.status).toBe("completed");
    const older = new Date(Date.now() - 60_000), blockedIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const actor = await createSequenceActor();
      const { sequence: blocked } = await create({ ...body(1), characterId: actor.characterId }, randomUUID(), actor.userId);
      const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: blocked.scenes[0]!.job.id }, orderBy: { attemptNo: "desc" } });
      await prisma.$transaction(tx => recordGenerationAttemptEvent(tx, {
        eventId: `${attempt.id}:controlled-unknown`, attemptId: attempt.id,
        eventType: "generation.attempt.unknown.v1", outcome: "unknown", occurredAt: new Date(),
        payload: { reason: "Controlled unresolved outcome ahead of another user's ready sequence" },
      }));
      await prisma.videoSequence.update({ where: { id: blocked.id }, data: { status: "unknown", createdAt: older, errorCode: "provider_outcome_unknown" } });
      blockedIds.push(blocked.id);
    }
    // The finalizer carries progress across bounded sweeps, even when none of
    // the first page's provider outcomes can be resolved automatically.
    const unreadable = new Error("Controlled unavailable attempt evidence");
    vi.spyOn(jobReads, "latestGenerationAttemptStatuses").mockRejectedValueOnce(unreadable);
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const first = await advanceVideoSequences();
    expect((await read(sequence.id)).status).toBe("generating");
    expect(errorLog).toHaveBeenCalledWith({ error: unreadable, sequenceId: expect.any(String) }, "video sequence recovery deferred");
    expect(await prisma.videoSequence.count({ where: { id: { in: blockedIds }, status: "unknown" } })).toBe(10);
    // A user may delete the sequence that supplied the keyset boundary while
    // the worker is idle; the next page must not depend on that row existing.
    expect(first.nextCursor).not.toBeNull();
    await prisma.videoSequence.delete({ where: { id: first.nextCursor!.id } });
    await advanceVideoSequences(10, first?.nextCursor ?? null);
    const delivered = await read(sequence.id);
    expect(delivered.status).toBe("completed");
    expectOk(await api("GET", `media/${delivered.asset!.id}/content`, { userId, ageGate: true }));
    expect(await prisma.videoSequence.count({ where: { id: { in: blockedIds }, status: "unknown" } })).toBe(9);
    expect(native).toHaveBeenCalledTimes(1);
    expect(await dreamcoinBalance(userId)).toBe(900);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
  });

  it("dispatches a new first scene behind twenty-six deferred scenes without dispatching them early", async () => {
    const native = await mockedNativeSuccess(), deferredIds: string[] = [];
    for (let index = 0; index < 13; index++) {
      const actor = await createSequenceActor();
      const { sequence } = await create({ ...body(3), characterId: actor.characterId }, randomUUID(), actor.userId);
      // Pin the first scene as dispatched so the older backlog consists only
      // of legitimate later scenes waiting for their own predecessor.
      await dispatchAuthority.dispatchGenerationAttemptOutbox(prisma, { outboxIds: [`generation_initial_${sequence.scenes[0]!.job.id}`] });
      deferredIds.push(...sequence.scenes.slice(1).map(scene => `generation_initial_${scene.job.id}`));
    }
    expect(await prisma.mainOutboxEvent.count({ where: { id: { in: deferredIds }, status: "pending", attempts: 0 } })).toBe(26);
    const { sequence } = await create(body(1));
    const firstId = `generation_initial_${sequence.scenes[0]!.job.id}`;
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({ status: "delivered", attempts: 1 });
    await dispatchAuthority.dispatchGenerationAttemptOutbox(prisma);
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({ status: "delivered", attempts: 1 });
    const recovering = await createSequenceActor();
    const dispatch = dispatchAuthority.dispatchGenerationAttemptOutbox;
    const held = vi.spyOn(dispatchAuthority, "dispatchGenerationAttemptOutbox").mockImplementation(db => dispatch(db, { outboxIds: [] }));
    let recoveryId: string;
    try {
      const { sequence: pending } = await create({ ...body(1), characterId: recovering.characterId }, randomUUID(), recovering.userId);
      recoveryId = `generation_initial_${pending.scenes[0]!.job.id}`;
    } finally { held.mockRestore(); }
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: recoveryId } })).toMatchObject({ status: "pending", attempts: 0 });
    await dispatch(prisma);
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: recoveryId } })).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await prisma.mainOutboxEvent.count({ where: { id: { in: deferredIds }, status: "pending", attempts: 0 } })).toBe(26);
    expect(await dreamcoinBalance(userId)).toBe(900);
    expect(await dreamcoinBalance(recovering.userId)).toBe(900);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(native).not.toHaveBeenCalled();
  });

  it("packaging failure is recoverable without creating another Request, debit or native invocation", async () => {
    const native = await mockedNativeSuccess(), { sequence } = await create(body(1, "silent"));
    const packageOnce = vi.spyOn(composition, "composeVideoScenes").mockRejectedValueOnce(new Error("Controlled packaging failure"));
    await finish(sequence.id, 1); expect((await read(sequence.id)).status).toBe("composition_failed");
    const retry = await api("POST", `generation/video-sequences/${sequence.id}/retry-composition`, { userId, ageGate: true }); expectOk(retry);
    await Promise.all([advanceVideoSequences(), advanceVideoSequences()]);
    const result = await read(sequence.id); expect(result.status).toBe("completed"); expect(result.asset?.metadata.audio).toBe("silent"); expect(native).toHaveBeenCalledTimes(1); expect(packageOnce).toHaveBeenCalledTimes(2);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1); expect(await dreamcoinBalance(userId)).toBe(900);
  });

  it("pins narration, persists its actual artifact and extends playback without a fake Chat or VoiceUsage row", async () => {
    env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english"; providers.voice = createVoicePortsForKey("pocket_tts");
    const defaults = await getVoiceDefaultSettings();
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false, catalogVoices: [defaults.defaultVoiceId] } });
    const speech = await narrationFixture(4.2), tts = vi.fn().mockResolvedValue({ ok: true, data: { body: speech, contentType: "audio/wav", durationMs: 4200 } });
    vi.spyOn(voiceFactory, "createVoiceClipPortForKey").mockReturnValue({ providerKey: "pocket_tts", synthesize: tts });
    const native = await mockedNativeSuccess(), { sequence, price } = await create(body(1, "narration"));
    expect(price).toMatchObject({ narrationExtendsLastFrame: true, narrationExtraCostDreamcoins: 0, voicePin: { provider: "pocket_tts", voiceId: defaults.defaultVoiceId, language: "en" } });
    const result = await finish(sequence.id, 1); expect(result.status).toBe("completed"); expect(result.asset?.metadata.durationSeconds).toBeGreaterThanOrEqual(4.2);
    expect(tts).toHaveBeenCalledTimes(1); expect(tts).toHaveBeenCalledWith(expect.objectContaining({ requestId: `video-narration:${sequence.id}:0`, idempotencyKey: `video-narration:${sequence.id}:0`, voiceId: defaults.defaultVoiceId }));
    expect(await prisma.videoSequenceScene.findFirstOrThrow({ where: { sequenceId: sequence.id } })).toMatchObject({ narrationState: "completed", narrationMediaAssetId: expect.any(String) });
    expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(0); expect(await prisma.chatTurn.count({ where: { session: { userId } } })).toBe(0); expect(await dreamcoinBalance(userId)).toBe(900); expect(native).toHaveBeenCalledTimes(1);
    // The library lists the narrated video, not its scene clip or speech track.
    const library = await api("GET", "media", { userId, ageGate: true }); expectOk(library);
    expect((library.data.items as Array<{ id: string }>).map(item => item.id).filter(id => id !== userId.replace(/-owner$/, "-source"))).toEqual([result.asset!.id]);
  });

  it("delivers three complete narration assets and retries only missing speech or packaging without another debit", async () => {
    env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english"; providers.voice = createVoicePortsForKey("pocket_tts");
    const defaults = await getVoiceDefaultSettings();
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false, catalogVoices: [defaults.defaultVoiceId] } });
    const lines = ["The first scene begins here.", "The second scene is a short pause.", "The third scene closes our story."];
    const durations = [4.2, 0.4, 3.6];
    const speeches = await Promise.all(durations.map((seconds, ordinal) => narrationFixture(seconds, 550 + ordinal * 330)));
    let thirdFailed = false;
    const tts = vi.fn(async (request: Parameters<VoiceClipPort["synthesize"]>[0]) => {
      const ordinal = lines.indexOf(request.text);
      expect(ordinal).toBeGreaterThanOrEqual(0);
      expect(request.voiceId).toBe(defaults.defaultVoiceId);
      if (ordinal === 2 && !thirdFailed) {
        thirdFailed = true;
        return { ok: false as const, error: { code: "controlled_voice_failure", message: "Controlled third narration failure", retryable: true } };
      }
      return { ok: true as const, data: { body: speeches[ordinal]!, contentType: "audio/wav", durationMs: durations[ordinal]! * 1000 } };
    });
    vi.spyOn(voiceFactory, "createVoiceClipPortForKey").mockReturnValue({ providerKey: "pocket_tts", synthesize: tts });
    const native = await mockedNativeSuccess();
    const request = { ...body(3, "narration"), scenes: body(3, "narration").scenes.map((scene, ordinal) => ({ ...scene, narration: lines[ordinal]! })) };
    const { sequence, key } = await create(request);
    const first = await finish(sequence.id, 3);
    expect(first.status).toBe("composition_failed");
    const afterSpeechFailure = await prisma.videoSequenceScene.findMany({ where: { sequenceId: sequence.id }, orderBy: { ordinal: "asc" } });
    expect(afterSpeechFailure.map(scene => scene.narrationState)).toEqual(["completed", "completed", "failed"]);
    expect(afterSpeechFailure.map(scene => Boolean(scene.narrationMediaAssetId))).toEqual([true, true, false]);
    expect(tts).toHaveBeenCalledTimes(3);
    const packageOnce = vi.spyOn(composition, "composeVideoScenes").mockRejectedValueOnce(new Error("Controlled packaging failure after all speech persisted"));
    expectOk(await api("POST", `generation/video-sequences/${sequence.id}/retry-composition`, { userId, ageGate: true }));
    await advanceVideoSequences();
    expect((await read(sequence.id)).status).toBe("composition_failed");
    expect(tts).toHaveBeenCalledTimes(4);
    expectOk(await api("POST", `generation/video-sequences/${sequence.id}/retry-composition`, { userId, ageGate: true }));
    await Promise.all([advanceVideoSequences(), advanceVideoSequences()]);
    const result = await read(sequence.id);
    expect(result.status).toBe("completed");
    expect(result.scenes.map(scene => scene.narrationState)).toEqual(["completed", "completed", "completed"]);
    expect(result.cost).toEqual({ charged: 300, refunded: 0, finalCharge: 300 });
    expect(result.asset?.metadata.sceneDurations).toEqual([101 / 24, 73 / 24, 87 / 24]);
    expect(result.asset?.metadata.sceneGenerationJobIds).toEqual(result.scenes.map(scene => scene.job.id));
    expect(tts.mock.calls.map(([request]) => request.text)).toEqual([...lines, lines[2]]);
    expect(native).toHaveBeenCalledTimes(3);
    expect(packageOnce).toHaveBeenCalledTimes(2);
    const saved = await prisma.videoSequenceScene.findMany({ where: { sequenceId: sequence.id }, include: { narrationMediaAsset: true }, orderBy: { ordinal: "asc" } });
    for (const [ordinal, scene] of saved.entries()) {
      const clip = await api("GET", `media/${scene.narrationMediaAssetId}/content`, { userId, ageGate: true });
      expectOk(clip); expect(clip.bytes).toEqual(speeches[ordinal]);
      expect(scene.narrationMediaAsset?.metadata).toMatchObject({ sequenceId: sequence.id, ordinal, voicePin: { voiceId: defaults.defaultVoiceId } });
    }
    for (const asset of [result.asset!, ...result.scenes.flatMap(scene => scene.assets)]) {
      const download = await api("GET", asset.downloadUrl.replace(/^\/api\/v1\//, "").split("?")[0]!, { userId, ageGate: true, query: { download: "1" } });
      expectOk(download); expect(download.bytes!.length).toBeGreaterThan(100);
      expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    }
    const replay = await create(request, key);
    expect(replay.sequence.id).toBe(sequence.id);
    await advanceVideoSequences();
    expect(tts).toHaveBeenCalledTimes(4); expect(native).toHaveBeenCalledTimes(3);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(3);
    expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(0);
    expect(await prisma.chatTurn.count({ where: { session: { userId } } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(700);
  });

  it("fences a late composer after the owner stops the sequence", async () => {
    await mockedNativeSuccess(); const { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    let release!: () => void, reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; }); const delayed = new Promise<void>(resolve => { release = resolve; });
    const actual = composition.composeVideoScenes;
    vi.spyOn(composition, "composeVideoScenes").mockImplementation(async input => { reached(); await delayed; return actual(input); });
    const advancing = advanceVideoSequences(); await started;
    const stopped = await api("POST", `generation/video-sequences/${sequence.id}/stop`, { userId, ageGate: true }); expectOk(stopped); release(); await advancing;
    const result = await read(sequence.id); expect(result.status).toBe("cancelled"); expect(result.asset).toBeNull(); expect(result.scenes[0]?.assets).toHaveLength(1); expect(result.cost.finalCharge).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_sequence" } } })).toBe(0);
  });

  it("keeps delivered video readable when an expired composer cleans up after the new lease delivers identical bytes", async () => {
    const native = await mockedNativeSuccess(), { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    const output = await composition.composeVideoScenes({ scenes: [{ video: nativeBytes }], audio: "generated" });
    const oldStarted = barrier(), newStarted = barrier(), releaseOld = barrier(), releaseNew = barrier(), deleting = barrier(), releaseDelete = barrier();
    vi.spyOn(composition, "composeVideoScenes")
      .mockImplementationOnce(async () => { oldStarted.release(); await releaseOld.promise; return output; })
      .mockImplementationOnce(async () => { newStarted.release(); await releaseNew.promise; return output; });
    const remove = providers.blob.delete.bind(providers.blob); const discardedKeys: string[] = [];
    vi.spyOn(providers.blob, "delete").mockImplementation(async input => {
      if (input.key.startsWith(`video-sequences/${userId}/${sequence.id}/`) && input.key.endsWith(".mp4")) {
        discardedKeys.push(input.key); deleting.release(); await releaseDelete.promise;
      }
      return remove(input);
    });
    const oldAdvance = advanceVideoSequences(); let newAdvance: ReturnType<typeof advanceVideoSequences> | undefined;
    try {
      await oldStarted.promise;
      await prisma.videoSequence.update({ where: { id: sequence.id }, data: { compositionLeaseAt: new Date(Date.now() - 1000) } });
      newAdvance = advanceVideoSequences(); await newStarted.promise;
      releaseOld.release(); await deleting.promise;
      releaseNew.release(); await newAdvance;
      const delivered = await read(sequence.id); expect(delivered.status).toBe("completed");
      releaseDelete.release(); await oldAdvance;
      const content = await api("GET", `media/${delivered.asset!.id}/content`, { userId, ageGate: true });
      expectOk(content); expect(content.bytes).toEqual(output.bytes);
      const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: delivered.asset!.id } });
      expect(discardedKeys).toHaveLength(1); expect(discardedKeys).not.toContain(stored.storageKey);
      expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_sequence" } } })).toBe(1);
      expect(native).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(userId)).toBe(900);
      expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    } finally {
      releaseOld.release(); releaseNew.release(); releaseDelete.release();
      await Promise.allSettled([oldAdvance, ...(newAdvance ? [newAdvance] : [])]);
    }
  });

  it("retains the winning narration and removes an unpublished late voice after its composition lease expires", async () => {
    env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english"; providers.voice = createVoicePortsForKey("pocket_tts");
    const defaults = await getVoiceDefaultSettings();
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false, catalogVoices: [defaults.defaultVoiceId] } });
    const lateSpeech = await narrationFixture(3.8), winningSpeech = await narrationFixture(4.2), oldStarted = barrier(), releaseOld = barrier();
    const tts = vi.fn()
      .mockImplementationOnce(async () => { oldStarted.release(); await releaseOld.promise; return { ok: true, data: { body: lateSpeech, contentType: "audio/wav", durationMs: 3800 } }; })
      .mockResolvedValue({ ok: true, data: { body: winningSpeech, contentType: "audio/wav", durationMs: 4200 } });
    vi.spyOn(voiceFactory, "createVoiceClipPortForKey").mockReturnValue({ providerKey: "pocket_tts", synthesize: tts });
    const native = await mockedNativeSuccess(), { sequence } = await create(body(1, "narration")); await runQueuedGenerationJobs(10);
    const store = providers.blob.putPrivate.bind(providers.blob), voiceKeys: string[] = [];
    vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      if (input.key.startsWith(`video-sequences/${userId}/${sequence.id}/`) && input.key.endsWith(".wav")) voiceKeys.push(input.key);
      return store(input);
    });
    const oldAdvance = advanceVideoSequences();
    try {
      await oldStarted.promise;
      await prisma.videoSequence.update({ where: { id: sequence.id }, data: { compositionLeaseAt: new Date(Date.now() - 1000) } });
      await advanceVideoSequences();
      const delivered = await read(sequence.id); expect(delivered.status).toBe("completed");
      releaseOld.release(); await oldAdvance;
      expect(await read(sequence.id)).toMatchObject({ status: "completed", asset: { id: delivered.asset!.id } });
      const scene = await prisma.videoSequenceScene.findFirstOrThrow({ where: { sequenceId: sequence.id }, include: { narrationMediaAsset: true } });
      expect(scene.narrationState).toBe("completed"); expect(voiceKeys).toHaveLength(2);
      expect(scene.narrationMediaAsset!.storageKey).toBe(voiceKeys[0]);
      const voice = await api("GET", `media/${scene.narrationMediaAsset!.id}/content`, { userId, ageGate: true }); expectOk(voice); expect(voice.bytes).toEqual(winningSpeech);
      expect((await providers.blob.getPrivate!({ key: voiceKeys[1]! })).ok).toBe(false);
      expectOk(await api("GET", `media/${delivered.asset!.id}/content`, { userId, ageGate: true }));
      expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_narration" } } })).toBe(1);
      expect(native).toHaveBeenCalledTimes(1); expect(await dreamcoinBalance(userId)).toBe(900);
      expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(0); expect(await prisma.chatTurn.count({ where: { session: { userId } } })).toBe(0);
      for (const [input] of tts.mock.calls) expect(input).toMatchObject({ requestId: `video-narration:${sequence.id}:0`, idempotencyKey: `video-narration:${sequence.id}:0`, voiceId: defaults.defaultVoiceId });
    } finally { releaseOld.release(); await oldAdvance; }
  });

  it("keeps acceptance and native identity immutable and enforces the same-owner Scene FK", async () => {
    const { sequence } = await create(body(1));
    await expect(prisma.videoSequence.update({ where: { id: sequence.id }, data: { requestFingerprint: "altered" } })).rejects.toThrow("immutable");
    await expect(prisma.videoSequenceScene.updateMany({ where: { sequenceId: sequence.id }, data: { ordinal: 1 } })).rejects.toThrow("immutable");
    const stranger = `${P}user-${randomUUID()}-binding`; await createUser({ id: stranger });
    const job = await prisma.generationJob.create({ data: { userId: stranger, mode: "video", sourceType: "video_sequence_scene", sourceId: `${sequence.id}:1`, prompt: "Wrong owner", controls: {}, presetIds: [], orientation: "1:1" } });
    await expect(prisma.videoSequenceScene.create({ data: { sequenceId: sequence.id, generationJobId: job.id, ordinal: 1 } })).rejects.toThrow("does not belong");
    const otherRead = await api("GET", `generation/video-sequences/${sequence.id}`, { userId: stranger, ageGate: true }); expectError(otherRead, 404);
  });
});
