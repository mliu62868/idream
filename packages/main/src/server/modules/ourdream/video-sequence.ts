import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { videoSequenceRequestSchema, REDGRAFT_VIDEO_OPTIONS, type VideoSequenceRequest } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { createVoiceClipPortForKey } from "@/server/providers/voice/factory";
import { getVoiceDefaultSettings } from "@/server/modules/voice-defaults";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { dreamcoinBalance } from "@/server/modules/billing/ledger";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import { hasProductionVideoOptions } from "@/server/modules/generation/production-video-profile";
import { settleGenerationRequestCancellation } from "@/server/ai/generation-request-lifecycle";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { lockUserLedger } from "./subscription-lifecycle";
import { entitlementMap } from "./subscription-lifecycle";
import { selectGenerationProfile } from "./generation-profile-selection";
import { featureFlagEnabled } from "./generation-profile-catalog";
import { generationJobSchema } from "./generation-request-schema";
import { quoteGeneration, quoteAuthorityFor } from "./generation-quote";
import { createGenerationJobForUser } from "./generation-job-create";
import { appendGenerationEvent, generationWriteRequestFingerprint } from "./generation-job-authority";
import { generationJobInclude, generationJobDTO, latestGenerationAttemptStatuses } from "./generation-job-read-model";
import { composeVideoScenes } from "./video-composition";

const voicePinSchema = z.object({ provider: z.literal("pocket_tts"), voiceId: z.string().min(1), settingVersion: z.number().int().nonnegative(), language: z.literal("en"), model: z.string().min(1) }).strict();
const include = { mediaAsset: true, scenes: { orderBy: { ordinal: "asc" as const }, include: { generationJob: { include: generationJobInclude() }, narrationMediaAsset: true } } } satisfies Prisma.VideoSequenceInclude;
type SequenceRow = Prisma.VideoSequenceGetPayload<{ include: typeof include }>;

export async function videoSequenceCapabilities(userId: string) {
  const entitlements = await entitlementMap(userId);
  if (!entitlements.video_generation || !await featureFlagEnabled("video_gen")) throw Errors.paymentRequired("Video generation is unavailable for this account");
  const profile = await selectGenerationProfile({ mode: "video", accessibleEntitlements: entitlements });
  const narration = providers.voice.clip.providerKey === "pocket_tts" && ["english", "en"].includes(env.POCKET_TTS_LANGUAGE.toLowerCase()) && await featureFlagEnabled("voice_gen");
  return { options: hasProductionVideoOptions(profile) ? REDGRAFT_VIDEO_OPTIONS : { seconds: [5], orientations: ["2:3"], qualities: ["standard"] }, audio: narration ? ["generated", "silent", "narration"] : ["generated", "silent"] };
}

function nativeSceneBody(request: VideoSequenceRequest, ordinal: number) {
  const scene = request.scenes[ordinal]!;
  return generationJobSchema.parse({ mode: "video", characterId: request.characterId, visualProfileId: request.visualProfileId,
    generationContextToken: request.generationContextToken, consistencyMode: request.consistencyMode, seed: request.seed ? `${request.seed}:${ordinal}` : undefined,
    freeplay: false, prompt: scene.prompt, outputCount: 1, orientation: request.orientation,
    controls: { seconds: scene.seconds, videoQuality: request.quality } });
}

function requestIdentity(body: VideoSequenceRequest) {
  const { quoteFingerprint: _quote, ...semantic } = body;
  return canonicalJsonHash({ version: "video-sequence-request-v1", body: semantic });
}

