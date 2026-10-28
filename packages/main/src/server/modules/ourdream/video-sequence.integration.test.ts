import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { VoiceClipPort } from "@/server/providers/types";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA } from "@/server/lib/media-asset-authority";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { getVoiceDefaultSettings } from "@/server/modules/voice-defaults";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import * as voiceFactory from "@/server/providers/voice/factory";
import * as composition from "./video-composition";
import * as remoteImage from "@/server/lib/safe-remote-image";
import * as jobReads from "./generation-job-read-model";
import { PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE } from "@/server/modules/generation/production-video-profile";
import * as dispatchAuthority from "@/server/modules/generation/generation-attempt-authority";
import { CHAT_TO_MAIN_EVENTS, REDGRAFT_VIDEO_OPTIONS, videoSequenceDtoSchema, idempotencyKeys } from "@idream/shared/contracts";
import { jobQueue } from "@/server/jobs/queue";
import { dispatchPendingGenerationTerminalRecords, ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { quoteAuthorityFor } from "./generation-quote";
import { quoteGenerationRetry, resolveGenerationRetryTarget, retryGenerationJobForUser } from "./generation-job-retry";
import { ACCOUNT_DELETION_GRACE_PERIOD_MS, accountDeletionSubjectHash, dispatchPendingAccountDeletionBlobDeletes, requestAccountDeletion } from "@/server/account-deletion-authority";
import { ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, applyChatEvent } from "@/processes/event-consumer";
import { api, createCharacter, createMedia, createUser, dreamcoinBalance, expectError, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import { videoFixture, narrationFixture } from "@/server/test/video-fixtures";
import { advanceVideoSequences } from "./video-sequence";
import { reconcileUnknownGenerationRequest } from "@/server/modules/admin-v2/jobs/unknown-reconciliation";
import { GET as getSourceSnapshot } from "@/app/api/internal/generation/source-snapshot/route";

const P = "zt-video-sequence-";
const profileId = `${P}profile`, sourceKeys: string[] = [], erasureUserIds: string[] = [];
let userId: string, characterId: string, nativeBytes: Uint8Array;
const prior = { provider: env.VOICE_PROVIDER, language: env.POCKET_TTS_LANGUAGE, voice: providers.voice };

async function purgeSequenceTestData(prefix: string) {
  await prisma.accountDeletion.deleteMany({ where: { subjectHash: { in: erasureUserIds.map(accountDeletionSubjectHash) } } });
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
    runnerConfig: JSON.parse(JSON.stringify(PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE.runnerConfig)), allowedOrientations: [...REDGRAFT_VIDEO_OPTIONS.orientations],
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
async function quote(value: unknown = body(), actorId = userId) { const result = await api("POST", "generation/video-sequences/quote", { userId: actorId, ageGate: true, body: value }); expectOk(result); return result.data.quote; }
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

async function requestSequenceAccountDeletion() {
  erasureUserIds.push(userId);
  return prisma.$transaction(tx => requestAccountDeletion(tx, { userId, now: new Date(Date.now() - ACCOUNT_DELETION_GRACE_PERIOD_MS - 10_000) }));
}
async function acknowledgeSequenceAccountDeletion() {
  await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${userId}` }, data: { status: "delivered", deliveredAt: new Date() } });
  await applyChatEvent({ eventId: `${P}erasure-${randomUUID()}`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2, schemaVersion: 2,
    sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: userId,
    payload: { version: 2, binding: "request_bound", userId, fileMutationId: randomUUID(), deletionRequestEventId: `user_deleted_${userId}` } });
}

describe("ordered video Requests, ledger settlement and packaging", () => {
  it("limits concurrent Blob quote verification and releases slots after failure", async () => {
    const entered = barrier(), release = barrier();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let reads = 0;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      reads++;
      if (reads === 2) entered.release();
      await release.promise;
      return get(input);
    });
    const makeQuote = () => api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: body(1) });
    const first = makeQuote(), second = makeQuote();
    try {
      await entered.promise;
      expectError(await makeQuote(), 503, "unavailable");
    } finally { release.release(); }
    expectOk(await first); expectOk(await second);
    expectOk(await makeQuote());
  });
  it("freezes accepted source pixels for every scene even if the original Blob changes", async () => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    const original = await providers.blob.getPrivate!({ key: source.storageKey! });
    if (!original.ok) throw new Error("Fixture source missing");
    const native = await mockedNativeSuccess();
    const { sequence } = await create(body(2));
    const jobs = await prisma.generationJob.findMany({ where: { sourceId: { startsWith: `${sequence.id}:` } }, orderBy: { sourceId: "asc" } });
    expect(jobs).toHaveLength(2);
    const pins = jobs.map(job => (job.controls as { sourceSnapshot: { snapshotId: string } }).sourceSnapshot.snapshotId);
    expect(pins[0]).toBeTruthy(); expect(pins[0]).toBe(pins[1]);
    await providers.blob.putPrivate({ key: source.storageKey!, body: await sharp({ create: { width: 512, height: 512, channels: 3, background: "#123456" } }).png().toBuffer(), contentType: "image/png" });
    const result = await finish(sequence.id, 2);
    expect(result.status).toBe("completed");
    expect(native).toHaveBeenCalledTimes(2);
    for (const [input] of native.mock.calls) {
      expect(Buffer.from(input.referenceImages![0]!.b64Json!, "base64")).toEqual(Buffer.from(original.data.body));
      expect(input.referenceImages![0]!.url).toBeUndefined();
    }
    expect(await prisma.generationSourceSnapshot.count({ where: { userId } })).toBe(1);
  });

  it("freezes external URL bytes at admission even when the URL changes after quote and submission", async () => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    await prisma.mediaAsset.update({ where: { id: source.id }, data: { storageKey: null, url: "https://example.test/source.png" } });
    const makeImage = (color: string) => sharp({ create: { width: 512, height: 512, channels: 3, background: color } }).png().toBuffer();
    let current = await makeImage("#112233");
    vi.spyOn(remoteImage, "readRemoteImage").mockImplementation(async () => ({ bytes: current, contentType: "image/png" }));
    const native = await mockedNativeSuccess();
    const request = body(1), price = await quote(request);
    current = await makeImage("#445566");
    const acceptedBytes = current;
    const response = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": randomUUID() }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectOk(response, 202);
    current = await makeImage("#778899");
    const result = await finish(response.data.sequence.id, 1);
    expect(result.status).toBe("completed");
    expect(Buffer.from(native.mock.calls[0]![0].referenceImages![0]!.b64Json!, "base64")).toEqual(acceptedBytes);
  });

  it("restricts frozen bytes to the current active attempt and fails closed on corruption", async () => {
    const native = await mockedNativeSuccess();
    const { sequence } = await create(body(1));
    const jobId = sequence.scenes[0]!.job.id;
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    const snapshotId = (job.controls as { sourceSnapshot: { snapshotId: string } }).sourceSnapshot.snapshotId;
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } });
    const request = (id: string, token = env.INTERNAL_TOKEN) => new Request(`http://localhost/api/internal/generation/source-snapshot?snapshotId=${snapshotId}&jobId=${jobId}&attemptId=${id}`, { headers: { "x-internal-token": token } });
    expect((await getSourceSnapshot(request(attempt.id, "wrong"))).status).toBe(401);
    expect((await getSourceSnapshot(request("other-attempt"))).status).toBe(404);
    expect((await getSourceSnapshot(request(attempt.id))).status).toBe(200);
    const newer = await prisma.generationAttempt.create({ data: { requestId: jobId, attemptNo: attempt.attemptNo + 1, status: "queued" } });
    expect((await getSourceSnapshot(request(attempt.id))).status).toBe(404);
    expect((await getSourceSnapshot(request(newer.id))).status).toBe(200);
    await prisma.generationAttempt.delete({ where: { id: newer.id } });
    const queued = await jobQueue.getByDedupeKey("ai.video.generate", idempotencyKeys.generationAttempt(jobId, 1));
    if (!queued) throw new Error("Missing queued fixture");
    await prisma.generationSourceSnapshotChunk.update({ where: { snapshotId_ordinal: { snapshotId, ordinal: 0 } }, data: { bytes: new Uint8Array([1, 2, 3]) } });
    await expect(runQueuedGenerationJobs(10)).rejects.toThrow("Source snapshot truncated");
    expect(native).not.toHaveBeenCalled();
    const genPath = new URL("../../../../../gen/src/pipeline.ts", import.meta.url).href;
    const gen = await import(genPath);
    await gen.processVideoGenerate(queued.payload, {
      providers: await generationTestProviders(), attemptsMade: queued.maxAttempts - 1, maxAttempts: queued.maxAttempts,
      readSourceSnapshot: async () => new Uint8Array(await (await getSourceSnapshot(request(attempt.id))).arrayBuffer()),
      acknowledgeTerminalRecord: async (record: Parameters<typeof ingestGenerationTerminalRecord>[0]) => { await ingestGenerationTerminalRecord(record); },
      recordTransportExecution: async () => { throw new Error("Unexpected provider entry"); },
    });
    await dispatchPendingGenerationTerminalRecords();
    await drainLocalAiPipeline(); await advanceVideoSequences();
    expect(native).not.toHaveBeenCalled();
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "failed", errorCode: "preparation_failed" });
    expect(await dreamcoinBalance(userId)).toBe(1000);
    expect(await prisma.generationSettlementLink.count({ where: { requestId: jobId, kind: "refund" } })).toBe(1);
  });

  it.each([{ url: "http://127.0.0.1/private" }, { storageKey: "legacy.png" }])("refunds a legacy attempt and freezes the source on user retry: %o", async reference => {
    const native = await mockedNativeSuccess();
    const { sequence } = await create(body(1));
    const jobId = sequence.scenes[0]!.job.id;
    const queued = await jobQueue.getByDedupeKey("ai.video.generate", idempotencyKeys.generationAttempt(jobId, 1));
    if (!queued) throw new Error("Missing queued fixture");
    const payload = { ...(queued.payload as Record<string, unknown>), referenceImages: [{ assetId: "legacy", role: "source_image", ...reference }] };
    const originalJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    const { sourceSnapshot: _pin, referenceSnapshots: _references, ...legacyControls } = originalJob.controls as Record<string, unknown>;
    await prisma.generationJob.update({ where: { id: jobId }, data: { controls: legacyControls as never } });
    await jobQueue.removeByDedupeKey("ai.video.generate", idempotencyKeys.generationAttempt(jobId, 1));
    const genPath = new URL("../../../../../gen/src/pipeline.ts", import.meta.url).href;
    const gen = await import(genPath);
    await gen.processVideoGenerate(payload, {
      providers: await generationTestProviders(), attemptsMade: queued.maxAttempts - 1, maxAttempts: queued.maxAttempts,
      acknowledgeTerminalRecord: async (record: Parameters<typeof ingestGenerationTerminalRecord>[0]) => { await ingestGenerationTerminalRecord(record); },
      recordTransportExecution: async () => { throw new Error("Unexpected provider entry"); },
    });
    await dispatchPendingGenerationTerminalRecords();
    await drainLocalAiPipeline(); await advanceVideoSequences();
    expect(native).not.toHaveBeenCalled();
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "failed", errorCode: "preparation_failed" });
    expect(await dreamcoinBalance(userId)).toBe(1000);
    expect(await prisma.generationSettlementLink.count({ where: { requestId: jobId, kind: "refund" } })).toBe(1);
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    const retryBytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#456789" } }).png().toBuffer();
    await providers.blob.putPrivate({ key: source.storageKey!, body: retryBytes, contentType: "image/png" });
    const retryInput = { userId, generationJobId: jobId, idempotencyKey: randomUUID() };
    const target = await resolveGenerationRetryTarget(retryInput);
    if (target.kind !== "retryable") throw new Error("Legacy failure should be retryable");
    const { quote: retryQuote } = await quoteGenerationRetry(retryInput);
    const retry = await retryGenerationJobForUser({ ...retryInput, job: target.job, quoteAuthority: quoteAuthorityFor(retryQuote, 1)! });
    expect(retry.controls).toMatchObject({ sourceSnapshot: { version: 1 } });
    await providers.blob.putPrivate({ key: source.storageKey!, body: Buffer.from("replaced after retry"), contentType: "image/png" });
    await runQueuedGenerationJobs(10);
    expect(native).toHaveBeenCalledTimes(1);
    expect(Buffer.from(native.mock.calls[0]![0].referenceImages![0]!.b64Json!, "base64")).toEqual(retryBytes);
  });

  it.each(["corrupt", "missing"] as const)("rejects a %s source before quoting or reserving coins", async state => {
    const request = body(1);
    const price = await quote(request);
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    if (!source.storageKey) throw new Error("Test source has no blob");
    if (state === "missing") await providers.blob.delete({ key: source.storageKey });
    else await providers.blob.putPrivate({ key: source.storageKey, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ak9zP8AAAAASUVORK5CYII=", "base64"), contentType: "image/png" });
    const balance = await dreamcoinBalance(userId);
    const quoteAfter = await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: request });
    expectError(quoteAfter, 409, "conflict");
    const submitted = await api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": randomUUID() }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectError(submitted, 409, "conflict");
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(balance);
  });

  it("rechecks source bytes inside admission after a successful quote, without leaving a charge", async () => {
    const request = body(1), price = await quote(request), balance = await dreamcoinBalance(userId);
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let reads = 0;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      reads += 1;
      if (reads === 1) return get(input);
      return { ok: true, data: { body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ak9zP8AAAAASUVORK5CYII=", "base64"), contentType: "image/png" } };
    });
    const submitted = await api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": randomUUID() }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectError(submitted, 409, "conflict");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(balance);
  });

  it.each([{ width: 6400, allowed: true }, { width: 6401, allowed: false }])("honors the 40M pixel source limit (width $width)", async ({ width, allowed }) => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    if (!source.storageKey) throw new Error("Test source has no blob");
    const bytes = await sharp({ create: { width, height: 6250, channels: 3, background: "#83919f" } }).png().toBuffer();
    await providers.blob.putPrivate({ key: source.storageKey, body: bytes, contentType: "image/png" });
    const response = await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: body(1) });
    if (allowed) expectOk(response); else expectError(response, 409, "conflict");
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
  });

  it("rejects decodable SVG source bytes before charging for a video", async () => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    if (!source.storageKey) throw new Error("Test source has no blob");
    await providers.blob.putPrivate({ key: source.storageKey, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'), contentType: "image/svg+xml" });
    const response = await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: body(1) });
    expectError(response, 409, "conflict");
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
  });

  it.each(["png", "jpeg", "webp", "gif", "tiff", "avif"] as const)("keeps %s source images usable for video", async format => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    if (!source.storageKey) throw new Error("Test source has no blob");
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#7296b0" } })[format]().toBuffer();
    await providers.blob.putPrivate({ key: source.storageKey, body: bytes, contentType: `image/${format}` });
    const response = await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: body(1) });
    expectOk(response);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
  });

  it("accepts a fully decoded small animated GIF source", async () => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    if (!source.storageKey) throw new Error("Test source has no blob");
    const pixels = Buffer.concat([Buffer.alloc(64 * 64 * 3, 32), Buffer.alloc(64 * 64 * 3, 192)]);
    const bytes = await sharp(pixels, { raw: { width: 64, height: 128, channels: 3, pageHeight: 64 } }).gif().toBuffer();
    expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(2);
    await providers.blob.putPrivate({ key: source.storageKey, body: bytes, contentType: "image/gif" });
    expectOk(await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: body(1) }));
  });

  it("decodes a shared source once per quote and once per locked multi-scene admission", async () => {
    const reads = vi.spyOn(providers.blob, "getPrivate");
    const request = body(3), price = await quote(request);
    expect(reads).toHaveBeenCalledTimes(1);
    const response = await api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": randomUUID() }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectOk(response, 202);
    // The write requotes once, then verifies once while holding the source authority.
    expect(reads).toHaveBeenCalledTimes(3);
    expect(videoSequenceDtoSchema.parse(response.data.sequence).scenes).toHaveLength(3);
  });

  it.each([{ code: "get_failed", retryable: false }, { code: "get_failed", retryable: true }])("reports storage failures as unavailable without charging ($retryable)", async ({ code, retryable }) => {
    const request = body(1), price = await quote(request), balance = await dreamcoinBalance(userId);
    vi.spyOn(providers.blob, "getPrivate").mockResolvedValue({ ok: false, error: { code, retryable, message: "controlled storage failure" } });
    const response = await api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": randomUUID() }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectError(response, 503, "unavailable");
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(balance);
  });

  it("releases the intent lock after a failed read so the same key can be retried", async () => {
    const request = body(1), price = await quote(request), key = randomUUID();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let firstRead = true;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (firstRead) { firstRead = false; return { ok: false, error: { code: "get_failed", retryable: true, message: "controlled outage" } }; }
      return get(input);
    });
    const write = () => api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": key }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectError(await write(), 503, "unavailable");
    expectOk(await write(), 202);
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(1);
  });

  it("replays an accepted sequence after its source becomes corrupt without charging again", async () => {
    const request = body(1), price = await quote(request), key = randomUUID();
    const write = () => api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": key }, body: { ...request, quoteFingerprint: price.fingerprint } });
    const first = await write(); expectOk(first, 202);
    const sequence = videoSequenceDtoSchema.parse(first.data.sequence);
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    if (!source.storageKey) throw new Error("Test source has no blob");
    await providers.blob.putPrivate({ key: source.storageKey, body: Buffer.from("broken image"), contentType: "image/png" });
    const replay = await write(); expectOk(replay, 202);
    expect(videoSequenceDtoSchema.parse(replay.data.sequence).id).toBe(sequence.id);
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(1);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(1);
  });

  it("keeps a same-key replay and receipt check pending while the original submission commits", async () => {
    const request = body(1), price = await quote(request), key = randomUUID();
    const write = () => api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": key }, body: { ...request, quoteFingerprint: price.fingerprint } });
    const entered = barrier(), hold = barrier();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let reads = 0;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      reads += 1;
      if (reads === 2) { entered.release(); await hold.promise; return get(input); }
      if (reads === 3) return { ok: true, data: { body: Buffer.from("broken image"), contentType: "image/png" } };
      return get(input);
    });
    const first = write();
    await Promise.race([entered.promise, first.then(result => { throw new Error(`Original submission ended before the controlled pause: ${result.status}`); })]);
    const replay = await write();
    const lookup = await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } });
    hold.release();
    const original = await first;
    expectError(replay, 409, "conflict");
    expectError(lookup, 503, "unavailable");
    const repeated = await write();
    const recovered = await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } });
    expectOk(original, 202); expectOk(repeated, 202); expectOk(recovered);
    const id = videoSequenceDtoSchema.parse(original.data.sequence).id;
    expect(videoSequenceDtoSchema.parse(repeated.data.sequence).id).toBe(id);
    expect(videoSequenceDtoSchema.parse(recovered.data.sequence).id).toBe(id);
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(1);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(1);
  });

  it("closes an unconfirmed old receipt and fences a delayed same-key preflight", async () => {
    const request = body(1), price = await quote(request), key = randomUUID();
    const payload = { ...request, quoteFingerprint: price.fingerprint };
    const write = () => api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: payload });
    const close = (value = payload) => api("POST", "generation/video-sequences/request/abandon", { userId, ageGate: true, headers: { "idempotency-key": key }, body: value });
    const entered = barrier(), hold = barrier();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => { entered.release(); await hold.promise; return get(input); });
    const pending = write();
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Submission ended before pause: ${result.status}`); })]);
    try {
      const missing = await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } });
      expectError(missing, 503, "unavailable");
      const canceled = await close(); expectOk(canceled); expect(canceled.data.state).toBe("abandoned");
      const recovered = await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } });
      expectError(recovered, 410, "gone");
      expectOk(await close());
      expectError(await close({ ...payload, audio: "silent" }), 409, "conflict");
    } finally { hold.release(); }
    expectError(await pending, 410, "gone");
    expectError(await write(), 410, "gone");
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
  }, 30_000);

  it("returns an already accepted original when close races after commitment", async () => {
    const { sequence, key, request } = await create(body(1));
    const closed = await api("POST", "generation/video-sequences/request/abandon", { userId, ageGate: true, headers: { "idempotency-key": key }, body: request });
    expectOk(closed); expect(closed.data.state).toBe("accepted"); expect(closed.data.sequence.id).toBe(sequence.id);
    const lookup = await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } });
    expectOk(lookup); expect(lookup.data.sequence.id).toBe(sequence.id);
    const revisedReplay = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: { ...request, quoteFingerprint: "0".repeat(64) } });
    expectOk(revisedReplay, 202); expect(revisedReplay.data.sequence.id).toBe(sequence.id);
    expect(revisedReplay.data.sequence.acceptedQuote.fingerprint).toBe(request.quoteFingerprint);
    expect(await prisma.videoSequenceCancellation.count({ where: { userId, idempotencyKey: key } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(1);
  });

  it("honors the intent lock across a separate PostgreSQL client process", async () => {
    const request = body(1), price = await quote(request), key = randomUUID();
    const identity = JSON.stringify(["video-sequence-intent", userId, key]).replaceAll("'", "''");
    const child = spawn("psql", [process.env.DATABASE_URL!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    const acquired = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", value => String(value).trim() === "t" ? resolve() : reject(new Error(`Unexpected lock result: ${value}`)));
      child.once("exit", code => reject(new Error(`Lock process exited early: ${code}`)));
    });
    child.stdin.write(`BEGIN; SELECT pg_try_advisory_xact_lock(hashtextextended('${identity}', 0));\n`);
    try {
      await acquired;
      const payload = { ...request, quoteFingerprint: price.fingerprint };
      const close = () => api("POST", "generation/video-sequences/request/abandon", { userId, ageGate: true, headers: { "idempotency-key": key }, body: payload });
      expectError(await close(), 503, "unavailable");
      expectError(await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } }), 503, "unavailable");
      child.stdin.write("COMMIT;\n"); child.stdin.end();
      await new Promise<void>((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Lock process failed: ${code}`))));
      const result = await close(); expectOk(result); expect(result.data.state).toBe("abandoned");
    } finally { if (child.exitCode === null) child.kill(); }
  });

  it("recovers the accepted sequence after post-commit dispatch fails", async () => {
    const request = body(1), price = await quote(request), key = randomUUID();
    const payload = { ...request, quoteFingerprint: price.fingerprint };
    const write = () => api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: payload });
    const dispatch = vi.spyOn(dispatchAuthority, "dispatchGenerationAttemptOutbox").mockRejectedValueOnce(new Error("simulated lost dispatch response"));
    const failed = await write(); expectError(failed, 500, "internal");
    dispatch.mockRestore();
    const recovered = await api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } });
    expectOk(recovered); const id = recovered.data.sequence.id;
    const close = await api("POST", "generation/video-sequences/request/abandon", { userId, ageGate: true, headers: { "idempotency-key": key }, body: payload });
    expectOk(close); expect(close.data).toMatchObject({ state: "accepted", sequence: { id } });
    expectOk(await write(), 202);
    const sequence = await prisma.videoSequence.findUniqueOrThrow({ where: { id }, include: { scenes: true } });
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(1);
    const outboxId = `generation_initial_${sequence.scenes[0]!.generationJobId}`;
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({ status: "pending" });
    await dispatchAuthority.dispatchGenerationAttemptOutbox(prisma, { outboxIds: [outboxId] });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({ status: "delivered" });
  });

  it("admits concurrent independent users without exhausting a small Prisma connection pool", async () => {
    const second = await createSequenceActor();
    const firstBody = body(1), secondBody = { ...body(1), characterId: second.characterId };
    const [firstQuote, secondQuote] = await Promise.all([quote(firstBody), quote(secondBody, second.userId)]);
    const [first, another] = await Promise.all([
      api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": randomUUID() }, body: { ...firstBody, quoteFingerprint: firstQuote.fingerprint } }),
      api("POST", "generation/video-sequences", { userId: second.userId, ageGate: true, headers: { "idempotency-key": randomUUID() }, body: { ...secondBody, quoteFingerprint: secondQuote.fingerprint } }),
    ]);
    expectOk(first, 202); expectOk(another, 202);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: { in: [userId, second.userId] }, reason: "generation_spend" } })).toBe(2);
  }, 30_000);

  it("does not let repeated checks for a pending key block another user's sequence", async () => {
    const second = await createSequenceActor();
    const firstBody = body(1), secondBody = { ...body(1), characterId: second.characterId };
    const [firstQuote, secondQuote] = await Promise.all([quote(firstBody), quote(secondBody, second.userId)]);
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    const entered = barrier(), hold = barrier();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let reads = 0;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (input.key === source.storageKey && ++reads === 2) { entered.release(); await hold.promise; }
      return get(input);
    });
    const key = randomUUID();
    const first = api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: { ...firstBody, quoteFingerprint: firstQuote.fingerprint } });
    await Promise.race([entered.promise, first.then(result => { throw new Error(`Original submission ended before the controlled pause: ${result.status}`); })]);
    try {
      const [checks, other] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => api("GET", "generation/video-sequences/request", { userId, ageGate: true, query: { key } }))),
        api("POST", "generation/video-sequences", { userId: second.userId, ageGate: true, headers: { "idempotency-key": randomUUID() }, body: { ...secondBody, quoteFingerprint: secondQuote.fingerprint } }),
      ]);
      for (const check of checks) expectError(check, 503, "unavailable");
      expectOk(other, 202);
    } finally { hold.release(); }
    expectOk(await first, 202);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: { in: [userId, second.userId] }, reason: "generation_spend" } })).toBe(2);
  }, 30_000);

  it("refuses to quote a display-only primary image before accepting any video price", async () => {
    const request = body(1);
    const validQuote = await quote(request);
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const sourceImageAssetId = character.imageAssetId!;
    await prisma.mediaAsset.update({ where: { id: sourceImageAssetId }, data: {
      storageKey: null, url: `/images/characters/${sourceImageAssetId}.png`, metadata: {},
    } });
    const balance = await dreamcoinBalance(userId);
    const result = await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: request });
    expect.soft(result.status).toBe(409);
    expect.soft(result.error).toMatchObject({ code: "conflict", details: { sourceImageAssetId } });
    const nativeQuote = await api("POST", "generation/quote", { userId, ageGate: true, body: {
      mode: "video", characterId, freeplay: false, outputCount: 1, controls: {},
    } });
    expectError(nativeQuote, 409, "conflict");
    expect(nativeQuote.error?.message).toContain("Choose another image or generate a new image first");
    // A previously accepted quote must still fail when its source loses authority.
    const submit = await api("POST", "generation/video-sequences", {
      userId, ageGate: true, headers: { "idempotency-key": randomUUID() },
      body: { ...request, quoteFingerprint: validQuote.fingerprint },
    });
    expectError(submit, 409, "conflict");
    expect(await prisma.videoSequence.count({ where: { userId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(balance);
  });

  it.each(["archived", "deleted", "unsafe", "invalid_shared_locator"] as const)("does not quote an %s primary image", async state => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const sourceImageAssetId = character.imageAssetId!;
    await prisma.mediaAsset.update({ where: { id: sourceImageAssetId }, data:
      state === "deleted" ? { deletedAt: new Date() }
        : state === "unsafe" ? { safetyStatus: "blocked" }
          : state === "archived" ? { metadata: { platformAsset: { status: "archived" } } }
            : { storageKey: null, url: `/images/${sourceImageAssetId}.png`, metadata: {
                blobLocator: { schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA, kind: "shared_immutable", key: "untrusted-key", sourceAssetId: "source-a" },
                duplicateLineage: { sourceAssetId: "source-b" },
              } },
    });
    const result = await api("POST", "generation/video-sequences/quote", { userId, ageGate: true, body: body(1) });
    expectError(result, 409, "conflict");
    expect(result.error?.details).toMatchObject({ sourceImageAssetId });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
  });

  it("quotes and admits a valid shared immutable source without inventing another blob", async () => {
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const original = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: character.imageAssetId! } });
    const duplicateId = `${original.id}-duplicate`;
    await prisma.mediaAsset.create({ data: {
      id: duplicateId, ownerId: userId, characterId, type: "image", url: original.url,
      contentType: original.contentType, visibility: "private", safetyStatus: "passed",
      metadata: {
        blobLocator: { schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA, kind: "shared_immutable", key: original.storageKey, sourceAssetId: original.id },
        duplicateLineage: { sourceAssetId: original.id },
      },
    } });
    await prisma.character.update({ where: { id: characterId }, data: { imageAssetId: duplicateId } });
    const { sequence } = await create(body(1));
    const accepted = await prisma.generationJob.findUniqueOrThrow({ where: { id: sequence.scenes[0]!.job.id } });
    expect(accepted.controls).toMatchObject({ sourceImageAssetId: duplicateId });
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: duplicateId } })).toMatchObject({ storageKey: null });
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId, reason: "generation_spend" }, select: { delta: true } })).toEqual([{ delta: -100 }]);
  });

  it("quotes and pins the 448x768 portrait when a new request omits ratio and quality", async () => {
    const request = { characterId, scenes: [{ prompt: "A controlled friendly wave", seconds: 5 }] };
    const price = await quote(request);
    expect(price.scenes[0].video).toMatchObject({ width: 448, height: 768, durationSeconds: 121 / 24 });
    const admitted = await api("POST", "generation/video-sequences", { userId, ageGate: true,
      headers: { "idempotency-key": randomUUID() }, body: { ...request, quoteFingerprint: price.fingerprint } });
    expectOk(admitted, 202);
    const sequence = videoSequenceDtoSchema.parse(admitted.data.sequence);
    expect(sequence.request).toMatchObject({ orientation: "7:12", quality: "preview" });
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: sequence.scenes[0].job.id } });
    expect(job.controls).toMatchObject({ width: 448, height: 768, workflowVersion: 5,
      generationProfileVersion: 9, videoOptionsVersion: REDGRAFT_VIDEO_OPTIONS.version });
  });
  it("account erasure prevents a deleted owner from newly claiming completed scenes", async () => {
    await mockedNativeSuccess(); const { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    await requestSequenceAccountDeletion();
    const composer = vi.spyOn(composition, "composeVideoScenes");
    await advanceVideoSequences();
    expect(composer).not.toHaveBeenCalled();
    expect(await prisma.videoSequence.findUniqueOrThrow({ where: { id: sequence.id } })).not.toMatchObject({ status: "completed" });
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_sequence" } } })).toBe(0);
  });

  it("account erasure waits for an expired active composer and fences its upload", async () => {
    await mockedNativeSuccess(); const { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    const output = await composition.composeVideoScenes({ scenes: [{ video: nativeBytes }], audio: "generated" });
    const started = barrier(), release = barrier(), writes: string[] = [];
    vi.spyOn(composition, "composeVideoScenes").mockImplementation(async () => { started.release(); await release.promise; return output; });
    const store = providers.blob.putPrivate.bind(providers.blob);
    vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      if (input.key.startsWith(`video-sequences/${userId}/${sequence.id}/`)) writes.push(input.key);
      return store(input);
    });
    const advancing = advanceVideoSequences();
    try {
      await started.promise;
      const deletion = await requestSequenceAccountDeletion();
      await prisma.videoSequence.update({ where: { id: sequence.id }, data: { compositionLeaseAt: new Date(Date.now() - 1000) } });
      await acknowledgeSequenceAccountDeletion();
      const erased = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], batch: 100 });
      const retainedWhileRunning = await prisma.user.findUnique({ where: { id: userId } });
      release.release(); await advancing;
      expect(erased.completed).toBe(0);
      expect(retainedWhileRunning).not.toBeNull();
      expect(writes).toEqual([]);
      await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], batch: 100 });
      expect(await prisma.accountDeletion.findUniqueOrThrow({ where: { id: deletion.id } })).toMatchObject({ status: "completed" });
    } finally { release.release(); await advancing; }
  });

  it("account erasure retains ownership of an inflight packaging object when cleanup delete fails", async () => {
    await mockedNativeSuccess(); const { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    const uploaded = barrier(), release = barrier(); let outputKey = "";
    const store = providers.blob.putPrivate.bind(providers.blob), remove = providers.blob.delete.bind(providers.blob);
    vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      const result = await store(input);
      if (input.key.startsWith(`video-sequences/${userId}/${sequence.id}/`) && input.key.endsWith(".mp4")) {
        outputKey = input.key; uploaded.release(); await release.promise;
      }
      return result;
    });
    let denyOutputDelete = true;
    vi.spyOn(providers.blob, "delete").mockImplementation(input => input.key === outputKey && denyOutputDelete
      ? Promise.resolve({ ok: false as const, error: { code: "blob_unavailable", message: "controlled delete failure", retryable: true } }) : remove(input));
    const advancing = advanceVideoSequences();
    try {
      await uploaded.promise;
      const deletion = await requestSequenceAccountDeletion(); await acknowledgeSequenceAccountDeletion();
      const erasedWhileRunning = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], batch: 100 });
      release.release(); await advancing;
      await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], batch: 100 });
      const receipt = await prisma.accountDeletionBlobReceipt.findFirst({ where: { deletionId: deletion.id, storageKey: outputKey } });
      expect(erasedWhileRunning.completed).toBe(0);
      expect(receipt).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
      expect((await providers.blob.getPrivate!({ key: outputKey })).ok).toBe(true);
      denyOutputDelete = false;
      await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], now: new Date(Date.now() + 60_000), batch: 100 });
      expect(await prisma.accountDeletion.findUniqueOrThrow({ where: { id: deletion.id } })).toMatchObject({ status: "completed" });
      expect((await providers.blob.getPrivate!({ key: outputKey })).ok).toBe(false);
    } finally { denyOutputDelete = false; release.release(); await advancing; if (outputKey) await remove({ key: outputKey }); }
  });

  it("quotes actual bounded dimensions, atomically admits two paid children and replays one receipt", async () => {
    const { sequence, request, key } = await create();
    const jobs = sequence.scenes.map(scene => scene.job.id);
    expect(sequence.cost).toEqual({ charged: 200, refunded: 0, finalCharge: 200 }); expect(await dreamcoinBalance(userId)).toBe(800);
    expect(await prisma.generationAttempt.count({ where: { requestId: { in: jobs } } })).toBe(2);
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: `generation_initial_${jobs[0]}` } })).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: `generation_initial_${jobs[1]}` } })).toMatchObject({ status: "pending", attempts: 0 });
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobs[0] } })).controls).toMatchObject({ width: 512, height: 512, seconds: 3, generationProfileVersion: PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE.version, videoOptionsVersion: REDGRAFT_VIDEO_OPTIONS.version });
    const replies = await Promise.all(Array.from({ length: 3 }, () => api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: request })));
    for (const reply of replies) { expectOk(reply, 202); expect(reply.data.sequence.id).toBe(sequence.id); }
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(2); expect(await dreamcoinBalance(userId)).toBe(800);
    const changed = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: { ...request, audio: "silent" } }); expectError(changed, 409);
  });

  it("batches list authority reads while matching ordered detail receipts and actual refunds", async () => {
    const { sequence: older } = await create();
    const stopped = await api("POST", `generation/video-sequences/${older.id}/stop`, { userId, ageGate: true });
    expectOk(stopped);
    // The untouched second scene is refunded; the dispatched first scene is
    // still unresolved. A quote or sequence status cannot supply this balance.
    expect(stopped.data.sequence.cost).toEqual({ charged: 200, refunded: 100, finalCharge: 100 });
    const { sequence: newer } = await create(body(1));
    const expected = await Promise.all([read(newer.id), read(older.id)]);
    const stranger = `${P}user-${randomUUID()}-list-reader`;
    await createUser({ id: stranger });

    const sequenceReads = vi.spyOn(prisma.videoSequence, "findMany");
    const detailReads = vi.spyOn(prisma.videoSequence, "findFirst");
    const attemptReads = vi.spyOn(prisma.generationAttempt, "findMany");
    const rawReads = vi.spyOn(prisma, "$queryRaw");
    const settlementReads = () => rawReads.mock.calls.filter(([query]) =>
      typeof query === "object" && query !== null && "sql" in query &&
      typeof query.sql === "string" && query.sql.includes("generation_settlement_links"));
    try {
      const listed = await api("GET", "generation/video-sequences", { userId, ageGate: true });
      expectOk(listed);
      const sequences = (listed.data.sequences as unknown[]).map(row => videoSequenceDtoSchema.parse(row));
      expect(sequences).toEqual(expected);
      expect(sequences.map(sequence => sequence.scenes.map(scene => scene.ordinal))).toEqual([[0], [0, 1]]);
      expect(sequenceReads).toHaveBeenCalledTimes(1);
      expect(detailReads).not.toHaveBeenCalled();
      expect(attemptReads).toHaveBeenCalledTimes(1);
      expect(attemptReads.mock.calls[0]![0]).toMatchObject({
        where: { requestId: { in: expected.flatMap(sequence => sequence.scenes.map(scene => scene.job.id)) } },
      });
      expect(settlementReads()).toHaveLength(1);

      attemptReads.mockClear(); rawReads.mockClear();
      const empty = await api("GET", "generation/video-sequences", { userId: stranger, ageGate: true });
      expectOk(empty);
      expect(empty.data.sequences).toEqual([]);
      expect(attemptReads).not.toHaveBeenCalled();
      expect(settlementReads()).toHaveLength(0);
    } finally {
      sequenceReads.mockRestore(); detailReads.mockRestore(); attemptReads.mockRestore(); rawReads.mockRestore();
    }
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
    const recentVideos = async () => { const page = await api("GET", "library/recent", { userId, ageGate: true }); expectOk(page); return (page.data.items as Array<{ id: string; type: string }>).filter(item => item.type === "video").map(item => item.id); };
    // Until the composite exists, a paid scene clip is the user's only deliverable.
    expect((await gallery()).map(item => [item.id, item.provenance?.label])).toEqual([[partial.scenes[0]!.assets[0]!.id, "Video scene 1"]]);
    expect(await recentVideos()).toEqual([partial.scenes[0]!.assets[0]!.id]);
    await advanceVideoSequences(); await runQueuedGenerationJobs(10); expect(native).toHaveBeenCalledTimes(2);
    await Promise.all([advanceVideoSequences(), advanceVideoSequences()]);
    const result = await read(sequence.id); expect(result.status).toBe("completed"); expect(result.asset).toMatchObject({ width: 512, height: 512, metadata: { audio: "generated", narrationIsLipSync: false } });
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_sequence" } } })).toBe(1);
    // Once delivered, the gallery shows the finished video alone; scenes stay downloadable from the sequence.
    expect((await gallery()).map(item => item.id)).toEqual([result.asset!.id]);
    expect(await recentVideos()).toEqual([result.asset!.id]);
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

  it.each(["pocket_tts", "fish_audio"] as const)("pins %s narration and persists its artifact without a fake Chat or VoiceUsage row", async providerKey => {
    env.VOICE_PROVIDER = providerKey === "pocket_tts" ? "pocket-tts" : "fish-audio";
    env.POCKET_TTS_LANGUAGE = "english"; providers.voice = createVoicePortsForKey(providerKey);
    const model = voiceFactory.configuredVoiceModel(providerKey);
    const defaults = await getVoiceDefaultSettings();
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false, model, supportedModels: [model], languages: ["en"], catalogVoices: [defaults.defaultVoiceId] } });
    const speech = await narrationFixture(4.2), tts = vi.fn().mockResolvedValue({ ok: true, data: { body: speech, contentType: "audio/wav", durationMs: 4200 } });
    vi.spyOn(voiceFactory, "createVoiceClipPortForKey").mockReturnValue({ providerKey, synthesize: tts });
    const native = await mockedNativeSuccess(), { sequence, price } = await create(body(1, "narration"));
    expect(price).toMatchObject({ narrationExtendsLastFrame: true, narrationExtraCostDreamcoins: 0, voicePin: { provider: providerKey, model, voiceId: defaults.defaultVoiceId, language: "en", delivery: defaults.delivery } });
    const result = await finish(sequence.id, 1); expect(result.status).toBe("completed"); expect(result.asset?.metadata.durationSeconds).toBeGreaterThanOrEqual(4.2);
    expect(tts).toHaveBeenCalledTimes(1); expect(tts).toHaveBeenCalledWith(expect.objectContaining({ requestId: `video-narration:${sequence.id}:0`, idempotencyKey: `video-narration:${sequence.id}:0`, voiceId: defaults.defaultVoiceId, model, delivery: defaults.delivery }));
    expect(await prisma.videoSequenceScene.findFirstOrThrow({ where: { sequenceId: sequence.id } })).toMatchObject({ narrationState: "completed", narrationMediaAssetId: expect.any(String) });
    expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(0); expect(await prisma.chatTurn.count({ where: { session: { userId } } })).toBe(0); expect(await dreamcoinBalance(userId)).toBe(900); expect(native).toHaveBeenCalledTimes(1);
    // The library lists the narrated video, not its scene clip or speech track.
    const library = await api("GET", "media", { userId, ageGate: true }); expectOk(library);
    expect((library.data.items as Array<{ id: string }>).map(item => item.id).filter(id => id !== userId.replace(/-owner$/, "-source"))).toEqual([result.asset!.id]);
    const recent = await api("GET", "library/recent", { userId, ageGate: true }); expectOk(recent);
    expect((recent.data.items as Array<{ id: string; type: string }>).filter(item => item.type === "video" || item.type === "voice").map(item => item.id)).toEqual([result.asset!.id]);
  });

  it("delivers three complete narration assets and retries only missing speech or packaging without another debit", async () => {
    env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english"; providers.voice = createVoicePortsForKey("pocket_tts");
    const defaults = await getVoiceDefaultSettings();
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false, model: env.POCKET_TTS_MODEL, supportedModels: [env.POCKET_TTS_MODEL], languages: ["en"], catalogVoices: [defaults.defaultVoiceId] } });
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
    const { sequence, key, request: acceptedRequest } = await create(request);
    const first = await finish(sequence.id, 3);
    expect(first.status).toBe("composition_failed");
    const afterSpeechFailure = await prisma.videoSequenceScene.findMany({ where: { sequenceId: sequence.id }, orderBy: { ordinal: "asc" } });
    expect(afterSpeechFailure.map(scene => scene.narrationState)).toEqual(["completed", "completed", "failed"]);
    expect(afterSpeechFailure.map(scene => Boolean(scene.narrationMediaAssetId))).toEqual([true, true, false]);
    expect(tts).toHaveBeenCalledTimes(3);
    // Changing the default engine must not retarget the missing third narration.
    env.VOICE_PROVIDER = "fish-audio"; providers.voice = createVoicePortsForKey("fish_audio");
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
    expect(tts.mock.calls.every(([request]) => request.model === env.POCKET_TTS_MODEL)).toBe(true);
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
    // Replay the accepted request after the provider switch without asking the
    // replacement runtime for a new quote or changing the pinned narration.
    const replay = await api("POST", "generation/video-sequences", { userId, ageGate: true, headers: { "idempotency-key": key }, body: acceptedRequest });
    expectOk(replay, 202);
    expect(videoSequenceDtoSchema.parse(replay.data.sequence).id).toBe(sequence.id);
    await advanceVideoSequences();
    expect(tts).toHaveBeenCalledTimes(4); expect(native).toHaveBeenCalledTimes(3);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(3);
    expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(0);
    expect(await prisma.chatTurn.count({ where: { session: { userId } } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(700);
    // Three real narration fixtures plus scene packaging/retries exceed the
    // default 5s under CI coverage; retain every media and debit assertion.
  }, 30_000);

  it("fences a late composer after the owner stops the sequence", async () => {
    await mockedNativeSuccess(); const { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    let release!: () => void, reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; }); const delayed = new Promise<void>(resolve => { release = resolve; });
    const actual = composition.composeVideoScenes;
    vi.spyOn(composition, "composeVideoScenes").mockImplementation(async input => { reached(); await delayed; return actual(input); });
    const advancing = advanceVideoSequences(); await started;
    const stopped = await api("POST", `generation/video-sequences/${sequence.id}/stop`, { userId, ageGate: true }); expectOk(stopped);
    expect((await prisma.videoSequence.findUniqueOrThrow({ where: { id: sequence.id } })).activeCompositionOwners).toHaveLength(1);
    release(); await advancing;
    const result = await read(sequence.id); expect(result.status).toBe("cancelled"); expect(result.asset).toBeNull(); expect(result.scenes[0]?.assets).toHaveLength(1); expect(result.cost.finalCharge).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, metadata: { path: ["source"], equals: "video_sequence" } } })).toBe(0);
    expect((await prisma.videoSequence.findUniqueOrThrow({ where: { id: sequence.id } })).activeCompositionOwners).toEqual([]);
  });

  it("keeps delivered video readable when an expired composer cleans up after the new lease delivers identical bytes", async () => {
    const native = await mockedNativeSuccess(), { sequence } = await create(body(1)); await runQueuedGenerationJobs(10);
    const output = await composition.composeVideoScenes({ scenes: [{ video: nativeBytes }], audio: "generated" });
    const oldStarted = barrier(), newStarted = barrier(), releaseOld = barrier(), releaseNew = barrier(), deleting = barrier(), releaseDelete = barrier();
    vi.spyOn(composition, "composeVideoScenes")
      .mockResolvedValueOnce(output)
      .mockImplementationOnce(async () => { newStarted.release(); await releaseNew.promise; return output; });
    // The old PUT has crossed its permission check. Hold its ACK so cleanup is
    // still required after takeover; a pre-PUT old composer is now rejected.
    const store = providers.blob.putPrivate.bind(providers.blob); let firstPut = true;
    vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      const stored = await store(input);
      if (firstPut && input.key.startsWith(`video-sequences/${userId}/${sequence.id}/`) && input.key.endsWith(".mp4")) {
        firstPut = false; oldStarted.release(); await releaseOld.promise;
      }
      return stored;
    });
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
      expect((await prisma.videoSequence.findUniqueOrThrow({ where: { id: sequence.id } })).activeCompositionOwners).toHaveLength(1);
      releaseDelete.release(); await oldAdvance;
      expect((await prisma.videoSequence.findUniqueOrThrow({ where: { id: sequence.id } })).activeCompositionOwners).toEqual([]);
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

  it("retains the winning narration and prevents a late voice upload after its composition lease expires", async () => {
    env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english"; providers.voice = createVoicePortsForKey("pocket_tts");
    const defaults = await getVoiceDefaultSettings();
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false, model: env.POCKET_TTS_MODEL, supportedModels: [env.POCKET_TTS_MODEL], languages: ["en"], catalogVoices: [defaults.defaultVoiceId] } });
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
      expect(scene.narrationState).toBe("completed"); expect(voiceKeys).toHaveLength(1);
      expect(scene.narrationMediaAsset!.storageKey).toBe(voiceKeys[0]);
      const voice = await api("GET", `media/${scene.narrationMediaAsset!.id}/content`, { userId, ageGate: true }); expectOk(voice); expect(voice.bytes).toEqual(winningSpeech);
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
