import { Prisma } from "@prisma/client";
import type {
  ContentCharacterListItem,
  ContentCharacterQuery,
  ContentCharacterStatusRequest,
  ContentCharacterTagsRequest,
  ContentCharacterVisibilityRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  operationalCharacterWhere,
  operationalContentReportWhere,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "../shared/list-cursor";
import type { AdminActor } from "../shared/authority";
import { toInputJson } from "../shared/prisma-json";
import { contentAuditData } from "./audit";

// SPEC: 目录商品化的读写权威 —— 角色列表 / 详情，以及 visibility / status / tags 三条运营写。
// INTENT: 从 v1 `admin/content/merchandising.ts` 原样搬来。唯一的实质变化是响应显式投影成
//         `contentCharacter*` 契约声明的形状：v1 直接回吐 Prisma 行，v2 里那属于违约。
// INVARIANT: 官方角色的 visibility / status 由 Character Release 与 Serving 命令持有，
//            这两条写仍然对 source==="official" fail closed；tags 例外（见 setCharacterTags）。

const listSelect = {
  id: true,
  name: true,
  gender: true,
  style: true,
  status: true,
  visibility: true,
  creatorId: true,
  createdAt: true,
  imageAsset: { select: { id: true, url: true, thumbnailUrl: true } },
  visualProfiles: {
    where: { status: "active" },
    orderBy: { version: "desc" },
    take: 1,
    select: { id: true, version: true, status: true, style: true },
  },
  stats: { select: { chatsCount: true, likesCount: true, viewsCount: true } },
} satisfies Prisma.CharacterSelect;

type ListRow = Prisma.CharacterGetPayload<{ select: typeof listSelect }>;

export async function listContentCharacters(query: ContentCharacterQuery) {
  const { search, status, visibility, creatorId, sort, limit } = query;
  const queryIdentity = { search, status, visibility, creatorId, sort };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "content_characters", queryIdentity)
    : null;
  const cursorId = cursorKeys ? cursorString(cursorKeys, 1) : null;
  const baseWhere: Prisma.CharacterWhereInput = {
    status,
    visibility,
    creatorId,
    deletedAt: null,
    OR: search
      ? [{ id: { contains: search } }, { name: { contains: search } }]
      : undefined,
  };

  const items = sort === "popular"
    ? await listPopularCharacters({ baseWhere, cursorKeys, cursorId, limit })
    : await prisma.character.findMany({
        where: operationalCharacterWhere({
          ...baseWhere,
          AND: cursorKeys
            ? (() => {
                const createdAt = cursorDate(cursorKeys, 0);
                return {
                  OR: [
                    { createdAt: { lt: createdAt } },
                    { createdAt, id: { lt: cursorId ?? "" } },
                  ],
                };
              })()
            : undefined,
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: listSelect,
      });

  const page = items.slice(0, limit);
  const hasNextPage = items.length > limit;
  const last = page.at(-1);
  return {
    items: page.map(contentCharacterListItem),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("content_characters", queryIdentity, [
            sort === "popular" ? (last.stats?.chatsCount ?? null) : last.createdAt.toISOString(),
            last.id,
          ])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

async function listPopularCharacters(input: {
  baseWhere: Prisma.CharacterWhereInput;
  cursorKeys: unknown[] | null;
  cursorId: string | null;
  limit: number;
}) {
  const { baseWhere, cursorKeys, cursorId, limit } = input;
  if (cursorKeys?.[0] === null) {
    return prisma.character.findMany({
      where: operationalCharacterWhere({
        ...baseWhere,
        stats: { is: null },
        id: { lt: cursorId ?? "" },
      }),
      orderBy: { id: "desc" },
      take: limit + 1,
      select: listSelect,
    });
  }
  const chatsCount = cursorKeys ? cursorNumber(cursorKeys, 0) : null;
  const ranked = await prisma.character.findMany({
    where: operationalCharacterWhere({
      ...baseWhere,
      stats: { isNot: null },
      ...(chatsCount !== null && cursorId
        ? {
            AND: [
              {
                OR: [
                  { stats: { is: { chatsCount: { lt: chatsCount } } } },
                  { stats: { is: { chatsCount } }, id: { lt: cursorId } },
                ],
              },
            ],
          }
        : {}),
    }),
    orderBy: [{ stats: { chatsCount: "desc" } }, { id: "desc" }],
    take: limit + 1,
    select: listSelect,
  });
  if (ranked.length > limit) return ranked;
  const unranked = await prisma.character.findMany({
    where: operationalCharacterWhere({ ...baseWhere, stats: { is: null } }),
    orderBy: { id: "desc" },
    take: limit + 1 - ranked.length,
    select: listSelect,
  });
  return [...ranked, ...unranked];
}

function contentCharacterListItem(row: ListRow): ContentCharacterListItem {
  const [visualProfile] = row.visualProfiles;
  return {
    id: row.id,
    name: row.name,
    gender: row.gender,
    style: row.style,
    status: row.status,
    visibility: row.visibility,
    creatorId: row.creatorId,
    createdAt: row.createdAt.toISOString(),
    imageAsset: row.imageAsset
      ? {
          id: row.imageAsset.id,
          url: row.imageAsset.url,
          thumbnailUrl: row.imageAsset.thumbnailUrl,
        }
      : null,
    visualProfile: visualProfile ?? null,
    stats: row.stats ?? null,
  };
}

export async function getContentCharacter(id: string) {
  const character = await prisma.character.findFirst({
    where: operationalCharacterWhere({ id, deletedAt: null }),
    include: {
      stats: { select: { chatsCount: true, likesCount: true, viewsCount: true } },
      creator: { select: { id: true, email: true, displayName: true } },
      // 带上 Tag 本体：`tags: true` 只给 characterId/tagId，运营界面拿不到标签名。
      tags: { include: { tag: true } },
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  const [reports, recentJobs] = await Promise.all([
    prisma.contentReport.findMany({
      where: operationalContentReportWhere({ targetType: "character", targetId: id }),
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.generationJob.findMany({
      where: operationalGenerationJobWhere({ characterId: id }),
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, mode: true, status: true, createdAt: true },
    }),
  ]);
  return {
    character: {
      id: character.id,
      name: character.name,
      age: character.age,
      description: character.description,
      gender: character.gender,
      style: character.style,
      status: character.status,
      visibility: character.visibility,
      source: character.source,
      relationship: character.relationship,
      voiceId: character.voiceId,
      imageAssetId: character.imageAssetId,
      creatorId: character.creatorId,
      appearance: character.appearance,
      advancedDetails: character.advancedDetails,
      vivid: character.vivid,
      createdAt: character.createdAt.toISOString(),
      updatedAt: character.updatedAt.toISOString(),
      creator: character.creator,
      stats: character.stats,
      tags: character.tags.map((link) => ({
        id: link.tag.id,
        slug: link.tag.slug,
        label: link.tag.label,
        category: link.tag.category,
      })),
    },
    reports: reports.map((report) => ({
      id: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      category: report.category,
      description: report.description,
      status: report.status,
      priority: report.priority,
      createdAt: report.createdAt.toISOString(),
    })),
    recentJobs: recentJobs.map((job) => ({
      id: job.id,
      mode: job.mode,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
    })),
    chatImageToolEnabled: chatImageToolEnabled(character.advancedDetails),
  };
}

export function chatImageToolEnabled(advancedDetails: Prisma.JsonValue) {
  return isRecord(advancedDetails) && advancedDetails.imageToolEnabled === false
    ? false
    : true;
}

export async function setCharacterVisibility(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  requestId: string;
  id: string;
  body: ContentCharacterVisibilityRequest;
}) {
  const { tx, request, actor, requestId, id, body } = input;
  if (body.confirmation !== `${id}:visibility:${body.visibility}`) {
    throw Errors.badRequest("Confirmation did not match visibility target");
  }
  const before = await tx.character.findFirst({
    where: operationalCharacterWhere({ id, deletedAt: null }),
  });
  if (!before) throw Errors.notFound("Character not found");
  rejectOfficialCharacter(before.source, id, "visibility");
  const after = await tx.character.update({
    where: { id },
    data: { visibility: body.visibility },
  });
  await writeCommandSideEffects(tx, request, actor, requestId, {
    action: "content.visibility.write",
    targetId: id,
    reason: body.reason,
    before: { visibility: before.visibility },
    after: { visibility: after.visibility },
    eventType: "admin.content.visibility_changed.v2",
  });
  return {
    character: { id: after.id, visibility: after.visibility, status: after.status },
  };
}

export async function setCharacterStatus(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  requestId: string;
  id: string;
  body: ContentCharacterStatusRequest;
}) {
  const { tx, request, actor, requestId, id, body } = input;
  if (body.confirmation !== `${id}:status:${body.status}`) {
    throw Errors.badRequest("Confirmation did not match status target");
  }
  const before = await tx.character.findFirst({
    where: operationalCharacterWhere({ id, deletedAt: null }),
  });
  if (!before) throw Errors.notFound("Character not found");
  rejectOfficialCharacter(before.source, id, "status");
  const after = await tx.character.update({
    where: { id },
    data: { status: body.status },
  });
  await writeCommandSideEffects(tx, request, actor, requestId, {
    action: "content.status.write",
    targetId: id,
    reason: body.reason,
    before: { status: before.status },
    after: { status: after.status },
    eventType: "admin.content.status_changed.v2",
  });
  return {
    character: { id: after.id, visibility: after.visibility, status: after.status },
  };
}

/**
 * SPEC: 设置某个角色挂载的标签（整组替换）。perm: content.tag.write。
 *
 * INTENT: 补上分类法链路里唯一缺失的一环——「把标签挂到角色上」。此前标签只能在
 * `createCharacterProject` 的 `legacyTagLabels` 里随创建写一次，而唯一传它的入口是官方角色 CMS，
 * 官方角色的 profile 编辑还会显式拒绝改标签并让运营「去 Taxonomy workspace」，但 Taxonomy 只治理
 * 词表本身，挂载能力根本不存在。
 *
 * INVARIANT: 与 visibility / status 不同，这里**不** rejectOfficialCharacter —— 需要打标签的恰恰
 * 是官方目录角色，而 CharacterTag 是扁平关联，不进 content version / release 快照，
 * 不归官方内容流水线管。
 */
export async function setCharacterTags(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  requestId: string;
  id: string;
  body: ContentCharacterTagsRequest;
}) {
  const { tx, request, actor, requestId, id, body } = input;
  if (body.confirmation !== `${id}:tags`) {
    throw Errors.badRequest("Confirmation did not match tag target");
  }
  const tagIds = [...new Set(body.tagIds)];
  const before = await tx.character.findFirst({
    where: operationalCharacterWhere({ id, deletedAt: null }),
    include: { tags: { include: { tag: true } } },
  });
  if (!before) throw Errors.notFound("Character not found");
  const known = await tx.tag.findMany({
    where: { id: { in: tagIds } },
    select: { id: true, label: true },
  });
  if (known.length !== tagIds.length) {
    const missing = tagIds.filter((tagId) => !known.some((tag) => tag.id === tagId));
    throw Errors.badRequest("Unknown tag", { missing });
  }
  await tx.characterTag.deleteMany({ where: { characterId: id } });
  if (tagIds.length > 0) {
    await tx.characterTag.createMany({
      data: tagIds.map((tagId) => ({ characterId: id, tagId })),
    });
  }
  const beforeLabels = before.tags.map((link) => link.tag.label).sort();
  const afterLabels = known.map((tag) => tag.label).sort();
  await writeCommandSideEffects(tx, request, actor, requestId, {
    action: "content.tags.write",
    targetId: id,
    reason: body.reason,
    before: { tags: beforeLabels },
    after: { tags: afterLabels },
    eventType: "admin.content.tags_changed.v1",
  });
  return { character: { id, tags: afterLabels } };
}

export async function writeCommandSideEffects(
  tx: Prisma.TransactionClient,
  request: Request,
  actor: AdminActor,
  requestId: string,
  input: {
    action: string;
    targetType?: string;
    targetId: string;
    reason: string;
    before: unknown;
    after: unknown;
    eventType: string;
  },
) {
  const targetType = input.targetType ?? "character";
  await tx.adminAuditLog.create({
    data: {
      ...contentAuditData(request, actor, {
        action: input.action,
        targetType,
        targetId: input.targetId,
        reason: input.reason,
        before: input.before,
        after: input.after,
      }),
      requestId,
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      eventType: input.eventType,
      aggregateType: targetType,
      aggregateId: input.targetId,
      payload: toInputJson({
        actorId: actor.id,
        requestId,
        before: input.before,
        after: input.after,
      }),
    },
  });
}

function rejectOfficialCharacter(source: string, id: string, field: string) {
  if (source !== "official") return;
  throw Errors.conflict(
    `Official Character ${field} is controlled by Character Release and Serving commands`,
    { repairDeepLink: `/admin/characters/${id}?tab=release` },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursorString(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "string") throw Errors.badRequest("Invalid content_characters cursor");
  return value;
}

function cursorNumber(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "number") throw Errors.badRequest("Invalid content_characters cursor");
  return value;
}

function cursorDate(keys: readonly unknown[], index: number) {
  const date = new Date(cursorString(keys, index));
  if (Number.isNaN(date.getTime())) throw Errors.badRequest("Invalid content_characters cursor");
  return date;
}
