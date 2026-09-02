import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { generationTerminalRecordChecksum, generationTerminalRecordSchema } from "@idream/shared/contracts";
import sharp from "sharp";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createMedia, createUser, dreamcoinBalance, expectError, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import { quoteAuthorityFor } from "./generation-quote";
import { buildGenerationAttemptQueueInput } from "@/server/modules/generation/attempt-dispatch";
import { parseMediaEnhancementQuoteResponse } from "@/lib/public-api-contracts";
import { selectGenerationProfile } from "./generation-profile-selection";
import { ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";

const P = "zt-media-enhance-";
const owner = `${P}owner`;
const stranger = `${P}stranger`;
const sourceId = `${P}source`;
const sourceKey = `test-fixtures/${sourceId}.png`;
const profileId = "seed-profile-image-enhance-2x-v1";
let installedProfile = false;
let installedRecipe = false;
async function rollout() {
  if (process.env.APP_ENV !== "test") throw new Error("Test rollout requires the test runtime");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await client.query(await readFile(new URL("../../../../../../db/sql/2026-09-02-image-enhance-2x.sql", import.meta.url), "utf8")); }
  finally { await client.end(); }
}
let sourceBytes: Buffer;
async function quote() {
  const response = await api("POST", `media/${sourceId}/enhance/quote`, { userId: owner, ageGate: true, body: { scale: 2 } });
  expectOk(response);
  return parseMediaEnhancementQuoteResponse(response.json);
}
async function submit(key: string, authority?: ReturnType<typeof quoteAuthorityFor>) {
  const selected = authority ?? quoteAuthorityFor((await quote()).quote, 1);
  return api("POST", `media/${sourceId}/enhance`, { userId: owner, ageGate: true, headers: { "Idempotency-Key": key }, body: { scale: 2, quoteAuthority: selected } });
}
async function generatedBytes(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31 + Math.floor(i / (width * 3)) * 17) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
async function runWithOutput(width = 160, height = 120) {
  const gen = await generationTestProviders();
  const mock = vi.spyOn(gen.image, "generate").mockResolvedValue({ ok: true, data: { assets: [{ key: "enhanced.png", body: await generatedBytes(width, height), contentType: "image/png", width, height }] } });
  try { await runQueuedGenerationJobs(); } finally { mock.mockRestore(); }
  return mock;
}
beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: owner });
  await createUser({ id: stranger });
  await grantCoins(owner, 100);
  sourceBytes = await generatedBytes(80, 60);
  await providers.blob.putPrivate({ key: sourceKey, body: sourceBytes, contentType: "image/png" });
  await createCharacter({ id: `${P}character`, creatorId: owner, visibility: "private" });
  await prisma.character.update({ where: { id: `${P}character` }, data: { status: "archived" } });
  await prisma.generationJob.create({ data: { id: `${P}historical`, userId: owner, characterId: `${P}character`, mode: "image", prompt: "Original historical portrait", controls: {}, presetIds: [], status: "completed", profileId: "historical-profile", profileVersion: 7, recipeId: "historical-recipe", recipeVersion: 3 } });
  await createMedia({ id: sourceId, ownerId: owner, storageKey: sourceKey, contentType: "image/png", sourceJobId: `${P}historical` });
  await prisma.mediaAsset.update({ where: { id: sourceId }, data: { width: 80, height: 60, characterId: `${P}character` } });
  if (!await prisma.pricingRule.findFirst({ where: { mode: "image", status: "active" } })) {
    await prisma.pricingRule.create({ data: { id: `${P}price`, ruleKey: `${P}price`, label: "Enhance price", mode: "image", baseCost: 2, status: "active" } });
  }
  installedProfile = !await prisma.generationModelProfile.findFirst({ where: { profileKey: "image-enhance-2x" } });
  installedRecipe = !await prisma.generationRecipe.findFirst({ where: { recipeKey: "image-enhance-2x" } });
  await rollout();
  await rollout();
});
afterAll(async () => {
  await purgeTestData(P);
  await providers.blob.delete({ key: sourceKey });
  if (installedProfile) await prisma.generationModelProfile.deleteMany({ where: { id: profileId } });
  if (installedRecipe) await prisma.generationRecipe.deleteMany({ where: { id: "seed-recipe-image-enhance-2x-v1" } });
  await prisma.pricingRule.deleteMany({ where: { id: { startsWith: P } } });
});

