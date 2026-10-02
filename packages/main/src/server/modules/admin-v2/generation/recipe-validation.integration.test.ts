import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { resolveImageRecipeNegative, selectRecipe } from "@/server/modules/ourdream/generation-profile-selection";
import { resolveProductionRecipe } from "@/server/modules/admin-v2/creative/run-create-authority";

// The integration seam reserves real Main Attempts/Outbox, but never consumes a provider.
vi.mock("@/server/modules/generation/generation-attempt-authority", async (original) => ({
  ...await original<typeof import("@/server/modules/generation/generation-attempt-authority")>(),
  dispatchGenerationAttemptOutbox: vi.fn(async () => undefined),
}));

describe("recipe sample validation and publication", () => {
  const prefix = `recipe-validation-${randomUUID()}`;
  const adminId = `${prefix}-admin`;
  const profileId = `${prefix}-profile`;
  const actor = { userId: adminId, role: "admin" };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active", dataClass: "internal" } });
    await prisma.generationModelProfile.create({ data: {
      id: profileId, profileKey: profileId, label: "Recipe test profile", mode: "image", runner: "comfyui",
      workflowKey: "redcraft-krea2-redmix3-txt2img", pipelineModel: "redcraft-krea2-redmix3-bf16",
      allowedOrientations: ["1:1", "4:5"], maxCount: 1, status: "active", enabled: true, rolloutPercent: 100,
    } });
  });

  afterAll(async () => {
    const jobs = await prisma.generationJob.findMany({ where: { userId: adminId }, select: { id: true } });
    const jobIds = jobs.map(job => job.id);
    const attempts = await prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } }, select: { id: true } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId: { in: attempts.map(attempt => attempt.id) } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } });
    await prisma.user.delete({ where: { id: adminId } });
    await prisma.generationRecipe.deleteMany({ where: { OR: [{ id: { startsWith: prefix } }, { recipeKey: { startsWith: prefix } }] } });
    await prisma.generationModelProfile.delete({ where: { id: profileId } });
    await prisma.$disconnect();
  });

  async function draft(label: string) {
    return prisma.generationRecipe.create({ data: {
      id: `${prefix}-${label}`, recipeKey: `${prefix}-${label}`, label,
      mode: "image", useCase: "freeplay", body: "Operator description of the recipe structure", negativeBase: "blur, watermark",
      presetOrder: [], safetyHints: {}, sampleMatrix: [
        { prompt: "A companion portrait in warm window light", orientation: "1:1" },
        { prompt: "A companion portrait in a garden", orientation: "4:5" },
      ], dryRunSummary: { source: "admin_console", status: "draft_created" }, status: "draft",
    } });
  }

  async function preview(id: string) {
    const result = await adminV2("GET", `/api/v2/admin/generation/recipes/${id}/preview?profileId=${profileId}`, actor);
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    return result.data;
  }

  async function run(id: string, fingerprint: string, idempotencyKey = randomUUID()) {
    return adminV2("POST", `/api/v2/admin/generation/recipes/${id}/commands/test-matrix`, {
      ...actor, idempotencyKey, body: { profileId, fingerprint, reason: "Validate the saved sample matrix", confirmation: id },
    });
  }

  async function verify(id: string, fingerprint: string) {
    return adminV2("POST", `/api/v2/admin/generation/recipes/${id}/commands/verify`, {
      ...actor, body: { fingerprint, reason: "Verify all persisted sample outputs", confirmation: id },
    });
  }

  async function validateAndPublish(id: string) {
    const initial = await preview(id);
    const started = await run(id, initial.fingerprint);
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(id, initial.fingerprint)).status).toBe(200);
    const result = await adminV2("POST", `/api/v2/admin/generation/recipes/${id}/commands/publish`, { ...actor, body: { reason: "Publish the verified matrix for this regression", confirmation: id } });
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    return result.data;
  }

  async function complete(jobId: string, synthetic = false) {
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } });
    const asset = await prisma.mediaAsset.create({ data: {
      ownerId: adminId, sourceJobId: jobId, type: "image", url: `https://example.test/${jobId}.png`,
      storageKey: `${prefix}/${jobId}.png`, metadata: { synthetic }, safetyStatus: "passed",
    } });
    const artifact = await prisma.generationArtifact.create({ data: {
      attemptId: attempt.id, ordinal: 0, assetId: asset.id, validationState: "valid", terminalRecordChecksum: "a".repeat(64),
    } });
    await prisma.generationDelivery.create({ data: {
      requestId: jobId, artifactId: artifact.id, targetType: "user_library", targetId: adminId, status: "delivered", deliveredAt: new Date(),
    } });
    await prisma.generationAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded", finishedAt: new Date() } });
    await prisma.generationJob.update({ where: { id: jobId }, data: { status: "completed", deliveredOutputCount: 1, completedAt: new Date() } });
    return asset.id;
  }

  it("rejects placeholder and submitted summaries instead of treating creation as a passed sample matrix", async () => {
    const recipe = await draft("unverified");
    const result = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, {
      ...actor, body: { reason: "Publish an unverified draft", confirmation: recipe.id, dryRunSummary: { status: "passed", sampleCount: 2, successRate: 1 } },
    });
    expect(result.status).toBe(400);
    expect((await prisma.generationRecipe.findUniqueOrThrow({ where: { id: recipe.id } })).status).toBe("draft");
  });

  it("withdraws a first publication and returns default requests to the prior recipe in another family", async () => {
    const previous = await selectRecipe("image", "freeplay");
    const recipe = await draft("first-publication");
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    const publication = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Publish the first version of a new family", confirmation: recipe.id } });
    expect(publication.status, JSON.stringify(publication.error)).toBe(200);
    expect(publication.data.previousActiveId).toBeNull();
    expect((await selectRecipe("image", "freeplay")).id).toBe(recipe.id);
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Restore the state before this first publication", confirmation: recipe.id } });
    expect(rollback.status, JSON.stringify(rollback.error)).toBe(200);
    expect(rollback.data).toMatchObject({ recipe: { id: recipe.id, status: "archived" }, fromVersion: 1, toVersion: null });
    expect((await selectRecipe("image", "freeplay")).id).toBe(previous.id);
    expect(await prisma.generationRecipe.count({ where: { recipeKey: recipe.recipeKey, status: "active" } })).toBe(0);
  });

  it("withdraws the first negative publication and restores generation without an optional negative recipe", async () => {
    const image = await selectRecipe("image", "freeplay");
    expect((await resolveImageRecipeNegative(image)).negativeRecipe).toBeNull();
    const recipe = await draft("first-negative-publication");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { mode: "negative", body: "duplicate cups, oversaturation" } });
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    const publication = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Enable the first optional negative recipe", confirmation: recipe.id } });
    expect(publication.status, JSON.stringify(publication.error)).toBe(200);
    expect((await resolveImageRecipeNegative(image)).negativeRecipe).toMatchObject({ recipeKey: recipe.recipeKey, version: 1 });
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Undo the first optional negative recipe", confirmation: recipe.id } });
    expect(rollback.status, JSON.stringify(rollback.error)).toBe(200);
    expect(rollback.data.toVersion).toBeNull();
    expect((await resolveImageRecipeNegative(image)).negativeRecipe).toBeNull();
  });

  it.each(["image", "negative"])("rejects a %s rollback that would break the current image/negative combination", async mode => {
    const label = `rollback-combination-${mode}`;
    try {
      const image = await draft(`${label}-base-image`);
      await prisma.generationRecipe.update({ where: { id: image.id }, data: { negativeBase: "i".repeat(50) } });
      await validateAndPublish(image.id);
      const previous = await draft(`${label}-previous`);
      await prisma.generationRecipe.update({ where: { id: previous.id }, data: {
        mode, negativeBase: mode === "image" ? "i".repeat(600) : null, body: mode === "negative" ? "n".repeat(600) : previous.body,
      } });
      await validateAndPublish(previous.id);
      const current = await draft(`${label}-current`);
      await prisma.generationRecipe.update({ where: { id: current.id }, data: {
        recipeKey: previous.recipeKey, version: 2, mode, negativeBase: mode === "image" ? "i".repeat(50) : null,
        body: mode === "negative" ? "n".repeat(50) : current.body,
      } });
      await validateAndPublish(current.id);
      const other = await draft(`${label}-other`);
      await prisma.generationRecipe.update({ where: { id: other.id }, data: {
        mode: mode === "image" ? "negative" : "image", negativeBase: mode === "negative" ? "i".repeat(600) : null,
        body: mode === "image" ? "n".repeat(600) : other.body,
      } });
      await validateAndPublish(other.id);
      const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${current.id}/commands/rollback`, { ...actor, body: { reason: "Attempt to restore an incompatible negative combination", confirmation: current.id } });
      expect(rollback.status, JSON.stringify(rollback.error)).toBe(400);
      expect(await prisma.generationRecipe.findUnique({ where: { id: current.id } })).toMatchObject({ status: "active" });
      expect(await prisma.generationRecipe.findUnique({ where: { id: previous.id } })).toMatchObject({ status: "archived" });
      await expect(resolveImageRecipeNegative(await selectRecipe("image", "freeplay"))).resolves.toBeDefined();
    } finally {
      await prisma.generationRecipe.updateMany({ where: { id: { startsWith: `${prefix}-${label}` }, mode: "negative" }, data: { status: "archived" } });
    }
  });

  it("assigns an unused target-family version when a validated draft changes its recipe key", async () => {
    const recipe = await draft("move-family");
    const target = await draft("move-target");
    await prisma.generationRecipe.update({ where: { id: target.id }, data: { status: "active" } });
    await prisma.generationRecipe.create({ data: {
      id: `${target.id}-v2`, recipeKey: target.recipeKey, label: "Retired target v2", mode: "image", useCase: "freeplay",
      body: "Existing target identity", version: 2, status: "archived", presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } });
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    const moved = await adminV2("PATCH", `/api/v2/admin/generation/recipes/${recipe.id}`, { ...actor, body: { recipeKey: target.recipeKey } });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.recipe).toMatchObject({ recipeKey: target.recipeKey, version: 3, dryRunSummary: null });
    expect(await prisma.generationRecipe.count({ where: { recipeKey: target.recipeKey, version: 1 } })).toBe(1);
    expect((await preview(recipe.id)).fingerprint).not.toBe(initial.fingerprint);
  });

  it("checks the restored use case when a later recipe version changed its use case", async () => {
    const label = "rollback-restored-usecase";
    try {
      const previous = await draft(`${label}-previous`);
      await prisma.generationRecipe.update({ where: { id: previous.id }, data: { useCase: "character", negativeBase: "i".repeat(600) } });
      await validateAndPublish(previous.id);
      const current = await draft(`${label}-current`);
      await prisma.generationRecipe.update({ where: { id: current.id }, data: { recipeKey: previous.recipeKey, version: 2, negativeBase: "i".repeat(50) } });
      await validateAndPublish(current.id);
      const fallback = await draft(`${label}-fallback`);
      await prisma.generationRecipe.update({ where: { id: fallback.id }, data: { useCase: "character", negativeBase: "i".repeat(50) } });
      await validateAndPublish(fallback.id);
      const negative = await draft(`${label}-negative`);
      await prisma.generationRecipe.update({ where: { id: negative.id }, data: { mode: "negative", useCase: "character", body: "n".repeat(600) } });
      await validateAndPublish(negative.id);
      const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${current.id}/commands/rollback`, { ...actor, body: { reason: "Attempt to restore an incompatible former use case", confirmation: current.id } });
      expect(rollback.status, JSON.stringify(rollback.error)).toBe(400);
      expect(await prisma.generationRecipe.findUnique({ where: { id: current.id } })).toMatchObject({ status: "active" });
      expect(await prisma.generationRecipe.findUnique({ where: { id: previous.id } })).toMatchObject({ status: "archived" });
    } finally {
      await prisma.generationRecipe.updateMany({ where: { id: { startsWith: `${prefix}-${label}` }, mode: "negative" }, data: { status: "archived" } });
    }
  });

  it("selects the latest published recipe across keys while preserving an explicitly pinned older key and version", async () => {
    const older = await draft("older-default");
    const recent = await draft("recent-default");
    await prisma.generationRecipe.update({ where: { id: older.id }, data: { status: "active", version: 99, publishedAt: new Date("2098-01-01") } });
    await prisma.generationRecipe.update({ where: { id: recent.id }, data: { status: "active", version: 1, publishedAt: new Date("2099-01-01") } });
    expect((await selectRecipe("image", "freeplay")).id).toBe(recent.id);
    expect((await resolveProductionRecipe(undefined, "freeplay")).id).toBe(recent.id);
    expect((await resolveProductionRecipe(older.recipeKey, "freeplay", 99)).id).toBe(older.id);
    expect(await prisma.generationRecipe.findFirst({ where: { recipeKey: older.recipeKey, version: 99, status: "active" } })).toMatchObject({ id: older.id });
    await prisma.generationRecipe.update({ where: { id: recent.id }, data: { publishedAt: new Date("2098-01-01") } });
    expect((await selectRecipe("image", "freeplay")).id).toBe(older.id);
  });

  it("previews the actual public prompt compilation without sending the operator description to the image model", async () => {
    const recipe = await draft("preview");
    const result = await preview(recipe.id);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].prompt).toContain("Requested scene: A companion portrait in warm window light");
    expect(result.samples[0].prompt).not.toContain(recipe.body);
    expect(result.samples[0].negativePrompt).toContain(recipe.negativeBase);
    expect(result.validation.status).toBe("not_run");
  });

  it("reserves one pinned job per matrix sample, replays without more jobs, and requires actual delivery before verification", async () => {
    const recipe = await draft("run");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { version: 2 } });
    const previous = await prisma.generationRecipe.create({ data: {
      id: `${recipe.id}-previous`, recipeKey: recipe.recipeKey, label: "Previously published recipe", mode: recipe.mode,
      useCase: recipe.useCase, body: "Previous recipe description", version: 1, status: "active", publishedAt: new Date(),
      presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } });
    const initial = await preview(recipe.id);
    const key = randomUUID();
    const started = await run(recipe.id, initial.fingerprint, key);
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    expect(started.data.jobs).toHaveLength(2);
    const replayed = await run(recipe.id, initial.fingerprint, key);
    expect(replayed.data.jobs.map((job: { id: string }) => job.id)).toEqual(started.data.jobs.map((job: { id: string }) => job.id));
    expect(await prisma.generationJob.count({ where: { sourceType: "admin_recipe_test", recipeId: recipe.recipeKey } })).toBe(2);
    const jobs = await prisma.generationJob.findMany({ where: { id: { in: started.data.jobs.map((job: { id: string }) => job.id) } } });
    expect(jobs.every(job => job.recipeVersion === 2 && job.profileVersion === 1 && job.provider === "comfyui" && job.costDreamcoins === 0)).toBe(true);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(400);
    await Promise.all(jobs.map(job => complete(job.id)));
    const verified = await verify(recipe.id, initial.fingerprint);
    expect(verified.status, JSON.stringify(verified.error)).toBe(200);
    expect(verified.data.validation.status).toBe("passed");
    const renamed = await adminV2("PATCH", `/api/v2/admin/generation/recipes/${recipe.id}`, { ...actor, body: { label: "Renamed after validation" } });
    expect(renamed.status).toBe(200);
    expect((await preview(recipe.id)).fingerprint).toBe(initial.fingerprint);
    const published = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "All saved matrix outputs were delivered", confirmation: recipe.id } });
    expect(published.status, JSON.stringify(published.error)).toBe(200);
    expect(published.data.recipe.status).toBe("active");
    expect(await prisma.generationRecipe.findUnique({ where: { id: previous.id } })).toMatchObject({ status: "archived" });
    const rolledBack = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Restore the prior published recipe", confirmation: recipe.id } });
    expect(rolledBack.status, JSON.stringify(rolledBack.error)).toBe(200);
    expect(rolledBack.data.recipe).toMatchObject({ id: previous.id, status: "active" });
    expect(await prisma.generationRecipe.findUnique({ where: { id: recipe.id } })).toMatchObject({ status: "archived" });
  });

  it("invalidates prior validation when generated content changes, including fields absent from the basic editor", async () => {
    for (const [field, next] of Object.entries({ body: "Revised body", negativeBase: "new negative", presetOrder: ["pose"], safetyHints: { revised: true }, sampleMatrix: [{ prompt: "Revised scene" }] })) {
      const recipe = await draft(`change-${field}`);
      await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { dryRunSummary: { source: "admin_recipe_validation", status: "passed", fingerprint: "a".repeat(64) } } });
      const result = await adminV2("PATCH", `/api/v2/admin/generation/recipes/${recipe.id}`, { ...actor, body: { [field]: next } });
      expect(result.status).toBe(200);
      expect(result.data.recipe.dryRunSummary, field).toBeNull();
    }
  });

  it("rejects stale previews and synthetic outputs even when job projections say completed", async () => {
    const recipe = await draft("synthetic");
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    await Promise.all(started.data.jobs.map((job: { id: string }) => complete(job.id, true)));
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(400);
    await adminV2("PATCH", `/api/v2/admin/generation/recipes/${recipe.id}`, { ...actor, body: { body: "Revised structure" } });
    expect((await run(recipe.id, initial.fingerprint)).status).toBe(409);
  });

  it("rechecks retained output authority at publish instead of trusting a previously passed summary", async () => {
    const recipe = await draft("deleted-output");
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    const assetIds = await Promise.all(started.data.jobs.map((job: { id: string }) => complete(job.id)));
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    await prisma.mediaAsset.update({ where: { id: assetIds[0] }, data: { deletedAt: new Date() } });
    const published = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Try publishing invalidated evidence", confirmation: recipe.id } });
    expect(published.status).toBe(400);
  });

  it("rejects rollback of a draft instead of replacing a later active version", async () => {
    const recipe = await draft("draft-rollback");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { version: 2 } });
    await prisma.generationRecipe.createMany({ data: [
      { id: `${recipe.id}-v1`, recipeKey: recipe.recipeKey, label: "Archived v1", mode: "image", useCase: "freeplay", body: "Archived body", version: 1, status: "archived", presetOrder: [], safetyHints: {}, sampleMatrix: [] },
      { id: `${recipe.id}-v3`, recipeKey: recipe.recipeKey, label: "Active v3", mode: "image", useCase: "freeplay", body: "Active body", version: 3, status: "active", presetOrder: [], safetyHints: {}, sampleMatrix: [] },
    ] });
    const result = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Attempt stale draft rollback", confirmation: recipe.id } });
    expect(result.status).toBe(400);
    expect(await prisma.generationRecipe.findUnique({ where: { id: `${recipe.id}-v3` } })).toMatchObject({ status: "active" });
  });

  it("rolls back to the actual previous live recipe instead of a newer retired version", async () => {
    const recipe = await draft("rollback-live-history");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { version: 3 } });
    await prisma.generationRecipe.createMany({ data: [
      { id: `${recipe.id}-v1`, recipeKey: recipe.recipeKey, label: "Live v1", mode: "image", useCase: "freeplay", body: "Original live recipe", version: 1, status: "active", publishedAt: new Date(), presetOrder: [], safetyHints: {}, sampleMatrix: [] },
      { id: `${recipe.id}-v2`, recipeKey: recipe.recipeKey, label: "Retired v2", mode: "image", useCase: "freeplay", body: "Already rolled back recipe", version: 2, status: "archived", publishedAt: new Date(), presetOrder: [], safetyHints: {}, sampleMatrix: [] },
    ] });
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    const publication = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Replace the actual live v1", confirmation: recipe.id } });
    expect(publication.status, JSON.stringify(publication.error)).toBe(200);
    expect(publication.data.previousActiveId).toBe(`${recipe.id}-v1`);
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Restore the actual previous live version", confirmation: recipe.id } });
    expect(rollback.status, JSON.stringify(rollback.error)).toBe(200);
    expect(rollback.data.recipe.id).toBe(`${recipe.id}-v1`);
    expect(await prisma.generationRecipe.findUnique({ where: { id: `${recipe.id}-v2` } })).toMatchObject({ status: "archived" });
  });

  it("allocates distinct recipe versions for simultaneous drafts in the same family", async () => {
    const recipeKey = `${prefix}-concurrent-create`;
    const results = await Promise.all(["First", "Second"].map(label => adminV2("POST", "/api/v2/admin/generation/recipes", { ...actor, body: {
      recipeKey, label, mode: "image", useCase: "freeplay", body: "Operator recipe description", presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } })));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.data.recipe.version).sort()).toEqual([1, 2]);
  });

  it("restores a higher-version predecessor recorded by a legacy publication audit", async () => {
    const recipe = await draft("legacy-higher-predecessor");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { version: 2 } });
    await prisma.generationRecipe.create({ data: {
      id: `${recipe.id}-v3`, recipeKey: recipe.recipeKey, label: "Live v3", mode: "image", useCase: "freeplay",
      body: "Already live higher version", version: 3, status: "active", publishedAt: new Date(), presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } });
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    const publication = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Publish the retained lower draft", confirmation: recipe.id } });
    expect(publication.status, JSON.stringify(publication.error)).toBe(200);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "generation.prompt_template.publish", targetId: recipe.id } });
    const legacySnapshot = JSON.parse(JSON.stringify(audit.before));
    delete legacySnapshot.id;
    await prisma.adminAuditLog.update({ where: { id: audit.id }, data: { before: legacySnapshot } });
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Restore the actual higher predecessor", confirmation: recipe.id } });
    expect(rollback.status, JSON.stringify(rollback.error)).toBe(200);
    expect(rollback.data.recipe.id).toBe(`${recipe.id}-v3`);
  });

  it("refuses to guess a rollback target without a publication record", async () => {
    const recipe = await draft("missing-publication");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { version: 2, status: "active" } });
    await prisma.generationRecipe.create({ data: {
      id: `${recipe.id}-v1`, recipeKey: recipe.recipeKey, label: "Unrelated archived v1", mode: "image", useCase: "freeplay",
      body: "A version number alone is not history", version: 1, status: "archived", presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } });
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Attempt unproven historical rollback", confirmation: recipe.id } });
    expect(rollback.status).toBe(404);
    expect(await prisma.generationRecipe.findUnique({ where: { id: recipe.id } })).toMatchObject({ status: "active" });
  });

  it("refuses an ambiguous legacy predecessor without changing the live recipe", async () => {
    const recipe = await draft("ambiguous-publication");
    await prisma.generationRecipe.update({ where: { id: recipe.id }, data: { version: 2 } });
    await prisma.generationRecipe.create({ data: {
      id: `${recipe.id}-v1`, recipeKey: recipe.recipeKey, label: "Live v1", mode: "image", useCase: "freeplay",
      body: "Actual predecessor", version: 1, status: "active", publishedAt: new Date(), presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } });
    const initial = await preview(recipe.id);
    const started = await run(recipe.id, initial.fingerprint);
    for (const job of started.data.jobs) await complete(job.id);
    expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    const publication = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Publish the verified draft", confirmation: recipe.id } });
    expect(publication.status, JSON.stringify(publication.error)).toBe(200);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "generation.prompt_template.publish", targetId: recipe.id } });
    const legacySnapshot = JSON.parse(JSON.stringify(audit.before));
    delete legacySnapshot.id;
    await prisma.adminAuditLog.update({ where: { id: audit.id }, data: { before: legacySnapshot } });
    await prisma.generationRecipe.create({ data: {
      id: `${recipe.id}-duplicate-v1`, recipeKey: recipe.recipeKey, label: "Duplicate old v1", mode: "image", useCase: "freeplay",
      body: "Ambiguous historical identity", version: 1, status: "archived", presetOrder: [], safetyHints: {}, sampleMatrix: [],
    } });
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/rollback`, { ...actor, body: { reason: "Attempt ambiguous historical rollback", confirmation: recipe.id } });
    expect(rollback.status).toBe(409);
    expect(await prisma.generationRecipe.findUnique({ where: { id: recipe.id } })).toMatchObject({ status: "active" });
  });

  it("serializes different recipe publications and retains their real predecessor even when it has a higher version", async () => {
    const first = await draft("concurrent-publish-first");
    const second = await draft("concurrent-publish-second");
    await prisma.generationRecipe.update({ where: { id: first.id }, data: { version: 2 } });
    await prisma.generationRecipe.update({ where: { id: second.id }, data: { recipeKey: first.recipeKey, version: 3 } });
    await prisma.generationRecipe.create({ data: { id: `${first.id}-v1`, recipeKey: first.recipeKey, label: "Live v1", mode: "image", useCase: "freeplay", body: "Prior live recipe", version: 1, status: "active", publishedAt: new Date(), presetOrder: [], safetyHints: {}, sampleMatrix: [] } });
    for (const recipe of [first, second]) {
      const initial = await preview(recipe.id);
      const started = await run(recipe.id, initial.fingerprint);
      for (const job of started.data.jobs) await complete(job.id);
      expect((await verify(recipe.id, initial.fingerprint)).status).toBe(200);
    }
    const results = await Promise.all([first, second].map(recipe => adminV2("POST", `/api/v2/admin/generation/recipes/${recipe.id}/commands/publish`, { ...actor, body: { reason: "Publish the separately verified recipe", confirmation: recipe.id } })));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const live = await prisma.generationRecipe.findMany({ where: { recipeKey: first.recipeKey, status: "active" } });
    expect(live).toHaveLength(1);
    const expected = results.find(result => result.data.recipe.id === live[0].id)!.data.previousActiveId;
    expect([first.id, second.id]).toContain(expected);
    const rollback = await adminV2("POST", `/api/v2/admin/generation/recipes/${live[0].id}/commands/rollback`, { ...actor, body: { reason: "Restore the publication predecessor", confirmation: live[0].id } });
    expect(rollback.status, JSON.stringify(rollback.error)).toBe(200);
    expect(rollback.data.recipe.id).toBe(expected);
  });

  it("rejects a preview whose test profile parameters changed before matrix submission", async () => {
    const recipe = await draft("profile-changed-after-preview");
    const initial = await preview(recipe.id);
    const original = await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: profileId } });
    try {
      await prisma.generationModelProfile.update({ where: { id: profileId }, data: { steps: original.steps + 1 } });
      expect((await run(recipe.id, initial.fingerprint)).status).toBe(409);
    } finally {
      await prisma.generationModelProfile.update({ where: { id: profileId }, data: { steps: original.steps } });
    }
  });
});
