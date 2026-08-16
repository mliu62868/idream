// SPEC: the Generation catalogue authority — prompt recipes (versioned, publishable) and the
//       built-in preset library the customer-facing generation UI offers.
// INTENT: migrated from v1 `generation/catalog-admin.ts`. Recipes keep their draft → active →
//         archived lifecycle; presets have no versions, so they only ever get edited in place.
// INVARIANT: only `scope: "built_in"` presets are visible here. User and community presets
//            belong to their owners and are not operator-editable content.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
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
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { adminRequestId, assertTargetConfirmation } from "./model-profiles";

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
      const updated = await tx.generationRecipe.update({
        where: { id: recipeId },
        data: {
          recipeKey: body.recipeKey,
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
      const dryRunSummary = body.dryRunSummary
        ? toInputJson(body.dryRunSummary)
        : template.dryRunSummary;
      if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");
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
      const previous = await tx.generationRecipe.findFirst({
        where: {
          recipeKey: current.recipeKey,
          status: "archived",
          version: { lt: current.version },
        },
        orderBy: { version: "desc" },
        select: { id: true },
      });
      if (!previous) throw Errors.notFound("No previous template version to roll back to");
      await tx.generationRecipe.updateMany({
        where: { recipeKey: current.recipeKey, status: "active" },
        data: { status: "archived", archivedAt: new Date() },
      });
      const restored = await tx.generationRecipe.update({
        where: { id: previous.id },
        data: { status: "active", publishedAt: new Date(), archivedAt: null },
      });
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
        toVersion: restored.version,
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
    recipeKey: recipe.recipeKey,
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