export async function quoteVideoSequence(userId: string, body: VideoSequenceRequest) {
  const resolved = [];
  for (const [ordinal] of body.scenes.entries()) {
    const value = await quoteGeneration({ userId, body: nativeSceneBody(body, ordinal), profileSelectionAuthority: "public_generator" });
    if (value.plan.videoRecipe?.workflowKey !== "redgraft-ltx25-i2v") throw Errors.conflict("Video sequences require the published RedGraft route");
    const authority = quoteAuthorityFor(value.quote, 1);
    if (!authority || !value.quote.video) throw Errors.unavailable("The native video quote is incomplete");
    resolved.push({ ordinal, authority, video: value.quote.video, supportsOptions: hasProductionVideoOptions(value.plan.profile) });
  }
  let voicePin: z.infer<typeof voicePinSchema> | null = null;
  if (body.audio === "narration") {
    if (!await featureFlagEnabled("voice_gen")) throw Errors.unavailable("English narration is currently unavailable");
    const settings = await getVoiceDefaultSettings();
    if (settings.provider !== "pocket_tts" || env.VOICE_PROVIDER !== "pocket-tts" || !["english", "en"].includes(env.POCKET_TTS_LANGUAGE.toLowerCase())) throw Errors.unavailable("English narration requires the configured Pocket TTS voice");
    const ready = await providers.voice.identity?.inspectCapabilities();
    if (!ready?.ok || !ready.data.catalogVoices?.includes(settings.defaultVoiceId)) throw Errors.unavailable("The selected English narration voice is not ready");
    voicePin = voicePinSchema.parse({ provider: "pocket_tts", voiceId: settings.defaultVoiceId, settingVersion: settings.settingVersion, language: "en", model: env.POCKET_TTS_MODEL });
  }
  const costs = resolved.map(scene => ({ ordinal: scene.ordinal, costDreamcoins: scene.authority.costDreamcoins }));
  const costDreamcoins = costs.reduce((sum, scene) => sum + scene.costDreamcoins, 0);
  const facts = { version: "video-sequence-quote-v1", requestFingerprint: requestIdentity(body), scenes: resolved, voicePin, costDreamcoins,
    audio: body.audio, narrationExtendsLastFrame: body.audio === "narration", narrationExtraCostDreamcoins: 0 };
  return { ...facts, fingerprint: canonicalJsonHash(facts), costs, balance: await dreamcoinBalance(userId),
    options: resolved.every(scene => scene.supportsOptions) ? REDGRAFT_VIDEO_OPTIONS : { seconds: [5], orientations: ["2:3"], qualities: ["standard"] } };
}

export async function createVideoSequence(userId: string, body: VideoSequenceRequest, idempotencyKey: string) {
  const fingerprint = requestIdentity(body);
  const checkReplay = (row: { requestFingerprint: string }) => { if (row.requestFingerprint !== fingerprint) throw Errors.conflict("This video request key belongs to a different sequence"); };
  const existing = await prisma.videoSequence.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
  if (existing) { checkReplay(existing); return readVideoSequence(userId, existing.id); }
  const quoted = await quoteVideoSequence(userId, body);
  if (!body.quoteFingerprint || body.quoteFingerprint !== quoted.fingerprint) throw Errors.conflict("Video sequence quote changed. Review its current price before accepting.", { reason: "video_sequence_quote_stale" });
  const result = await prisma.$transaction(async tx => {
    await lockUserLedger(tx, userId);
    const replay = await tx.videoSequence.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (replay) { checkReplay(replay); return replay; }
    if (await tx.videoSequence.count({ where: { userId, status: { in: ["generating", "composing", "unknown"] } } })) throw Errors.rateLimited("Finish or stop the existing video sequence before starting another");
    const balance = await dreamcoinBalance(userId, tx);
    if (balance < quoted.costDreamcoins) throw Errors.paymentRequired("Insufficient DreamCoins for this sequence", { required: quoted.costDreamcoins, available: balance });
    const { quoteFingerprint: _quote, ...request } = body;
    const sequence = await tx.videoSequence.create({ data: { id: randomUUID(), userId, characterId: body.characterId,
      idempotencyKey, requestFingerprint: fingerprint, request: toInputJson(request), acceptedQuote: toInputJson(quoted), audio: body.audio,
      ...(quoted.voicePin ? { voicePin: toInputJson(quoted.voicePin) } : {}) } });
    for (const [ordinal] of body.scenes.entries()) {
      const native = { ...nativeSceneBody(body, ordinal), quoteAuthority: quoted.scenes[ordinal]!.authority };
      const job = await createGenerationJobForUser(userId, native, { admissionTx: tx, sequenceId: sequence.id,
        idempotencyKey: `video-sequence:${sequence.id}:${ordinal}`, requestFingerprint: generationWriteRequestFingerprint("generation.create", native),
        source: { sourceType: "video_sequence_scene", sourceId: `${sequence.id}:${ordinal}`, sourceMeta: { sequenceId: sequence.id, ordinal } }, profileSelectionAuthority: "public_generator" });
      await tx.videoSequenceScene.create({ data: { sequenceId: sequence.id, ordinal, generationJobId: job.id } });
    }
    return sequence;
  }, { timeout: 30_000 });
  await dispatchGenerationAttemptOutbox(prisma);
  return readVideoSequence(userId, result.id);
}

