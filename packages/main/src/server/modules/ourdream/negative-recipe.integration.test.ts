import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser, grantCoins, purgeTestData } from "@/server/test/helpers";
import { createGenerationJobForUser } from "./generation-job-create";
import { defaultImageNegativePrompt, imageNegativePrompt } from "./generation-prompt";
import { generationJobSchema } from "./generation-request-schema";
import { quoteAuthorityFor, quoteGeneration } from "./generation-quote";

// Reserve real Jobs, Attempts and Outbox records without dispatching a provider.
vi.mock("@/server/modules/generation/generation-attempt-authority", async original => ({
  ...await original<typeof import("@/server/modules/generation/generation-attempt-authority")>(),
  dispatchGenerationAttemptOutbox: vi.fn(async () => undefined),
}));

describe("production negative recipe consumption", () => {
  const prefix = `negative-recipe-${randomUUID()}`;
  const adminId = `${prefix}-admin`;
  const profileId = `${prefix}-profile`;
  const imageId = `${prefix}-image`;
  const actor = { userId: adminId, role: "admin" };
  const body = generationJobSchema.parse({ mode: "image", freeplay: true, prompt: "A ceramic cup in daylight", model: profileId, orientation: "1:1", outputCount: 1 });

  beforeAll(async () => {
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await prisma.generationModelProfile.create({ data: {
      id: profileId, profileKey: profileId, label: "Negative recipe route", mode: "image", runner: "comfyui",
      workflowKey: "redqw21", pipelineModel: "redcraft-krea2-redmix3-fp8",
      runnerConfig: { workflowVersion: 2, capabilities: { textToImage: true, referenceImages: false, initImage: false } },
      allowedOrientations: ["1:1"], maxCount: 1, status: "active", enabled: true, rolloutPercent: 100,
    } });
    await prisma.generationRecipe.create({ data: {
      id: imageId, recipeKey: imageId, label: "Default image recipe", mode: "image", useCase: "freeplay",
      body: "Operator description", negativeBase: "blur, jpeg artifacts", presetOrder: [], safetyHints: {}, sampleMatrix: [],
      status: "active", publishedAt: new Date("2099-01-01"),
    } });
  });

  beforeEach(async () => {
    await prisma.generationRecipe.updateMany({ where: { id: { startsWith: prefix }, mode: "negative" }, data: { status: "archived" } });
  });

  afterAll(async () => {
    await purgeTestData(prefix);
    await prisma.$disconnect();
  });

  async function customer(label: string) {
    const id = `${prefix}-${label}`;
    await createUser({ id, dataClass: "internal" });
    await prisma.entitlement.create({ data: { userId: id, key: "premium_controls", value: true, source: "test" } });
    await grantCoins(id, 1000, "seed");
    return id;
  }

  async function negative(label: string, text: string, options: { version?: number; publishedAt?: string; useCase?: string; status?: string; recipeKey?: string } = {}) {
    return prisma.generationRecipe.create({ data: {
      id: `${prefix}-${label}`, recipeKey: options.recipeKey ?? `${prefix}-${label}`, label, mode: "negative", useCase: options.useCase ?? "freeplay",
      body: text, negativeBase: "not used for a negative recipe", presetOrder: [], safetyHints: {},
      sampleMatrix: [{ prompt: "A ceramic cup in daylight", orientation: "1:1" }],
      status: options.status ?? "active", version: options.version ?? 1, publishedAt: new Date(options.publishedAt ?? "2099-01-01"),
    } });
  }

  async function quote(userId: string) {
    return (await quoteGeneration({ userId, body, profileSelectionAuthority: "public_generator" })).quote;
  }

  async function submit(userId: string, quoted?: Awaited<ReturnType<typeof quote>>) {
    const selected = quoted ?? await quote(userId);
    return createGenerationJobForUser(userId, { ...body, quoteAuthority: quoteAuthorityFor(selected, 1)! }, {
      idempotencyKey: randomUUID(), profileSelectionAuthority: "public_generator", source: { sourceType: "generator", sourceId: randomUUID(), sourceMeta: { origin: "preserved" } },
    });
  }

  async function completeSample(jobId: string) {
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } });
    const asset = await prisma.mediaAsset.create({ data: {
      ownerId: adminId, sourceJobId: jobId, type: "image", url: `https://example.test/${jobId}.png`, storageKey: `${prefix}/${jobId}.png`, metadata: { synthetic: false }, safetyStatus: "passed",
    } });
    const artifact = await prisma.generationArtifact.create({ data: { attemptId: attempt.id, ordinal: 0, assetId: asset.id, validationState: "valid", terminalRecordChecksum: "b".repeat(64) } });
    await prisma.generationDelivery.create({ data: { requestId: jobId, artifactId: artifact.id, targetType: "user_library", targetId: adminId, status: "delivered", deliveredAt: new Date() } });
    await prisma.generationAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded", finishedAt: new Date() } });
    await prisma.generationJob.update({ where: { id: jobId }, data: { status: "completed", deliveredOutputCount: 1, completedAt: new Date() } });
  }

  it("preserves the previous image negative prompt and source metadata when no negative recipe is active", async () => {
    const userId = await customer("legacy");
    const job = await submit(userId);
    expect(job.recipeId).toBe(imageId);
    expect(job.negativePrompt).toBe(imageNegativePrompt(defaultImageNegativePrompt("blur, jpeg artifacts"), null));
    expect(job.sourceMeta).toEqual({ origin: "preserved" });
  });

  it("uses the latest same-use-case negative publication across keys and records its immutable inputs", async () => {
    await negative("older-negative", "old oversaturation", { version: 99, publishedAt: "2098-01-01" });
    const current = await negative("current-negative", "blur, duplicate cups");
    await negative("character-negative", "wrong character-only exclusions", { useCase: "character", publishedAt: "2100-01-01" });
    const job = await submit(await customer("latest"));
    expect(job.negativePrompt).toContain("jpeg artifacts");
    expect(job.negativePrompt).toContain("duplicate cups");
    expect(job.negativePrompt).not.toContain("old oversaturation");
    expect(job.negativePrompt).not.toContain("character-only");
    expect(job.negativePrompt?.split(",").filter(term => term.trim() === "blur")).toHaveLength(1);
    expect(job.sourceMeta).toMatchObject({ origin: "preserved", negativeRecipe: { recipeKey: current.recipeKey, version: 1, body: current.body } });
  });

  it("keeps an explicit image recipe in a Creative Run while composing the same active negative recipe", async () => {
    const current = await negative("creative-negative", "duplicate cups");
    const explicit = await prisma.generationRecipe.create({ data: {
      id: `${prefix}-explicit-image`, recipeKey: `${prefix}-explicit-image`, label: "Explicit image", mode: "image", useCase: "freeplay",
      body: "Explicit operator description", negativeBase: "washed out", presetOrder: [], safetyHints: {}, sampleMatrix: [], status: "active", version: 7, publishedAt: new Date("2098-01-01"),
    } });
    const created = await adminV2("POST", "/api/v2/admin/creative/runs", { ...actor, body: {
      purpose: "feed", targetType: "none", profileId, recipeId: explicit.recipeKey, count: 1, orientation: "1:1", brief: "A ceramic cup in daylight", reason: "Verify explicit image and shared negative composition",
    } });
    expect(created.status, JSON.stringify(created.error)).toBe(202);
    const job = await prisma.generationJob.findFirstOrThrow({ where: { userId: adminId, sourceType: "content_production_item" } });
    expect(job).toMatchObject({ recipeId: explicit.recipeKey, recipeVersion: 7 });
    expect(job.negativePrompt).toContain("washed out");
    expect(job.negativePrompt).toContain("duplicate cups");
    expect(job.sourceMeta).toMatchObject({ negativeRecipe: { recipeKey: current.recipeKey, version: 1, body: current.body }, promptRecipeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("rejects a combined negative recipe that exceeds the production base budget instead of silently dropping its tail", async () => {
    const current = await negative("oversized-negative", "Exclusion ".repeat(67) + "critical final exclusion");
    expect(current.body.length).toBeLessThanOrEqual(700);
    expect(`blur, jpeg artifacts, ${current.body}`.length).toBeGreaterThan(700);
    const userId = await customer("oversized-negative");
    await expect(quote(userId)).rejects.toMatchObject({ status: 400 });
    const preview = await adminV2("GET", `/api/v2/admin/generation/recipes/${current.id}/preview?profileId=${profileId}`, actor);
    expect(preview.status).toBe(400);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
  });

  it("validates a negative draft using the active image recipe, publishes it, and rejects a quote for the previous negative version", async () => {
    const previous = await negative("negative-v1", "old oversaturation");
    const replacement = await negative("negative-v2", "duplicate cups", { version: 2, recipeKey: previous.recipeKey, status: "draft" });
    const userId = await customer("publish-change");
    const oldQuote = await quote(userId);
    const preview = await adminV2("GET", `/api/v2/admin/generation/recipes/${replacement.id}/preview?profileId=${profileId}`, actor);
    expect(preview.status, JSON.stringify(preview.error)).toBe(200);
    expect(preview.data.samples[0].negativePrompt).toContain("jpeg artifacts");
    expect(preview.data.samples[0].negativePrompt).toContain("duplicate cups");
    expect(preview.data.samples[0].negativePrompt).not.toContain("old oversaturation");
    const started = await adminV2("POST", `/api/v2/admin/generation/recipes/${replacement.id}/commands/test-matrix`, { ...actor, body: { profileId, fingerprint: preview.data.fingerprint, confirmation: replacement.id, reason: "Run the negative draft against production image defaults" } });
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    const sampleJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: started.data.jobs[0].id } });
    expect(sampleJob).toMatchObject({ recipeId: imageId, recipeVersion: 1 });
    expect(sampleJob.sourceMeta).toMatchObject({ negativeRecipe: { recipeKey: replacement.recipeKey, version: 2, body: replacement.body } });
    await completeSample(sampleJob.id);
    const verified = await adminV2("POST", `/api/v2/admin/generation/recipes/${replacement.id}/commands/verify`, { ...actor, body: { fingerprint: preview.data.fingerprint, confirmation: replacement.id, reason: "Verify the delivered negative recipe sample" } });
    expect(verified.status, JSON.stringify(verified.error)).toBe(200);
    const published = await adminV2("POST", `/api/v2/admin/generation/recipes/${replacement.id}/commands/publish`, { ...actor, body: { confirmation: replacement.id, reason: "Publish the verified negative version" } });
    expect(published.status, JSON.stringify(published.error)).toBe(200);
    await expect(submit(userId, oldQuote)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    const job = await submit(userId);
    expect(job.negativePrompt).toContain("duplicate cups");
    expect(job.negativePrompt).not.toContain("old oversaturation");
    expect(job.sourceMeta).toMatchObject({ negativeRecipe: { recipeKey: replacement.recipeKey, version: 2, body: replacement.body } });
  });

  it("binds the selected negative body, key and version into the existing quote fingerprint", async () => {
    const current = await negative("fingerprint-negative", "duplicate cups");
    const userId = await customer("fingerprint");
    for (const update of [{ body: "extra cups" }, { version: 2 }, { recipeKey: `${prefix}-renamed-negative-key` }]) {
      const before = await quote(userId);
      await prisma.generationRecipe.update({ where: { id: current.id }, data: update });
      expect((await quote(userId)).routeFingerprint).not.toBe(before.routeFingerprint);
      await expect(submit(userId, before)).rejects.toMatchObject({ status: 409 });
    }
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
  });
});
