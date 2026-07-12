import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

const recipeSchema = z.object({
  recipeKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video", "negative"]).default("image"),
  useCase: z.enum(["character", "freeplay", "negative"]).default("character"),
  body: z.string().trim().min(1).max(12_000),
  negativeBase: z.string().trim().max(4_000).nullable().optional(),
  presetOrder: z.array(z.string()).max(20).default([]),
  safetyHints: z.record(z.string(), z.unknown()).default({}),
  sampleMatrix: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const recipePatchSchema = recipeSchema.partial();

const publishSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const rollbackSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const presetAdminSchema = z.object({
  type: z.enum(["background", "pose", "outfit", "mode"]),
  category: z.string().max(80).optional(),
  label: z.string().trim().min(1).max(80),
  controls: z.record(z.string(), z.unknown()).default({}),
  visibility: z.enum(["private", "public", "unlisted"]).default("public"),
  status: z.enum(["active", "archived"]).default("active"),
});
function assertTargetConfirmation(value: string, targetId: string) {
  if (value !== targetId)
    throw Errors.badRequest("Confirmation did not match target");
}
export async function listRecipes(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { mode, status, search, sort: "label_asc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(
        url.searchParams.get("cursor")!,
        "generation_recipes",
        queryIdentity,
      )
    : null;
  const [cursorLabel, cursorId] = cursorKeys
    ? z.tuple([z.string(), z.string().min(1)]).parse(cursorKeys)
    : [null, null];
  const templates = await prisma.generationRecipe.findMany({
    where: {
      mode,
      status,
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: "insensitive" } },
              { label: { contains: search, mode: "insensitive" } },
              { recipeKey: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(cursorLabel && cursorId
        ? {
            AND: [
              {
                OR: [
                  { label: { gt: cursorLabel } },
                  { label: cursorLabel, id: { gt: cursorId } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ label: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const hasNextPage = templates.length > limit;
  const page = templates.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor:
        hasNextPage && last
          ? encodeAdminListCursor("generation_recipes", queryIdentity, [
              last.label,
              last.id,
            ])
          : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function getRecipe(request: Request, id: string) {
  await actorWithPermission(request, "generation.config.read");
  const recipe = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!recipe) throw Errors.notFound("Generation recipe not found");
  return ok({ recipe });
}

export async function createRecipe(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = recipeSchema.parse(await jsonBody(request));
  const latest = await prisma.generationRecipe.findFirst({
    where: { recipeKey: body.recipeKey },
    orderBy: { version: "desc" },
  });
  const template = await prisma.generationRecipe.create({
    data: {
      ...body,
      negativeBase: body.negativeBase ?? null,
      presetOrder: toInputJson(body.presetOrder),
      safetyHints: toInputJson(body.safetyHints),
      sampleMatrix: toInputJson(body.sampleMatrix),
      dryRunSummary: body.dryRunSummary
        ? toInputJson(body.dryRunSummary)
        : undefined,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
    },
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.create",
    targetType: "generation_prompt_template",
    targetId: template.id,
    after: recipeAuditSnapshot(template),
  });
  return ok({ template });
}

export async function patchRecipe(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = recipePatchSchema.parse(await jsonBody(request));
  const before = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Prompt template not found");
  if (before.status !== "draft")
    throw Errors.badRequest("Only draft templates can be edited");
  const updated = await prisma.generationRecipe.update({
    where: { id },
    data: {
      recipeKey: body.recipeKey,
      label: body.label,
      mode: body.mode,
      useCase: body.useCase,
      body: body.body,
      negativeBase: body.negativeBase,
      presetOrder: body.presetOrder ? toInputJson(body.presetOrder) : undefined,
      safetyHints: body.safetyHints ? toInputJson(body.safetyHints) : undefined,
      sampleMatrix: body.sampleMatrix
        ? toInputJson(body.sampleMatrix)
        : undefined,
      dryRunSummary: body.dryRunSummary
        ? toInputJson(body.dryRunSummary)
        : undefined,
    },
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.update",
    targetType: "generation_prompt_template",
    targetId: id,
    before: recipeAuditSnapshot(before),
    after: recipeAuditSnapshot(updated),
  });
  return ok({ template: updated });
}

export async function publishRecipe(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = publishSchema.parse(await jsonBody(request));
  const template = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!template) throw Errors.notFound("Prompt template not found");
  assertTargetConfirmation(body.confirmation, template.id);
  if (template.status !== "draft")
    throw Errors.badRequest("Only draft templates can be published");
  const dryRunSummary = body.dryRunSummary
    ? toInputJson(body.dryRunSummary)
    : template.dryRunSummary;
  if (!dryRunSummary)
    throw Errors.badRequest("Publish requires dry-run summary");
  const previous = await prisma.generationRecipe.findFirst({
    where: { recipeKey: template.recipeKey, status: "active" },
  });
  const published = await prisma.$transaction(async (tx) => {
    await tx.generationRecipe.updateMany({
      where: { recipeKey: template.recipeKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationRecipe.update({
      where: { id },
      data: {
        status: "active",
        dryRunSummary,
        publishedAt: new Date(),
        archivedAt: null,
      },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.publish",
    targetType: "generation_prompt_template",
    targetId: id,
    reason: body.reason,
    before: previous ? recipeAuditSnapshot(previous) : null,
    after: recipeAuditSnapshot(published),
  });
  return ok({ template: published, previousActiveId: previous?.id ?? null });
}

export async function rollbackRecipe(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Prompt template not found");
  assertTargetConfirmation(body.confirmation, current.id);
  const previous = await prisma.generationRecipe.findFirst({
    where: {
      recipeKey: current.recipeKey,
      status: "archived",
      version: { lt: current.version },
    },
    orderBy: { version: "desc" },
  });
  if (!previous)
    throw Errors.notFound("No previous template version to roll back to");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.generationRecipe.updateMany({
      where: { recipeKey: current.recipeKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationRecipe.update({
      where: { id: previous.id },
      data: { status: "active", publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.rollback",
    targetType: "generation_prompt_template",
    targetId: current.id,
    reason: body.reason,
    before: recipeAuditSnapshot(current),
    after: recipeAuditSnapshot(restored),
  });
  return ok({
    template: restored,
    fromVersion: current.version,
    toVersion: restored.version,
  });
}

export async function listAdminPresets(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const type = url.searchParams.get("type")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { type, status, search, sort: "label_asc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(
        url.searchParams.get("cursor")!,
        "generation_presets",
        queryIdentity,
      )
    : null;
  const [cursorLabel, cursorId] = cursorKeys
    ? z.tuple([z.string(), z.string().min(1)]).parse(cursorKeys)
    : [null, null];
  const presets = await prisma.generationPreset.findMany({
    where: {
      scope: "built_in",
      type,
      status,
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: "insensitive" } },
              { label: { contains: search, mode: "insensitive" } },
              { category: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(cursorLabel && cursorId
        ? {
            AND: [
              {
                OR: [
                  { label: { gt: cursorLabel } },
                  { label: cursorLabel, id: { gt: cursorId } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ label: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const hasNextPage = presets.length > limit;
  const page = presets.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor:
        hasNextPage && last
          ? encodeAdminListCursor("generation_presets", queryIdentity, [
              last.label,
              last.id,
            ])
          : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function getAdminPreset(request: Request, id: string) {
  await actorWithPermission(request, "generation.config.read");
  const preset = await prisma.generationPreset.findUnique({ where: { id } });
  if (!preset || preset.scope !== "built_in")
    throw Errors.notFound("Built-in preset not found");
  return ok({ preset });
}

export async function createAdminPreset(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = presetAdminSchema.parse(await jsonBody(request));
  const preset = await prisma.generationPreset.create({
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
  await writeAudit(request, actor, {
    action: "generation.preset.create",
    targetType: "generation_preset",
    targetId: preset.id,
    after: { type: preset.type, label: preset.label, status: preset.status },
  });
  return ok({ preset });
}

export async function patchAdminPreset(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = presetAdminSchema.partial().parse(await jsonBody(request));
  const before = await prisma.generationPreset.findUnique({ where: { id } });
  if (!before || before.scope !== "built_in")
    throw Errors.notFound("Built-in preset not found");
  const preset = await prisma.generationPreset.update({
    where: { id },
    data: {
      type: body.type,
      category: body.category,
      label: body.label,
      controls: body.controls ? toInputJson(body.controls) : undefined,
      visibility: body.visibility,
      status: body.status,
    },
  });
  await writeAudit(request, actor, {
    action: "generation.preset.update",
    targetType: "generation_preset",
    targetId: id,
    before: { type: before.type, label: before.label, status: before.status },
    after: { type: preset.type, label: preset.label, status: preset.status },
  });
  return ok({ preset });
}

function recipeAuditSnapshot(template: {
  recipeKey: string;
  mode: string;
  useCase: string;
  version: number;
  status: string;
}) {
  return {
    recipeKey: template.recipeKey,
    mode: template.mode,
    useCase: template.useCase,
    version: template.version,
    status: template.status,
  };
}