export async function readVideoSequence(userId: string, id: string) {
  const row = await prisma.videoSequence.findFirst({ where: { id, userId }, include });
  if (!row) throw Errors.notFound("Video sequence not found");
  const statuses = await latestGenerationAttemptStatuses(row.scenes.map(scene => scene.generationJobId));
  const scenes = row.scenes.map(scene => ({ ordinal: scene.ordinal, job: generationJobDTO(scene.generationJob, statuses.get(scene.generationJobId) ?? null),
    narrationState: scene.narrationState, assets: scene.generationJob.assets.filter(asset => !asset.deletedAt).map(asset => ({ id: asset.id, url: `/api/v1/media/${asset.id}/content`, downloadUrl: `/api/v1/media/${asset.id}/content?download=1` })) }));
  const cost = scenes.reduce((sum, scene) => ({ charged: sum.charged + scene.job.cost.charged, refunded: sum.refunded + scene.job.cost.refunded, finalCharge: sum.finalCharge + scene.job.cost.finalCharge }), { charged: 0, refunded: 0, finalCharge: 0 });
  return { id: row.id, status: row.status, errorCode: row.errorCode, request: row.request, acceptedQuote: row.acceptedQuote, scenes, cost, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
    asset: row.mediaAsset && !row.mediaAsset.deletedAt ? { id: row.mediaAsset.id, url: `/api/v1/media/${row.mediaAsset.id}/content`, downloadUrl: `/api/v1/media/${row.mediaAsset.id}/content?download=1`, width: row.mediaAsset.width, height: row.mediaAsset.height, metadata: row.mediaAsset.metadata } : null };
}

export async function listVideoSequences(userId: string) {
  const rows = await prisma.videoSequence.findMany({ where: { userId }, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 });
  return Promise.all(rows.map(row => readVideoSequence(userId, row.id)));
}

async function stopUnstartedScenes(tx: Prisma.TransactionClient, row: SequenceRow, reason: string) {
  for (const scene of row.scenes) {
    const attempt = await tx.generationAttempt.findFirst({ where: { requestId: scene.generationJobId }, orderBy: { attemptNo: "desc" } });
    if (scene.generationJob.status !== "queued" || attempt?.startedAt || attempt?.status !== "queued") continue;
    const dispatches = await tx.mainOutboxEvent.findMany({ where: { aggregateId: scene.generationJobId, eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] } }, select: { status: true, attempts: true } });
    if (!dispatches.length || dispatches.some(dispatch => dispatch.status !== "pending" || dispatch.attempts !== 0)) continue;
    const { refundAmount } = await settleGenerationRequestCancellation(tx, { requestId: scene.generationJobId, userId: row.userId, expectSourceType: "video_sequence_scene", guard: { kind: "before_dispatch" }, reason, cancelledAt: new Date() });
    await appendGenerationEvent(tx, scene.generationJobId, "cancelled", reason, { refundAmount, sequenceId: row.id });
    if (refundAmount > 0) await appendGenerationEvent(tx, scene.generationJobId, "refunded", "Unexecuted scene Dreamcoins returned", { amount: refundAmount });
  }
}

