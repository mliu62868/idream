// SPEC: the Generation catalogue authority — prompt recipes (versioned, publishable) and the
//       built-in preset library the customer-facing generation UI offers.
// INTENT: migrated from v1 `generation/catalog-admin.ts`. Recipes keep their draft → active →
//         archived lifecycle; presets have no versions, so they only ever get edited in place.
// INVARIANT: only `scope: "built_in"` presets are visible here. User and community presets
//            belong to their owners and are not operator-editable content.
import { Prisma } from "@prisma/client";
import { generationRecipeTestMatrixResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { dispatchGenerationAttemptOutbox, reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { jsonRecord, toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { adminRequestId, assertTargetConfirmation } from "./model-profiles";
import { inspectRecipeValidation, loadRecipeMatrix, recipeFingerprint } from "./recipe-validation";
import { findActiveRecipe, resolveImageRecipeNegative } from "@/server/modules/ourdream/generation-profile-selection";

const DEFAULT_CATALOG_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Prompt recipes
// ---------------------------------------------------------------------------

type RecipeRow = Prisma.GenerationRecipeGetPayload<Record<string, never>>;

function recipeView(recipe: RecipeRow) {
  return {
    id: recipe.id,
    recipeKey: recipe.recipeKey,
    label: recipe.label,
    mode: recipe.mode,
    useCase: recipe.useCase,
    body: recipe.body,
    negativeBase: recipe.negativeBase,
    presetOrder: recipe.presetOrder,
    safetyHints: recipe.safetyHints,
    sampleMatrix: recipe.sampleMatrix,
    dryRunSummary: recipe.dryRunSummary ?? null,
    version: recipe.version,
    status: recipe.status,
    publishedAt: recipe.publishedAt?.toISOString() ?? null,
    archivedAt: recipe.archivedAt?.toISOString() ?? null,
    createdAt: recipe.createdAt.toISOString(),
    updatedAt: recipe.updatedAt.toISOString(),
  };
}

export async function listGenerationRecipes(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/recipes");
  const limit = query.limit ?? DEFAULT_CATALOG_PAGE_SIZE;
  const queryIdentity = {
    mode: query.mode,
    status: query.status,
    search: query.search,
    sort: "label_asc",
  };
  const [cursorLabel, cursorId] = labelCursor(query.cursor, "generation_recipes", queryIdentity);
  const recipes = await prisma.generationRecipe.findMany({
    where: {
      mode: query.mode,
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { id: { contains: query.search, mode: "insensitive" as const } },
              { label: { contains: query.search, mode: "insensitive" as const } },
              { recipeKey: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(cursorLabel !== null && cursorId !== null
        ? {
            AND: [{
              OR: [
                { label: { gt: cursorLabel } },
                { label: cursorLabel, id: { gt: cursorId } },
              ],
            }],
          }
        : {}),
    },
    orderBy: [{ label: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  return labelPage(recipes, limit, "generation_recipes", queryIdentity, recipeView);
}

export async function getGenerationRecipe(request: Request, recipeId: string) {
  await actorWithPermission(request, "generation.config.read");
  const recipe = await prisma.generationRecipe.findUnique({ where: { id: recipeId } });
  if (!recipe) throw Errors.notFound("Generation recipe not found");
  return { recipe: recipeView(recipe) };
}

export async function createGenerationRecipe(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationRecipeCreateRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.prompt_template.create",
    target: { type: "generation_prompt_template", id: body.recipeKey },
    payload: body,
    mutate: async (tx) => {
      const latest = await tx.generationRecipe.findFirst({
        where: { recipeKey: body.recipeKey },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const recipe = await tx.generationRecipe.create({
        data: {
          recipeKey: body.recipeKey,
          label: body.label,
          mode: body.mode,
          useCase: body.useCase,
          body: body.body,
          negativeBase: body.negativeBase ?? null,
          presetOrder: toInputJson(body.presetOrder),
          safetyHints: toInputJson(body.safetyHints),
          sampleMatrix: toInputJson(body.sampleMatrix),
          dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
          version: (latest?.version ?? 0) + 1,
          status: "draft",
        },
      });
      await writeCatalogAudit(tx, actor, requestId, {
        action: "generation.prompt_template.create",
        targetType: "generation_prompt_template",
        targetId: recipe.id,
        after: recipeAuditSnapshot(recipe),
      });
      return { recipe: recipeView(recipe) };
    },
  });
}

export async function patchGenerationRecipe(request: Request, recipeId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationRecipePatchRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.prompt_template.update",
    target: { type: "generation_prompt_template", id: recipeId },
    payload: body,
    mutate: async (tx) => {
      const before = await tx.generationRecipe.findUnique({ where: { id: recipeId } });
      if (!before) throw Errors.notFound("Prompt template not found");
      if (before.status !== "draft") throw Errors.badRequest("Only draft templates can be edited");
      const movingFamily = body.recipeKey !== undefined && body.recipeKey !== before.recipeKey;
      const latest = movingFamily ? await tx.generationRecipe.findFirst({
        where: { recipeKey: body.recipeKey }, orderBy: { version: "desc" }, select: { version: true },
      }) : null;
      let updated = await tx.generationRecipe.update({
        where: { id: recipeId },
        data: {
          recipeKey: body.recipeKey,
          version: movingFamily ? (latest?.version ?? 0) + 1 : undefined,
          label: body.label,
          mode: body.mode,
          useCase: body.useCase,
          body: body.body,
          negativeBase: body.negativeBase,
          presetOrder: body.presetOrder ? toInputJson(body.presetOrder) : undefined,
          safetyHints: body.safetyHints ? toInputJson(body.safetyHints) : undefined,
          sampleMatrix: body.sampleMatrix ? toInputJson(body.sampleMatrix) : undefined,
          dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
        },
      });
      if (recipeFingerprint(updated) !== recipeFingerprint(before)) {
        updated = await tx.generationRecipe.update({ where: { id: recipeId }, data: { dryRunSummary: Prisma.DbNull } });
      }
      await writeCatalogAudit(tx, actor, requestId, {
        action: "generation.prompt_template.update",
        targetType: "generation_prompt_template",
        targetId: recipeId,
        before: recipeAuditSnapshot(before),
        after: recipeAuditSnapshot(updated),
      });
      return { recipe: recipeView(updated) };
    },
  });
}

export async function publishGenerationRecipe(request: Request, recipeId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationPublishCommandRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.prompt_template.publish",
    target: { type: "generation_prompt_template", id: recipeId },
    payload: body,
    mutate: async (tx) => {
      const template = await tx.generationRecipe.findUnique({ where: { id: recipeId } });
      if (!template) throw Errors.notFound("Prompt template not found");
      assertTargetConfirmation(body.confirmation, template.id);
      if (template.status !== "draft") {
        throw Errors.badRequest("Only draft templates can be published");
      }
      // Submitted JSON is not generation evidence. Recheck the persisted matrix's exact jobs.
      const summary = jsonRecord(template.dryRunSummary);
      if (summary.source !== "admin_recipe_validation" || summary.status !== "passed" || typeof summary.profileId !== "string") {
        throw Errors.badRequest("Run and verify the saved sample matrix before publishing this recipe.");
      }
      const validation = await inspectRecipeValidation(tx, await loadRecipeMatrix(tx, template.id, summary.profileId, actor.id));
      if (validation.status !== "passed") throw Errors.badRequest("Recipe validation is no longer valid. Run and verify the saved matrix again.", { validation });
      const dryRunSummary = template.dryRunSummary ?? Prisma.DbNull;
      const previous = await tx.generationRecipe.findFirst({
        where: { recipeKey: template.recipeKey, status: "active" },
      });
      await tx.generationRecipe.updateMany({
        where: { recipeKey: template.recipeKey, status: "active" },
        data: { status: "archived", archivedAt: new Date() },
      });
      const published = await tx.generationRecipe.update({
        where: { id: recipeId },
        data: {
          status: "active",
          dryRunSummary,
          publishedAt: new Date(),
          archivedAt: null,
        },
      });
      await writeCatalogAudit(tx, actor, requestId, {
        action: "generation.prompt_template.publish",
        targetType: "generation_prompt_template",
        targetId: recipeId,
        reason: body.reason,
        before: previous ? recipeAuditSnapshot(previous) : null,
        after: recipeAuditSnapshot(published),
      });
      return { recipe: recipeView(published), previousActiveId: previous?.id ?? null };
    },
  });
}

export async function previewGenerationRecipe(request: Request, recipeId: string) {
  const actor = await actorWithPermission(request, "generation.config.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/recipes/:id/preview");
  const matrix = await loadRecipeMatrix(prisma, recipeId, query.profileId, actor.id);
  return {
    fingerprint: matrix.fingerprint, profileId: matrix.profile.id,
    samples: matrix.samples.map(({ index, prompt, negativePrompt, orientation, issues }) => ({ index, prompt, negativePrompt, orientation, issues })),
    issues: matrix.issues,
    validation: await inspectRecipeValidation(prisma, matrix),
  };
}

export async function testGenerationRecipeMatrix(request: Request, recipeId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationRecipeTestMatrixRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  const result = generationRecipeTestMatrixResponseSchema.parse(await executeAtomicIdempotentMutation({
    environment: env.APP_ENV, actor, idempotencyKey: requireIdempotencyKey(request), requestId,
    commandType: "generation.prompt_template.test_matrix", target: { type: "generation_prompt_template", id: recipeId }, payload: body,
    mutate: async (tx) => {
      assertTargetConfirmation(body.confirmation, recipeId);
      const matrix = await loadRecipeMatrix(tx, recipeId, body.profileId, actor.id);
      if (matrix.recipe.status !== "draft") throw Errors.badRequest("Only draft recipes can run validation samples.");
      if (matrix.fingerprint !== body.fingerprint) throw Errors.versionConflict("Recipe inputs changed after preview. Refresh the preview before running samples.");
      const issues = [...matrix.issues, ...matrix.samples.flatMap(sample => sample.issues)];
      if (issues.length) throw Errors.badRequest("The saved sample matrix needs corrections before it can run.", { issues });
      if ((await inspectRecipeValidation(tx, matrix)).status === "running") throw Errors.conflict("The current sample matrix is still running. Refresh its results.");
      const jobs: { id: string; sampleIndex: number; status: string }[] = [];
      for (const sample of matrix.samples) {
        const job = await tx.generationJob.create({ data: {
          userId: actor.id, characterId: sample.characterId, mode: matrix.mode, prompt: sample.prompt, negativePrompt: sample.negativePrompt,
          controls: toInputJson({
            orientation: sample.orientation, model: matrix.profile.profileKey, profileId: matrix.profile.profileKey,
            width: sample.dimensions.width, height: sample.dimensions.height, adminTest: true,
            sourceImageAssetId: sample.sourceImageAssetId,
            ...(matrix.recipe.useCase === "enhance" ? { enhancementScale: 2 } : {}),
          }),
          referenceAssetIds: sample.sourceImageAssetId ? [sample.sourceImageAssetId] : undefined,
          presetIds: [], model: matrix.profile.pipelineModel, profileId: matrix.profile.profileKey, profileVersion: matrix.profile.version,
          recipeId: matrix.productionRecipe.recipeKey, recipeVersion: matrix.productionRecipe.version, orientation: sample.orientation,
          outputCount: 1, status: "queued", costDreamcoins: 0, provider: matrix.profile.runner,
          sourceType: "admin_recipe_test", sourceId: `${recipeId}:${requestId}:${sample.index}`,
          sourceMeta: toInputJson({ recipeRecordId: recipeId, fingerprint: matrix.fingerprint, profileFingerprint: matrix.profileFingerprint, sampleIndex: sample.index,
            ...(matrix.recipeNegative?.negativeRecipe ? { negativeRecipe: matrix.recipeNegative.negativeRecipe, promptRecipeFingerprint: matrix.recipeNegative.promptRecipeFingerprint } : {}),
          }),
        } });
        await tx.generationJobEvent.createMany({ data: ["created", "queued"].map(type => ({ jobId: job.id, type, message: "Admin recipe sample accepted", metadata: { recipeId, sampleIndex: sample.index } })) });
        await reserveInitialGenerationAttempt(tx, { requestId: job.id, dispatch: { outboxId: `generation_initial_${job.id}`, eventType: "generation.retry.dispatch.v2", payload: { source: "admin_recipe_test" } } });
        jobs.push({ id: job.id, sampleIndex: sample.index, status: job.status });
      }
      await tx.generationRecipe.update({ where: { id: recipeId }, data: { dryRunSummary: toInputJson({
        source: "admin_recipe_validation", status: "queued", fingerprint: matrix.fingerprint,
        profileId: matrix.profile.id, profileFingerprint: matrix.profileFingerprint, jobIds: jobs.map(job => job.id),
        ranBy: actor.id, ranAt: new Date().toISOString(),
      }) } });
      await writeCatalogAudit(tx, actor, requestId, { action: "generation.prompt_template.test_matrix", targetType: "generation_prompt_template", targetId: recipeId, reason: body.reason, after: { fingerprint: matrix.fingerprint, jobIds: jobs.map(job => job.id) } });
      return { fingerprint: matrix.fingerprint, jobs };
    },
  }));
  await dispatchGenerationAttemptOutbox(prisma, { outboxIds: result.jobs.map(job => `generation_initial_${job.id}`) });
  return ok(result, { status: 202 });
}

export async function verifyGenerationRecipe(request: Request, recipeId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationRecipeVerifyRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV, actor, idempotencyKey: requireIdempotencyKey(request), requestId,
    commandType: "generation.prompt_template.verify", target: { type: "generation_prompt_template", id: recipeId }, payload: body,
    mutate: async (tx) => {
      assertTargetConfirmation(body.confirmation, recipeId);
      const recipe = await tx.generationRecipe.findUnique({ where: { id: recipeId } });
      if (!recipe) throw Errors.notFound("Generation recipe not found");
      if (recipe.status !== "draft") throw Errors.badRequest("Only draft recipes can record validation.");
      const summary = jsonRecord(recipe.dryRunSummary);
      if (typeof summary.profileId !== "string") throw Errors.badRequest("Run the saved sample matrix before verifying results.");
      const matrix = await loadRecipeMatrix(tx, recipeId, summary.profileId, actor.id);
      if (matrix.fingerprint !== body.fingerprint) throw Errors.versionConflict("Recipe inputs changed after preview. Refresh before verifying results.");
      const validation = await inspectRecipeValidation(tx, matrix);
      if (validation.status !== "ready" && validation.status !== "passed") throw Errors.badRequest("Every saved matrix sample needs a verified generated output and library delivery.", { validation });
      await tx.generationRecipe.update({ where: { id: recipeId }, data: { dryRunSummary: toInputJson({ ...summary, status: "passed", verifiedBy: actor.id, verifiedAt: new Date().toISOString() }) } });
      await writeCatalogAudit(tx, actor, requestId, { action: "generation.prompt_template.verify", targetType: "generation_prompt_template", targetId: recipeId, reason: body.reason, after: { fingerprint: matrix.fingerprint, sampleCount: matrix.samples.length, status: "passed" } });
      return { validation: { ...validation, status: "passed" } };
    },
  });
}

export async function rollbackGenerationRecipe(request: Request, recipeId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationConfigCommandRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.prompt_template.rollback",
    target: { type: "generation_prompt_template", id: recipeId },
    payload: body,
    mutate: async (tx) => {
      const current = await tx.generationRecipe.findUnique({ where: { id: recipeId } });
      if (!current) throw Errors.notFound("Prompt template not found");
      assertTargetConfirmation(body.confirmation, current.id);
      if (current.status !== "active") throw Errors.badRequest("Only the active recipe version can be rolled back.");
      // INVARIANT: publication order can differ from version order after rollback.
      // Audit history survives operator deletion; command receipts do not.
      const publication = await tx.adminAuditLog.findFirst({
        where: {
          action: "generation.prompt_template.publish",
          targetType: "generation_prompt_template",
          targetId: current.id,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { before: true },
      });
      if (!publication) {
        throw Errors.notFound("No recorded previous published template to roll back to");
      }
      let previous: RecipeRow | null = null;
      if (publication.before !== null) {
        const prior = jsonRecord(publication.before);
        if (prior.recipeKey !== current.recipeKey || prior.status !== "active" || typeof prior.version !== "number" || !Number.isInteger(prior.version) || prior.version < 1) {
          throw Errors.notFound("No recorded previous published template to roll back to");
        }
        // Older snapshots lack ids. Refuse ambiguous history rather than guessing.
        const candidates = await tx.generationRecipe.findMany({
          where: {
            recipeKey: current.recipeKey, version: prior.version, status: "archived",
            ...(typeof prior.id === "string" ? { id: prior.id } : {}),
          },
          take: 2,
        });
        if (candidates.length > 1) throw Errors.conflict("The recorded previous template version is ambiguous");
        previous = candidates[0] ?? null;
        if (!previous) throw Errors.notFound("No previous template version to roll back to");
      }
      await tx.generationRecipe.updateMany({
        where: { recipeKey: current.recipeKey, status: "active" },
        data: { status: "archived", archivedAt: new Date() },
      });
      // A first publication restores this family's previous absence of an active recipe.
      const restored = previous ? await tx.generationRecipe.update({
        where: { id: previous.id },
        data: { status: "active", publishedAt: new Date(), archivedAt: null },
      }) : await tx.generationRecipe.findUniqueOrThrow({ where: { id: current.id } });
      // INVARIANT: reverting one family must not break the current image/negative pair.
      // Check the effective post-rollback selection before committing either change.
      const affectedUseCases = new Set([current, previous].flatMap(recipe =>
        recipe && recipe.useCase !== "enhance" && (recipe.mode === "image" || recipe.mode === "negative") ? [recipe.useCase] : []));
      for (const useCase of affectedUseCases) {
        const image = await findActiveRecipe("image", useCase, tx);
        if (image) await resolveImageRecipeNegative(image, tx);
      }
      await writeCatalogAudit(tx, actor, requestId, {
        action: "generation.prompt_template.rollback",
        targetType: "generation_prompt_template",
        targetId: current.id,
        reason: body.reason,
        before: recipeAuditSnapshot(current),
        after: recipeAuditSnapshot(restored),
      });
      return {
        recipe: recipeView(restored),
        fromVersion: current.version,
        toVersion: previous?.version ?? null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

type PresetRow = Prisma.GenerationPresetGetPayload<Record<string, never>>;

function presetView(preset: PresetRow) {
  return {
    id: preset.id,
    scope: preset.scope,
    type: preset.type,
    category: preset.category,
    label: preset.label,
    controls: preset.controls,
    visibility: preset.visibility,
    status: preset.status,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

export async function listGenerationPresets(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/presets");
  const limit = query.limit ?? DEFAULT_CATALOG_PAGE_SIZE;
  const queryIdentity = {
    type: query.type,
    status: query.status,
    search: query.search,
    sort: "label_asc",
  };
  const [cursorLabel, cursorId] = labelCursor(query.cursor, "generation_presets", queryIdentity);
  const presets = await prisma.generationPreset.findMany({
    where: {
      scope: "built_in",
      type: query.type,
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { id: { contains: query.search, mode: "insensitive" as const } },
              { label: { contains: query.search, mode: "insensitive" as const } },
              { category: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(cursorLabel !== null && cursorId !== null
        ? {
            AND: [{
              OR: [
                { label: { gt: cursorLabel } },
                { label: cursorLabel, id: { gt: cursorId } },
              ],
            }],
          }
        : {}),
    },
    orderBy: [{ label: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  return labelPage(presets, limit, "generation_presets", queryIdentity, presetView);
}

export async function getGenerationPreset(request: Request, presetId: string) {
  await actorWithPermission(request, "generation.config.read");
  const preset = await prisma.generationPreset.findUnique({ where: { id: presetId } });
  if (!preset || preset.scope !== "built_in") throw Errors.notFound("Built-in preset not found");
  return { preset: presetView(preset) };
}

export async function createGenerationPreset(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationPresetCreateRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.preset.create",
    target: { type: "generation_preset", id: body.label },
    payload: body,
    mutate: async (tx) => {
      const preset = await tx.generationPreset.create({
        data: {
          scope: "built_in",
          type: body.type,
          category: body.category,
          label: body.label,
          controls: toInputJson(body.controls),
          visibility: body.visibility,
          status: body.status,
        },
      });
      await writeCatalogAudit(tx, actor, requestId, {
        action: "generation.preset.create",
        targetType: "generation_preset",
        targetId: preset.id,
        after: { type: preset.type, label: preset.label, status: preset.status },
      });
      return { preset: presetView(preset) };
    },
  });
}

export async function patchGenerationPreset(request: Request, presetId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationPresetPatchRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.preset.update",
    target: { type: "generation_preset", id: presetId },
    payload: body,
    mutate: async (tx) => {
      const before = await tx.generationPreset.findUnique({ where: { id: presetId } });
      if (!before || before.scope !== "built_in") {
        throw Errors.notFound("Built-in preset not found");
      }
      const preset = await tx.generationPreset.update({
        where: { id: presetId },
        data: {
          type: body.type,
          category: body.category,
          label: body.label,
          controls: body.controls ? toInputJson(body.controls) : undefined,
          visibility: body.visibility,
          status: body.status,
        },
      });
      await writeCatalogAudit(tx, actor, requestId, {
        action: "generation.preset.update",
        targetType: "generation_preset",
        targetId: presetId,
        before: { type: before.type, label: before.label, status: before.status },
        after: { type: preset.type, label: preset.label, status: preset.status },
      });
      return { preset: presetView(preset) };
    },
  });
}

// ---------------------------------------------------------------------------
// Shared label-ordered paging
// ---------------------------------------------------------------------------

function labelCursor(
  cursor: string | undefined,
  scope: string,
  queryIdentity: unknown,
): [string | null, string | null] {
  if (!cursor) return [null, null];
  const keys = decodeAdminListCursor(cursor, scope, queryIdentity);
  const [label, id] = keys;
  if (typeof label !== "string" || typeof id !== "string" || !id) {
    throw Errors.badRequest(`${scope} cursor key is invalid`);
  }
  return [label, id];
}

function labelPage<Row extends { label: string; id: string }, View>(
  rows: readonly Row[],
  limit: number,
  scope: string,
  queryIdentity: unknown,
  view: (row: Row) => View,
) {
  const hasNextPage = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(view),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor(scope, queryIdentity, [last.label, last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

function recipeAuditSnapshot(recipe: RecipeRow) {
  return {
    id: recipe.id,
    recipeKey: recipe.recipeKey,
    label: recipe.label,
    mode: recipe.mode,
    useCase: recipe.useCase,
    version: recipe.version,
    status: recipe.status,
  };
}

async function writeCatalogAudit(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  requestId: string,
  input: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason?: string;
    readonly before?: unknown;
    readonly after?: unknown;
  },
) {
  await tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      before: input.before === undefined ? undefined : toInputJson(input.before),
      after: input.after === undefined ? undefined : toInputJson(input.after),
      requestId,
    },
  });
}