describe("Gallery image enhancement authority", () => {
  it("quotes an owned source at exactly 2× without changing or charging it", async () => {
    const result = await api("POST", `media/${sourceId}/enhance/quote`, { userId: owner, ageGate: true, body: { scale: 2 } });
    expectOk(result);
    expect(result.data.enhancement).toEqual({ sourceMediaId: sourceId, scale: 2, sourceWidth: 80, sourceHeight: 60, width: 160, height: 120 });
    expect(result.data.quote).toMatchObject({ profileId: "image-enhance-2x", orientations: ["original"], maxCount: 1 });
    expect(() => parseMediaEnhancementQuoteResponse({ ...result.json, data: { ...result.data, enhancement: { ...result.data.enhancement, width: 159 } } })).toThrow();
    expect(await prisma.generationJob.count({ where: { userId: owner, sourceType: "media_enhance" } })).toBe(0);
  });

  it("rejects another user's source and non-2× operations before reserving", async () => {
    expectError(await api("POST", `media/${sourceId}/enhance/quote`, { userId: stranger, ageGate: true, body: { scale: 2 } }), 404);
    expectError(await api("POST", `media/${sourceId}/enhance/quote`, { userId: owner, ageGate: true, body: { scale: 4 } }), 400);
  });

  it("reserves once, pins exactly one source, and delivers a new 2× image with historical provenance", async () => {
    const quoted = await quote();
    const authority = quoteAuthorityFor(quoted.quote, 1);
    const before = await dreamcoinBalance(owner);
    const [first, repeated] = await Promise.all([submit(`${P}single`, authority), submit(`${P}single`, authority)]);
    expectOk(first, 202); expectOk(repeated, 202);
    expect(first.data.job.id).toBe(repeated.data.job.id);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: first.data.job.id } });
    expect(job).toMatchObject({ sourceType: "media_enhance", characterId: `${P}character`, visualProfileId: null, outputCount: 1, orientation: "original" });
    expect(job.sourceMeta).toMatchObject({ sourceMediaId: sourceId, sourceGeneration: { jobId: `${P}historical`, profileId: "historical-profile", profileVersion: 7, recipeVersion: 3 } });
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: job.id } });
    if (!attempt.provider) throw new Error("Reserved enhancement has no provider");
    const queued = await buildGenerationAttemptQueueInput(job, { ...attempt, provider: attempt.provider });
    expect(queued.payload).toMatchObject({ count: 1, model: "realesrgan-x2plus-enhance", controls: { width: 160, height: 120, enhancement: { sourceMediaId: sourceId, sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"), scale: 2 } }, referenceImages: [{ assetId: sourceId, role: "source_image" }] });
    expect(await dreamcoinBalance(owner)).toBe(before - quoted.quote.costs[0]!.costDreamcoins);
    await runWithOutput();
    const detail = await api("GET", `generation/jobs/${job.id}`, { userId: owner, ageGate: true });
    expectOk(detail);
    expect(detail.data.job.status).toBe("completed");
    expect(detail.data.assets).toHaveLength(1);
    expect(detail.data.assets[0]).toMatchObject({ width: 160, height: 120, enhancement: { sourceMediaId: sourceId, scale: 2 } });
    expect(detail.data.assets[0].id).not.toBe(sourceId);
    expect(await prisma.generationArtifact.count({ where: { attemptId: attempt.id } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: job.id, reason: "generation_spend" } })).toBe(1);
    expect((await providers.blob.getPrivate!({ key: sourceKey })).ok).toBe(true);
    const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: sourceId } });
    expect(stored).toMatchObject({ width: 80, height: 60, sourceJobId: `${P}historical` });
    expectOk(await submit(`${P}single`, authority), 202);
    expectError(await api("POST", `media/${sourceId}-other/enhance`, { userId: owner, ageGate: true, headers: { "Idempotency-Key": `${P}single` }, body: { scale: 2, quoteAuthority: authority } }), 409);
  });

  it("replays concurrent submissions when the first one consumes the entire balance", async () => {
    const quoted = await quote();
    const authority = quoteAuthorityFor(quoted.quote, 1)!;
    await grantCoins(owner, authority.costDreamcoins - await dreamcoinBalance(owner), "enhance_exact_balance");
    const results = await Promise.all([submit(`${P}exact-balance`, authority), submit(`${P}exact-balance`, authority)]);
    for (const result of results) expectOk(result, 202);
    expect(results[0].data.job.id).toBe(results[1].data.job.id);
    expect(await dreamcoinBalance(owner)).toBe(0);
    await runWithOutput();
    await grantCoins(owner, 100);
  });

  it("rejects a changed source, stale quote and unavailable model without another reservation", async () => {
    const quoted = await quote();
    const authority = quoteAuthorityFor(quoted.quote, 1)!;
    const before = await dreamcoinBalance(owner);
    expectError(await submit(`${P}stale-price`, { ...authority, costDreamcoins: authority.costDreamcoins + 1 }), 409);
    await providers.blob.putPrivate({ key: sourceKey, body: await sharp(sourceBytes).negate().png().toBuffer(), contentType: "image/png" });
    try { expectError(await submit(`${P}changed-hash`, authority), 409); }
    finally { await providers.blob.putPrivate({ key: sourceKey, body: sourceBytes, contentType: "image/png" }); }
    await providers.blob.putPrivate({ key: sourceKey, body: await generatedBytes(60, 80), contentType: "image/png" });
    try { expectError(await submit(`${P}changed-source`, authority), 409); }
    finally { await providers.blob.putPrivate({ key: sourceKey, body: sourceBytes, contentType: "image/png" }); }
    await prisma.generationModelProfile.update({ where: { id: profileId }, data: { enabled: false } });
    try {
      expectError(await submit(`${P}disabled`, authority), 409);
      await expect(rollout()).rejects.toThrow("differs from the exact released authority");
    }
    finally { await prisma.generationModelProfile.update({ where: { id: profileId }, data: { enabled: true } }); }
    expect(await dreamcoinBalance(owner)).toBe(before);
    await expect(selectGenerationProfile({ mode: "image", requested: "image-enhance-2x" })).rejects.toMatchObject({ status: 409 });
  });

  it("rechecks source ownership and availability at dispatch without changing the pinned image", async () => {
    const submitted = await submit(`${P}dispatch-source`); expectOk(submitted, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: submitted.data.job.id } });
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: job.id } });
    if (!attempt.provider) throw new Error("Reserved enhancement has no provider");
    await prisma.mediaAsset.update({ where: { id: sourceId }, data: { ownerId: stranger } });
    try { await expect(buildGenerationAttemptQueueInput(job, { ...attempt, provider: attempt.provider })).rejects.toMatchObject({ code: "not_found" }); }
    finally { await prisma.mediaAsset.update({ where: { id: sourceId }, data: { ownerId: owner } }); }
    await runWithOutput();
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("completed");
  });

  it("refunds invalid output once and retries with the same source pin and one new charge", async () => {
    const before = await dreamcoinBalance(owner);
    const first = await submit(`${P}failed`); expectOk(first, 202);
    await runWithOutput(80, 60);
    const failed = await api("GET", `generation/jobs/${first.data.job.id}`, { userId: owner, ageGate: true });
    expectOk(failed);
    expect(failed.data.job).toMatchObject({ status: "failed", errorCode: "enhancement_output_invalid" });
    expect(failed.data.assets).toEqual([]);
    expect(await dreamcoinBalance(owner)).toBe(before);
    const failedAttempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: first.data.job.id } });
    if (!failedAttempt.terminalRecordRef) throw new Error("Failed enhancement lacks durable terminal evidence");
    const storedTerminal = await providers.blob.getPrivate!({ key: failedAttempt.terminalRecordRef });
    if (!storedTerminal.ok) throw new Error("Failed enhancement terminal cannot be read");
    const terminalRecord = generationTerminalRecordSchema.parse(JSON.parse(Buffer.from(storedTerminal.data.body).toString("utf8")));
    await expect(ingestGenerationTerminalRecord({ terminalRecord, terminalRecordRef: failedAttempt.terminalRecordRef, terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord) })).resolves.toMatchObject({ status: "duplicate" });
    expect(await dreamcoinBalance(owner)).toBe(before);
    await prisma.mediaAsset.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
    try { expectError(await api("POST", `generation/jobs/${first.data.job.id}/retry/quote`, { userId: owner, ageGate: true }), 404); }
    finally { await prisma.mediaAsset.update({ where: { id: sourceId }, data: { deletedAt: null } }); }
    const retry = await api("POST", `generation/jobs/${first.data.job.id}/retry`, { userId: owner, ageGate: true, headers: { "Idempotency-Key": `${P}retry` } });
    expectOk(retry, 202);
    const replay = await api("POST", `generation/jobs/${first.data.job.id}/retry`, { userId: owner, ageGate: true, headers: { "Idempotency-Key": `${P}retry` } });
    expectOk(replay, 202); expect(replay.data.job.id).toBe(retry.data.job.id);
    await runWithOutput();
    const result = await api("GET", `generation/jobs/${retry.data.job.id}`, { userId: owner, ageGate: true });
    expectOk(result); expect(result.data.job.status).toBe("completed");
    expect(result.data.assets[0].enhancement).toEqual({ sourceMediaId: sourceId, scale: 2 });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: first.data.job.id, reason: "refund" } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: retry.data.job.id, reason: "generation_spend" } })).toBe(1);
  });
});