export async function stopVideoSequence(userId: string, id: string) {
  await prisma.$transaction(async tx => {
    await lockUserLedger(tx, userId);
    await tx.$queryRaw`SELECT id FROM video_sequences WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
    const row = await tx.videoSequence.findFirst({ where: { id, userId }, include });
    if (!row) throw Errors.notFound("Video sequence not found");
    if (row.status === "completed") throw Errors.conflict("This sequence has already been delivered");
    await stopUnstartedScenes(tx, row, "Video sequence stopped by its owner");
    await tx.videoSequence.update({ where: { id }, data: { status: "cancelled", errorCode: null, compositionOwner: null, compositionLeaseAt: null } });
  });
  return readVideoSequence(userId, id);
}

export async function retryVideoComposition(userId: string, id: string) {
  const row = await prisma.videoSequence.findFirst({ where: { id, userId }, include });
  if (!row) throw Errors.notFound("Video sequence not found");
  if (row.status === "completed") return readVideoSequence(userId, id);
  if (row.status !== "composition_failed" || row.scenes.some(scene => scene.generationJob.status !== "completed")) throw Errors.conflict("Only packaging may be retried here. Native generation is never repeated.");
  await prisma.videoSequence.updateMany({ where: { id, userId, status: "composition_failed" }, data: { status: "generating", errorCode: null } });
  return readVideoSequence(userId, id);
}

async function loadAssetBytes(asset: { storageKey: string | null; url: string; metadata: unknown; deletedAt: Date | null }) {
  const locator = !asset.deletedAt && resolveMediaAssetBlobLocator(asset);
  if (!locator || !providers.blob.getPrivate) throw new Error("A delivered scene is no longer available");
  const result = await providers.blob.getPrivate({ key: locator.key });
  if (!result.ok) throw new Error("A delivered scene could not be read");
  return result.data.body;
}

async function narrationForScene(row: SequenceRow, scene: SequenceRow["scenes"][number], owner: string) {
  if (scene.narrationMediaAsset) return loadAssetBytes(scene.narrationMediaAsset);
  const pin = voicePinSchema.parse(row.voicePin);
  if (env.VOICE_PROVIDER !== "pocket-tts" || env.POCKET_TTS_MODEL !== pin.model) throw new Error("The pinned narration model is no longer configured");
  const request = videoSequenceRequestSchema.parse(row.request);
  const text = request.scenes[scene.ordinal]!.narration!;
  const requestId = `video-narration:${row.id}:${scene.ordinal}`;
  await prisma.videoSequenceScene.update({ where: { id: scene.id }, data: { narrationState: "running" } });
  const result = await createVoiceClipPortForKey(pin.provider).synthesize({ requestId, attemptNo: 1, idempotencyKey: requestId, text, voiceId: pin.voiceId });
  if (!result.ok) throw new Error(result.error.message);
  const digest = createHash("sha256").update(result.data.body).digest("hex");
  const key = `video-sequences/${row.userId}/${row.id}/${owner}/narration-${scene.ordinal}-${digest}.wav`;
  const stored = await providers.blob.putPrivate({ key, body: result.data.body, contentType: result.data.contentType });
  if (!stored.ok) throw new Error(stored.error.message);
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM video_sequences WHERE id = ${row.id} FOR UPDATE`;
      const current = await tx.videoSequence.findUnique({ where: { id: row.id } });
      if (current?.status !== "composing" || current.compositionOwner !== owner) throw new Error("Video composition ownership changed");
      const asset = await tx.mediaAsset.upsert({ where: { storageKey: key }, update: {}, create: { ownerId: row.userId, characterId: row.characterId, type: "voice", url: `blob:${key}`, storageKey: key,
        contentType: result.data.contentType, visibility: "private", safetyStatus: "passed", metadata: toInputJson({ source: "video_narration", sequenceId: row.id, ordinal: scene.ordinal, voicePin: pin, durationMs: result.data.durationMs }) } });
      await tx.videoSequenceScene.update({ where: { id: scene.id }, data: { narrationMediaAssetId: asset.id, narrationState: "completed" } });
    });
  } catch (error) {
    if (!await prisma.mediaAsset.findUnique({ where: { storageKey: key }, select: { id: true } })) {
      const removed = await providers.blob.delete({ key });
      if (!removed.ok) logger.error({ sequenceId: row.id, ordinal: scene.ordinal, error: removed.error }, "unpublished narration blob could not be removed");
    }
    throw error;
  }
  return result.data.body;
}

