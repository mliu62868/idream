import { z } from "zod";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/service";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { moderateText } from "@/server/modules/ourdream/service";

// SPEC: 角色创建模板库（特性 B）。模板是"创建脚手架"——前台选完即与已建角色脱钩，
//       不做继承/版本逻辑。admin 读写按 content.* 权限授权；前台只读公开 active 列表。
// INTENT: 单一文件聚合 service handler，接缝由编排者统一接到 admin/public dispatch。
// INVARIANTS: 落库前文本字段必须过 moderateText("...","input")，blocked → 403。
//             listActiveTemplates 不要求 admin 权限（公开只读，仅返回 isActive）。

const TARGET_TYPE = "character_template";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(200).optional(),
  gender: z.string().trim().max(40).optional(),
  style: z.string().trim().max(60).optional(),
  appearance: z.record(z.string(), z.unknown()).default({}),
  advancedDetails: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  coverAssetId: z.string().trim().max(160).optional(),
  sortOrder: z.number().int().default(0),
  scope: z.enum(["built_in", "community"]).default("built_in"),
  reason: z.string().trim().min(3).max(2_000),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().max(200).optional(),
  gender: z.string().trim().max(40).optional(),
  style: z.string().trim().max(60).optional(),
  appearance: z.record(z.string(), z.unknown()).optional(),
  advancedDetails: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  coverAssetId: z.string().trim().max(160).nullable().optional(),
  sortOrder: z.number().int().optional(),
  scope: z.enum(["built_in", "community"]).optional(),
  reason: z.string().trim().min(3).max(2_000),
});

const activeSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(3).max(2_000),
});

// SPEC: 文本签名 = name + summary + advancedDetails + tags，喂给 moderation 的 input 层。
function moderationText(input: {
  name: string;
  summary?: string | null;
  advancedDetails: unknown;
  tags: string[];
}) {
  return `${input.name} ${input.summary ?? ""} ${JSON.stringify(input.advancedDetails)} ${input.tags.join(" ")}`;
}

async function moderateTemplate(
  targetId: string,
  input: { name: string; summary?: string | null; advancedDetails: unknown; tags: string[] },
) {
  const result = await moderateText(TARGET_TYPE, targetId, moderationText(input), "input");
  if (result.status === "blocked") {
    throw Errors.forbidden("Template failed safety checks", result);
  }
}

// GET /api/v1/admin/content/templates — admin 全量（含 inactive）。perm: content.read
export async function listTemplates(request: Request): Promise<Response> {
  await actorWithPermission(request, "content.read");
  const items = await prisma.characterTemplate.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }],
    take: clampInt(new URL(request.url).searchParams.get("limit"), 1, 500, 200),
  });
  return ok({ items });
}

// POST /api/v1/admin/content/templates — 新建模板。perm: content.template.write
export async function createTemplate(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, "content.template.write");
  const body = createSchema.parse(await jsonBody(request));

  await moderateTemplate("pending", body);

  const template = await prisma.characterTemplate.create({
    data: {
      scope: body.scope,
      name: body.name,
      summary: body.summary ?? null,
      gender: body.gender ?? null,
      style: body.style ?? null,
      appearance: toInputJson(body.appearance),
      advancedDetails: toInputJson(body.advancedDetails),
      tags: toInputJson(body.tags),
      coverAssetId: body.coverAssetId ?? null,
      sortOrder: body.sortOrder,
      createdById: actor.id,
    },
  });

  await writeAudit(request, actor, {
    action: "content.template.create",
    targetType: TARGET_TYPE,
    targetId: template.id,
    reason: body.reason,
    after: { scope: template.scope, name: template.name, isActive: template.isActive },
  });

  return ok({ template });
}

// PATCH /api/v1/admin/content/templates/{id} — 编辑模板。perm: content.template.write
export async function updateTemplate(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, "content.template.write");
  const body = updateSchema.parse(await jsonBody(request));

  const existing = await prisma.characterTemplate.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound("Template not found");

  // 改了任一文本字段就重新过审；用 patch ?? existing 的合并值送审。
  const touchesText =
    body.name !== undefined ||
    body.summary !== undefined ||
    body.advancedDetails !== undefined ||
    body.tags !== undefined;
  if (touchesText) {
    await moderateTemplate(id, {
      name: body.name ?? existing.name,
      summary: body.summary ?? existing.summary,
      advancedDetails: body.advancedDetails ?? existing.advancedDetails,
      tags: body.tags ?? (existing.tags as string[]),
    });
  }

  const template = await prisma.characterTemplate.update({
    where: { id },
    data: {
      scope: body.scope,
      name: body.name,
      summary: body.summary,
      gender: body.gender,
      style: body.style,
      appearance: body.appearance !== undefined ? toInputJson(body.appearance) : undefined,
      advancedDetails:
        body.advancedDetails !== undefined ? toInputJson(body.advancedDetails) : undefined,
      tags: body.tags !== undefined ? toInputJson(body.tags) : undefined,
      coverAssetId: body.coverAssetId,
      sortOrder: body.sortOrder,
    },
  });

  await writeAudit(request, actor, {
    action: "content.template.update",
    targetType: TARGET_TYPE,
    targetId: id,
    reason: body.reason,
    before: { name: existing.name, scope: existing.scope, sortOrder: existing.sortOrder },
    after: { name: template.name, scope: template.scope, sortOrder: template.sortOrder },
  });

  return ok({ template });
}

// POST /api/v1/admin/content/templates/{id}/active — 上/下线。perm: content.template.write
export async function setTemplateActive(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, "content.template.write");
  const body = activeSchema.parse(await jsonBody(request));

  const existing = await prisma.characterTemplate.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound("Template not found");

  const template = await prisma.characterTemplate.update({
    where: { id },
    data: { isActive: body.active },
  });

  await writeAudit(request, actor, {
    action: "content.template.active",
    targetType: TARGET_TYPE,
    targetId: id,
    reason: body.reason,
    before: { isActive: existing.isActive },
    after: { isActive: template.isActive },
  });

  return ok({ template });
}

// GET /api/v1/character-templates — 前台公开只读：仅 active，按 sortOrder。无 admin 权限要求。
export async function listActiveTemplates(): Promise<Response> {
  const items = await prisma.characterTemplate.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      summary: true,
      gender: true,
      style: true,
      appearance: true,
      advancedDetails: true,
      tags: true,
      coverAssetId: true,
    },
  });
  return ok({ items });
}
