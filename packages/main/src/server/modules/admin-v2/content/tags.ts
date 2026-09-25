import { Prisma } from "@prisma/client";
import type {
  ContentTagCreateRequest,
  ContentTagMergeRequest,
  ContentTagPatchRequest,
  ContentTagQuery,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "../shared/authority";
import { tagSlug } from "../characters/creation";
import { writeContentAudit } from "./audit";

// SPEC: 标签分类法治理 —— admin 侧标签的列表 / 编辑 / 合并。
// INTENT: 与前台 `ourdream` 的只读 listTags() 物理隔离，命名 listAdminTags 以避混淆。
// INVARIANT: 合并需 confirmation===`${sourceId}:${targetId}` 且 source≠target；迁移 CharacterTag
//            去重后删除 source tag 本体；全部写审计。

export async function listAdminTags(query: ContentTagQuery) {
  const tags = await prisma.tag.findMany({
    where: {
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? { OR: [{ slug: { contains: query.search } }, { label: { contains: query.search } }] }
        : {}),
    },
    include: { _count: { select: { characters: true } } },
    orderBy: [{ category: "asc" }, { slug: "asc" }],
    take: query.limit,
  });

  return {
    items: tags.map((tag) => ({
      id: tag.id,
      slug: tag.slug,
      label: tag.label,
      category: tag.category,
      isSensitive: tag.isSensitive,
      isMutedByDefault: tag.isMutedByDefault,
      characterCount: tag._count.characters,
    })),
  };
}

// SPEC: 新建标签。slug 与角色创建时隐式建标签用同一个派生函数，两条入口不会造出两种 slug。
// INVARIANT: confirmation === 派生 slug；slug 已存在则 409（不静默复用，运营要知道它已在词表里）。
export async function createTag(input: {
  request: Request;
  actor: AdminActor;
  body: ContentTagCreateRequest;
}) {
  const { request, actor, body } = input;
  const slug = tagSlug(body.label);
  if (!slug) throw Errors.badRequest("Tag label must contain letters or digits");
  if (body.confirmation !== slug) {
    throw Errors.badRequest("Confirmation did not match tag slug", { expected: slug });
  }
  // INVARIANT: 标签与审计同一事务；并发同 slug 撞唯一约束时报 409 而不是 500。
  try {
    const created = await prisma.$transaction(async (tx) => {
      const tag = await tx.tag.create({
        data: {
          slug,
          label: body.label,
          category: body.category || null,
          isSensitive: body.isSensitive ?? false,
          isMutedByDefault: body.isMutedByDefault ?? false,
        },
      });
      const view = {
        id: tag.id,
        slug: tag.slug,
        label: tag.label,
        category: tag.category,
        isSensitive: tag.isSensitive,
        isMutedByDefault: tag.isMutedByDefault,
      };
      await writeContentAudit(request, actor, {
        action: "content.tag.create",
        targetType: "tag",
        targetId: tag.id,
        reason: body.reason,
        after: view,
      }, tx);
      return view;
    });
    return { tag: created };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw Errors.conflict("A tag with this slug already exists", { slug });
    }
    throw error;
  }
}

export async function patchTag(input: {
  request: Request;
  actor: AdminActor;
  id: string;
  body: ContentTagPatchRequest;
}) {
  const { request, actor, id, body } = input;
  const before = await prisma.tag.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Tag not found");
  if (body.confirmation !== before.slug && body.confirmation !== before.id) {
    throw Errors.badRequest("Confirmation did not match tag");
  }

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
  const changedKeys = (["label", "category", "isSensitive", "isMutedByDefault"] as const)
    .filter((key) => body[key] !== undefined);
  await writeContentAudit(request, actor, {
    action: "content.tag.update",
    targetType: "tag",
    targetId: id,
    reason: body.reason,
    before: Object.fromEntries(changedKeys.map((key) => [key, before[key]])),
    after: Object.fromEntries(changedKeys.map((key) => [key, tag[key]])),
  });

  return {
    tag: {
      id: tag.id,
      slug: tag.slug,
      label: tag.label,
      category: tag.category,
      isSensitive: tag.isSensitive,
      isMutedByDefault: tag.isMutedByDefault,
    },
  };
}

export async function mergeTags(input: {
  request: Request;
  actor: AdminActor;
  body: ContentTagMergeRequest;
}) {
  const { request, actor, body } = input;
  if (body.sourceId === body.targetId) {
    throw Errors.badRequest("Source and target tags must differ");
  }

  const [source, target] = await Promise.all([
    prisma.tag.findUnique({ where: { id: body.sourceId } }),
    prisma.tag.findUnique({ where: { id: body.targetId } }),
  ]);
  if (!source) throw Errors.notFound("Source tag not found");
  if (!target) throw Errors.notFound("Target tag not found");
  if (body.confirmation !== `${source.id}:${target.id}`) {
    throw Errors.badRequest("Confirmation did not match tag merge target");
  }

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

  await writeContentAudit(request, actor, {
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

  return { merged: true as const, movedCount };
}
