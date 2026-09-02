import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generationProviderIdempotencyKey, generationTerminalFinalizeDedupeKey, generationTerminalRecordChecksum, idempotencyKeys, MAIN_QUEUES, videoGeneratePayloadSchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { characterReleaseSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE } from "@/server/modules/generation/production-video-profile";
import { createGenerationJobForUser } from "./generation-job-create";
import { quoteAuthorityFor, quoteGeneration } from "./generation-quote";
import { generationJobSchema } from "./generation-request-schema";
import { quoteGenerationRetry, resolveGenerationRetryTarget, retryGenerationJobForUser } from "./generation-job-retry";
import { dispatchPendingGenerationTerminalRecords, ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";

const prefix = `video-audience-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const otherId = `${prefix}-other`;
const characterId = `${prefix}-private`;
const sourceAssetId = `${prefix}-source`;
const createdConfig: { profile?: string; recipe?: string; pricing?: string } = {};
let priorFlag: { enabled: boolean; rolloutPercent: number } | null = null;
const body = generationJobSchema.parse({ mode: "video", characterId, freeplay: false, consistencyMode: "balanced", outputCount: 1, controls: {} });

beforeAll(async () => {
  await prisma.user.createMany({ data: [ownerId, otherId].map((id) => ({ id, email: `${id}@example.test`, dataClass: "customer" })) });
  await prisma.entitlement.createMany({ data: [ownerId, otherId].map((userId) => ({ userId, key: "video_generation", value: true, source: "test" })) });
  for (const userId of [ownerId, otherId]) await prisma.$transaction((tx) => postDreamcoinEntry(tx, {
    kind: "signup_bonus", userId, amount: 200, sourceId: `${userId}-bonus`, idempotencyKey: `${userId}:bonus`,
  }));
  const flag = await prisma.featureFlag.findUnique({ where: { key: "video_gen" } });
  priorFlag = flag ? { enabled: flag.enabled, rolloutPercent: flag.rolloutPercent } : null;
  await prisma.featureFlag.upsert({ where: { key: "video_gen" }, create: { key: "video_gen", label: "Video generation", targetRoles: [], targetPlans: [], enabled: true, rolloutPercent: 100 }, update: { enabled: true, rolloutPercent: 100 } });
  const authority = PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE;
  if (!await prisma.generationModelProfile.findFirst({ where: { profileKey: authority.profileKey, version: authority.version } })) {
    createdConfig.profile = `${prefix}-profile`;
    await prisma.generationModelProfile.create({ data: { id: createdConfig.profile, ...authority, label: "Video audience fixture", mode: "video", costMultiplier: 1, enabled: true, status: "active", publishedAt: new Date() } });
  }
  if (!await prisma.generationRecipe.findFirst({ where: { mode: "video", useCase: "character", status: "active" } })) {
    createdConfig.recipe = `${prefix}-recipe`;
    await prisma.generationRecipe.create({ data: { id: createdConfig.recipe, recipeKey: createdConfig.recipe, label: "Character video fixture", mode: "video", useCase: "character", body: "Animate the Character portrait.", negativeBase: "flicker", presetOrder: [], safetyHints: {}, sampleMatrix: [], dryRunSummary: {}, status: "active", publishedAt: new Date() } });
  }
  if (!await prisma.pricingRule.findFirst({ where: { mode: "video", status: "active" } })) {
    createdConfig.pricing = `${prefix}-pricing`;
    await prisma.pricingRule.create({ data: { id: createdConfig.pricing, ruleKey: createdConfig.pricing, label: "Video fixture price", mode: "video", baseCost: 100, status: "active" } });
  }
  await prisma.character.create({ data: { id: characterId, creatorId: ownerId, source: "user", name: "Owner's private Character", age: 28, description: "A private Character with a confirmed image", visibility: "private", status: "approved", appearance: {}, advancedDetails: {} } });
  await prisma.mediaAsset.create({ data: { id: sourceAssetId, ownerId, characterId, type: "image", url: `/user-content/${sourceAssetId}.webp`, storageKey: `${sourceAssetId}.webp`, contentType: "image/webp", visibility: "private", safetyStatus: "passed", metadata: {} } });
  await prisma.character.update({ where: { id: characterId }, data: { imageAssetId: sourceAssetId } });
});

afterAll(async () => {
  const jobs = await prisma.generationJob.findMany({ where: { userId: { in: [ownerId, otherId] } }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  const attempts = await prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } } });
  for (const attempt of attempts) {
    await jobQueue.removeByDedupeKey("ai.video.generate", idempotencyKeys.generationAttempt(attempt.requestId, attempt.attemptNo));
    await jobQueue.removeByDedupeKey(MAIN_QUEUES.aiFinalize, generationTerminalFinalizeDedupeKey(attempt.id));
  }
  await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: { in: attempts.map((attempt) => attempt.id) } } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [...jobIds, ...attempts.map((attempt) => attempt.id)] } } });
  await prisma.generationSettlementLink.deleteMany({ where: { requestId: { in: jobIds } } });
  await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attempts.map((attempt) => attempt.id) } } });
  await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
  await prisma.generationJobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.mediaAsset.deleteMany({ where: { id: sourceAssetId } });
  await prisma.dreamcoinLedger.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  if (createdConfig.profile) await prisma.generationModelProfile.delete({ where: { id: createdConfig.profile } });
  if (createdConfig.recipe) await prisma.generationRecipe.delete({ where: { id: createdConfig.recipe } });
  if (createdConfig.pricing) await prisma.pricingRule.delete({ where: { id: createdConfig.pricing } });
  if (priorFlag) await prisma.featureFlag.update({ where: { key: "video_gen" }, data: priorFlag });
  else await prisma.featureFlag.deleteMany({ where: { key: "video_gen" } });
  await prisma.$disconnect();
});

describe("Character video audience at quote and reservation", () => {
  it("quotes, dispatches and retries a private owner's video once while retaining the exact primary image", async () => {
    const { plan, quote } = await quoteGeneration({ userId: ownerId, body, profileSelectionAuthority: "public_generator" });
    expect(plan.requestedSourceImageAssetId).toBe(sourceAssetId);
    expect(quote.costs).toEqual([{ outputCount: 1, costDreamcoins: 100 }]);
    const quoteAuthority = quoteAuthorityFor(quote, 1);
    expect(quoteAuthority).not.toBeNull();
    const input = { ...body, quoteAuthority: quoteAuthority! };
    const options = { idempotencyKey: `${prefix}:owner-video`, profileSelectionAuthority: "public_generator" as const };
    const job = await createGenerationJobForUser(ownerId, input, options);
    expect(await createGenerationJobForUser(ownerId, input, options)).toMatchObject({ id: job.id });
    expect(job).toMatchObject({ status: "queued", mode: "video", characterId, costDreamcoins: 100, provider: "comfyui", controls: expect.objectContaining({ sourceImageAssetId: sourceAssetId, seconds: 5 }) });
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: job.id } });
    expect(attempt).toMatchObject({ attemptNo: 1, status: "queued", profileKey: PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE.profileKey });
    expect(await prisma.generationAttempt.count({ where: { requestId: job.id } })).toBe(1);
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: `generation_initial_${job.id}` } })).toMatchObject({ status: "delivered" });
    const queued = await jobQueue.getByDedupeKey("ai.video.generate", idempotencyKeys.generationAttempt(job.id, 1));
    expect(queued).toMatchObject({ payload: expect.objectContaining({ generationJobId: job.id, attemptId: attempt.id }) });
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId: ownerId, reason: "generation_spend" }, select: { sourceId: true, delta: true } })).toEqual([{ sourceId: job.id, delta: -100 }]);
    expect(await prisma.generationTransportExecution.count({ where: { attemptId: attempt.id } })).toBe(0);

    // Provider execution stays off. Its canonical non-invoked failure exercises
    // the real finalizer before the user asks to retry the same private Character.
    const payload = videoGeneratePayloadSchema.parse(queued!.payload);
    const terminalRecord = {
      version: 1 as const, attemptId: attempt.id, attemptNo: attempt.attemptNo,
      transportAttemptNo: queued!.maxAttempts,
      providerIdempotencyKey: generationProviderIdempotencyKey(attempt.id),
      requestId: payload.requestId, generationJobId: job.id,
      mode: "video" as const, provider: payload.provider!, model: payload.model,
      providerInvoked: false, providerRequestId: null, completedAt: new Date().toISOString(), usage: {},
      outcome: "failed" as const,
      error: { code: "preparation_failed", message: "Input preparation failed", retryability: "retryable" as const },
    };
    const envelope = { terminalRecord, terminalRecordRef: `gen/terminal-records/${attempt.id}/terminal.json`, terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord) };
    await expect(ingestGenerationTerminalRecord(envelope)).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
    await dispatchPendingGenerationTerminalRecords();
    await drainLocalAiPipeline();
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", errorCode: "preparation_failed" });
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId: ownerId, reason: "refund" }, select: { sourceId: true, delta: true } })).toEqual([{ sourceId: job.id, delta: 100 }]);

    const retryInput = { userId: ownerId, generationJobId: job.id, idempotencyKey: `${prefix}:retry` };
    const target = await resolveGenerationRetryTarget(retryInput);
    if (target.kind !== "retryable") throw new Error("Expected a failed video to be retryable");
    const { quote: retryQuote } = await quoteGenerationRetry(retryInput);
    const retryAuthority = quoteAuthorityFor(retryQuote, 1)!;
    await prisma.character.update({ where: { id: characterId }, data: { imageAssetId: null } });
    try {
      await expect(retryGenerationJobForUser({ ...retryInput, job: target.job, quoteAuthority: retryAuthority }))
        .rejects.toMatchObject({ status: 409, message: "Character primary image changed before video retry authority could be reserved" });
      expect(await prisma.generationJob.count({ where: { derivedFromJobId: job.id } })).toBe(0);
      expect(await prisma.dreamcoinLedger.count({ where: { userId: ownerId, reason: "generation_spend" } })).toBe(1);
    } finally {
      await prisma.character.update({ where: { id: characterId }, data: { imageAssetId: sourceAssetId } });
    }
    const retry = await retryGenerationJobForUser({ ...retryInput, job: target.job, quoteAuthority: retryAuthority });
    expect(retry).toMatchObject({ derivedFromJobId: job.id, status: "queued", controls: expect.objectContaining({ sourceImageAssetId: sourceAssetId }) });
    expect(await resolveGenerationRetryTarget(retryInput)).toMatchObject({ kind: "replay", job: { id: retry.id } });
    expect(await prisma.generationAttempt.count({ where: { requestId: retry.id } })).toBe(1);
    const retryAttempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: retry.id } });
    expect(await jobQueue.getByDedupeKey("ai.video.generate", idempotencyKeys.generationAttempt(retry.id, 1))).toMatchObject({ state: "waiting", payload: expect.objectContaining({ generationJobId: retry.id }) });
    expect(await prisma.dreamcoinLedger.count({ where: { userId: ownerId, reason: "generation_spend" } })).toBe(2);
    expect(await prisma.generationTransportExecution.count({ where: { attemptId: { in: [attempt.id, retryAttempt.id] } } })).toBe(0);
  });

  it("rejects another user at quote and submit without reserving or charging", async () => {
    await expect(quoteGeneration({ userId: otherId, body, profileSelectionAuthority: "public_generator" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    const { quote } = await quoteGeneration({ userId: ownerId, body, profileSelectionAuthority: "public_generator" });
    await expect(createGenerationJobForUser(otherId, { ...body, quoteAuthority: quoteAuthorityFor(quote, 1)! }, { idempotencyKey: `${prefix}:forbidden`, profileSelectionAuthority: "public_generator" }))
      .rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await prisma.generationJob.count({ where: { userId: otherId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: otherId, reason: "generation_spend" } })).toBe(0);
  });

  it("allows a qualified live unlisted Release by direct access", async () => {
    const rolledBack = new Error("completed unlisted video fixture");
    await expect(prisma.$transaction(async (tx) => {
      const id = `${prefix}-unlisted`;
      const assetId = `${id}-image`;
      await tx.character.create({ data: { id, creatorId: ownerId, source: "official", name: "Unlisted Character", age: 28, description: "Qualified direct access", visibility: "unlisted", status: "approved", appearance: {}, advancedDetails: {} } });
      await tx.mediaAsset.create({ data: { id: assetId, ownerId, characterId: id, type: "image", url: `/user-content/${assetId}.webp`, storageKey: `${assetId}.webp`, visibility: "public_pack", safetyStatus: "passed", metadata: { seedSource: prefix, synthetic: false, platformAsset: { status: "approved" } } } });
      const project = await tx.characterProject.create({ data: { characterId: id } });
      const content = await tx.characterContentVersion.create({ data: { characterId: id, version: 1, contentHash: id, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" } });
      await tx.character.update({ where: { id }, data: { imageAssetId: assetId, currentContentVersionId: content.id } });
      const revision = await tx.characterRevision.create({ data: { projectId: project.id, revision: 1, characterContentVersionId: content.id, projectSnapshot: {} } });
      const snapshot = { projectId: project.id, revisionId: revision.id, characterContentVersionId: content.id, visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null,
        generationProvenance: { schemaVersion: "character-release-editorial-import-v1", recordId: id, dataset: prefix, sourceAssetId: assetId },
        releasePlacementManifest: { schemaVersion: 1, kind: "editorial_import", placements: [{ slotKey: "character_avatar", assetId, slotVersion: 1 }] } };
      const release = await tx.characterRelease.create({ data: { ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot), readiness: "ready", legacy: true, status: "published", publishedAt: new Date() } });
      await tx.publicCatalogQualification.create({ data: { releaseId: release.id, releaseSnapshotHash: release.snapshotHash, kind: "editorial_import", evidence: { schemaVersion: "public-catalog-qualification-v1", policyVersion: "public-catalog-editorial-import-v1", characterId: id, sourceAssetId: assetId, checks: { exactSeedRecord: true, nonSynthetic: true, safetyPassed: true, publicPack: true, imageAvailable: true } } } });
      await tx.characterServing.create({ data: { characterId: id, currentReleaseId: release.id, state: "live" } });
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      // Execute the real audience query inside the rollback fixture so immutable
      // qualification evidence is verified without leaving a public test record.
      const binding = vi.spyOn(prisma.character, "findFirst").mockImplementation(tx.character.findFirst);
      try {
        const { plan, quote } = await quoteGeneration({ userId: otherId, body: { ...body, characterId: id }, profileSelectionAuthority: "public_generator" });
        expect(plan.character?.id).toBe(id);
        expect(plan.requestedSourceImageAssetId).toBe(assetId);
        expect(quote.costs).toEqual([{ outputCount: 1, costDreamcoins: 100 }]);
      } finally { binding.mockRestore(); }
      throw rolledBack;
    })).rejects.toBe(rolledBack);
  });
});