async function composeSequence(row: SequenceRow, owner: string) {
  const heartbeat = setInterval(() => { void prisma.videoSequence.updateMany({ where: { id: row.id, status: "composing", compositionOwner: owner }, data: { compositionLeaseAt: new Date(Date.now() + 5 * 60_000) } }).catch(error => logger.error({ error, sequenceId: row.id }, "video composition heartbeat failed")); }, 15_000);
  let key: string | null = null;
  try {
    const scenes = [];
    for (const scene of row.scenes) {
      const asset = scene.generationJob.assets.find(asset => asset.type === "video" && asset.safetyStatus === "passed" && !asset.deletedAt);
      if (!asset) throw new Error("A scene has no available delivered video");
      scenes.push({ video: await loadAssetBytes(asset), ...(row.audio === "narration" ? { narration: await narrationForScene(row, scene, owner) } : {}) });
    }
    const output = await composeVideoScenes({ scenes, audio: z.enum(["generated", "silent", "narration"]).parse(row.audio) });
    // A lost lease can only clean up its own unpublished blob, never its successor's delivery.
    key = `video-sequences/${row.userId}/${row.id}/${owner}/${createHash("sha256").update(output.bytes).digest("hex")}.mp4`;
    const stored = await providers.blob.putPrivate({ key, body: output.bytes, contentType: "video/mp4" });
    if (!stored.ok) throw new Error(stored.error.message);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM video_sequences WHERE id = ${row.id} FOR UPDATE`;
      const current = await tx.videoSequence.findUnique({ where: { id: row.id } });
      if (current?.status !== "composing" || current.compositionOwner !== owner) throw new Error("Video composition ownership changed before delivery");
      const asset = await tx.mediaAsset.upsert({ where: { storageKey: key! }, update: {}, create: { ownerId: row.userId, characterId: row.characterId, type: "video", url: `blob:${key}`, storageKey: key,
        width: output.media.width, height: output.media.height, contentType: "video/mp4", visibility: "private", safetyStatus: "passed",
        metadata: toInputJson({ source: "video_sequence", sequenceId: row.id, audio: row.audio, durationSeconds: output.media.durationSeconds, sceneDurations: output.sceneDurations,
          narrationExtendsLastFrame: row.audio === "narration", narrationIsLipSync: false, sceneGenerationJobIds: row.scenes.map(scene => scene.generationJobId) }) } });
      await tx.videoSequence.update({ where: { id: row.id }, data: { status: "completed", mediaAssetId: asset.id, errorCode: null, completedAt: new Date(), compositionOwner: null, compositionLeaseAt: null } });
    });
  } catch (error) {
    await prisma.videoSequence.updateMany({ where: { id: row.id, status: "composing", compositionOwner: owner }, data: { status: "composition_failed", errorCode: "video_composition_failed", compositionOwner: null, compositionLeaseAt: null } });
    if (key && !await prisma.mediaAsset.findUnique({ where: { storageKey: key }, select: { id: true } })) await providers.blob.delete({ key });
    logger.error({ error, sequenceId: row.id }, "video composition failed; native scenes retained");
  } finally { clearInterval(heartbeat); }
}

export async function advanceVideoSequences(limit = 10) {
  const rows = await prisma.videoSequence.findMany({ where: { status: { in: ["generating", "unknown", "composing"] } }, orderBy: { createdAt: "asc" }, take: limit, include });
  for (const row of rows) {
    if (row.status === "composing" && row.compositionLeaseAt && row.compositionLeaseAt.getTime() > Date.now()) continue;
    const statuses = await latestGenerationAttemptStatuses(row.scenes.map(scene => scene.generationJobId));
    const failed = row.scenes.find(scene => ["failed", "blocked", "cancelled", "refunded"].includes(scene.generationJob.status) || statuses.get(scene.generationJobId) === "unknown");
    if (failed) {
      await prisma.$transaction(async tx => {
        await lockUserLedger(tx, row.userId);
        await tx.$queryRaw`SELECT id FROM video_sequences WHERE id = ${row.id} FOR UPDATE`;
        await stopUnstartedScenes(tx, row, "A preceding video scene failed or needs reconciliation");
        await tx.videoSequence.updateMany({ where: { id: row.id, status: { in: ["generating", "unknown"] } }, data: { status: statuses.get(failed.generationJobId) === "unknown" ? "unknown" : "failed", errorCode: statuses.get(failed.generationJobId) === "unknown" ? "provider_outcome_unknown" : "video_scene_failed" } });
      });
      continue;
    }
    if (row.scenes.length !== videoSequenceRequestSchema.parse(row.request).scenes.length || row.scenes.some(scene => scene.generationJob.status !== "completed")) continue;
    const owner = randomUUID();
    const claimed = await prisma.videoSequence.updateMany({ where: { id: row.id, OR: [{ status: { in: ["generating", "unknown"] } }, { status: "composing", compositionLeaseAt: { lte: new Date() } }] }, data: { status: "composing", compositionOwner: owner, compositionLeaseAt: new Date(Date.now() + 5 * 60_000) } });
    if (claimed.count === 1) await composeSequence(row, owner);
  }
  await dispatchGenerationAttemptOutbox(prisma);
}
