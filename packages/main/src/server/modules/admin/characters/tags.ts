import { z } from "zod";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  writeAudit,
} from "@/server/modules/admin/service";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";

// SPEC: 标签分类法治理（Character Management §C）—— admin 侧标签的列表/编辑/合并。
// INTENT: 与 ourdream/service.ts 的前台 listTags() 物理隔离，命名 listAdminTags 以避混淆。
//         接缝（dispatchAdmin 路由 + UI 注册）由编排者统一接线，本文件不碰其它文件。
// INVARIANTS: 写操作要 content.tag.write；合并需 confirmation==="MERGE" 且 source≠target；
//             合并迁移 CharacterTag 去重（skipDuplicates），最后删除 source tag 本体；全部审计。

// patch：至少一个可变字段 + reason。category 可空（清除分类）。
const patchTagSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().max(40).nullable().optional(),
    isSensitive: z.boolean().optional(),
    isMutedByDefault: z.boolean().optional(),
    reason: z.string().trim().min(3).max(2_000),
  })
  .refine(
    (body) =>
      body.label !== undefined ||
      body.category !== undefined ||
      body.isSensitive !== undefined ||
      body.isMutedByDefault !== undefined,
    { message: "At least one tag field must be provided" },
  );

const mergeTagsSchema = z.object({
  sourceId: z.string().trim().min(1).max(160),
  targetId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

// GET /api/v1/admin/content/tags —— 列出所有标签 + 角色数，支持 ?search / ?category。
export async function listAdminTags(request: Request): Promise<Response> {
  await actorWithPermission(request, "content.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim();
  const category = url.searchParams.get("category")?.trim();

  const tags = await prisma.tag.findMany({
    where: {
      ...(category ? { category } : {}),
      ...(search
        ? {
            OR: [
              { slug: { contains: search } },
              { label: { contains: search } },
            ],
          }
        : {}),
    },
    include: { _count: { select: { characters: true } } },
    orderBy: [{ category: "asc" }, { slug: "asc" }],
    take: clampInt(url.searchParams.get("limit"), 1, 500, 200),
  });

  const items = tags.map((tag) => ({
    id: tag.id,
    slug: tag.slug,
    label: tag.label,
    category: tag.category,
    isSensitive: tag.isSensitive,
    isMutedByDefault: tag.isMutedByDefault,
    characterCount: tag._count.characters,
  }));

  return ok({ items });
}

// PATCH /api/v1/admin/content/tags/{id} —— 编辑标签元数据，记录 before/after 变更字段。
export async function patchTag(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, "content.tag.write");
  const body = patchTagSchema.parse(await jsonBody(request));

  const before = await prisma.tag.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Tag not found");

  const tag = await prisma.tag.update({
    where: { id },
    data: {
      label: body.label,
      category: body.category === undefined ? undefined : body.category,
      isSensitive: body.isSensitive,
      isMutedByDefault: body.isMutedByDefault,
    },
  });

  // 仅记录实际请求修改的字段，before/after 一一对应。
  const changedKeys = (["label", "category", "isSensitive", "isMutedByDefault"] as const).filter(
    (key) => body[key] !== undefined,
  );
  const beforeChanges = Object.fromEntries(changedKeys.map((key) => [key, before[key]]));
  const afterChanges = Object.fromEntries(changedKeys.map((key) => [key, tag[key]]));

  await writeAudit(request, actor, {
    action: "content.tag.update",
    targetType: "tag",
    targetId: id,
    reason: body.reason,
    before: beforeChanges,
    after: afterChanges,
  });

  return ok({
    tag: {
      id: tag.id,
      slug: tag.slug,
      label: tag.label,
      category: tag.category,
      isSensitive: tag.isSensitive,
      isMutedByDefault: tag.isMutedByDefault,
    },
  });
}

// POST /api/v1/admin/content/tags/merge —— 把 source 标签并入 target 并删除 source。
export async function mergeTags(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, "content.tag.write");
  const body = mergeTagsSchema.parse(await jsonBody(request));

  if (body.confirmation !== "MERGE") {
    throw Errors.badRequest("Merge requires MERGE confirmation");
  }
  if (body.sourceId === body.targetId) {
    throw Errors.badRequest("Source and target tags must differ");
  }

  const [source, target] = await Promise.all([
    prisma.tag.findUnique({ where: { id: body.sourceId } }),
    prisma.tag.findUnique({ where: { id: body.targetId } }),
  ]);
  if (!source) throw Errors.notFound("Source tag not found");
  if (!target) throw Errors.notFound("Target tag not found");

  const movedCount = await prisma.$transaction(async (tx) => {
    const sourceLinks = await tx.characterTag.findMany({
      where: { tagId: source.id },
      select: { characterId: true },
    });
    const existingTargetLinks = await tx.characterTag.findMany({
      where: { tagId: target.id },
      select: { characterId: true },
    });
    const existingTargetIds = new Set(existingTargetLinks.map((link) => link.characterId));
    const toMove = sourceLinks.filter((link) => !existingTargetIds.has(link.characterId));

    if (toMove.length > 0) {
      await tx.characterTag.createMany({
        data: toMove.map((link) => ({ characterId: link.characterId, tagId: target.id })),
        skipDuplicates: true,
      });
    }
    await tx.characterTag.deleteMany({ where: { tagId: source.id } });
    await tx.tag.delete({ where: { id: source.id } });
    return toMove.length;
  });

  await writeAudit(request, actor, {
    action: "content.tag.merge",
    targetType: "tag",
    targetId: target.id,
    reason: body.reason,
    before: {
      sourceId: source.id,
      sourceSlug: source.slug,
      targetId: target.id,
      movedCount,
    },
  });

  return ok({ merged: true, movedCount });
}
