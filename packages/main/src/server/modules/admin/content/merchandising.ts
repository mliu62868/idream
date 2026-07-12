import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { executeIdempotentDomainCommand } from "@/server/modules/admin/shared/domain-command";
import {
  adminAuditData,
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

const FEATURED_SETTING_KEY = "feed.featured";

const contentVisibilitySchema = z.object({
  visibility: z.enum(["private", "unlisted", "public"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const contentStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "removed", "archived"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const featuredPutSchema = z.object({
  characterIds: z.array(z.string().trim().min(1).max(160)).max(24),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listContentCharacters(request: Request) {
  await actorWithPermission(request, "content.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const visibility = url.searchParams.get("visibility") ?? undefined;
  const creatorId = url.searchParams.get("creatorId") ?? undefined;
  const sort = url.searchParams.get("sort") ?? "recent";
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 60);
  const queryIdentity = { search, status, visibility, creatorId, sort };
  const cursorKeys = cursorKeysFor(url, "content_characters", queryIdentity);
  const cursorId = cursorKeys
    ? cursorString(cursorKeys, 1, "content_characters")
    : null;
  const baseWhere: Prisma.CharacterWhereInput = {
    status,
    visibility,
    creatorId,
    deletedAt: null,
    OR: search
      ? [{ id: { contains: search } }, { name: { contains: search } }]
      : undefined,
  };
  const select = {
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

  const items =
    sort === "popular"
      ? await listPopularCharacters({
          baseWhere,
          cursorKeys,
          cursorId,
          limit,
          select,
        })
      : await prisma.character.findMany({
          where: {
            ...baseWhere,
            AND: cursorKeys
              ? (() => {
                  const createdAt = cursorDate(
                    cursorKeys,
                    0,
                    "content_characters",
                  );
                  return {
                    OR: [
                      { createdAt: { lt: createdAt } },
                      { createdAt, id: { lt: cursorId ?? "" } },
                    ],
                  };
                })()
              : undefined,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select,
        });
  const page = items.slice(0, limit);
  return ok({
    items: page,
    pageInfo: pageInfo(
      "content_characters",
      queryIdentity,
      page,
      items.length > limit,
      (row) => [
        sort === "popular"
          ? (row.stats?.chatsCount ?? null)
          : row.createdAt.toISOString(),
        row.id,
      ],
    ),
  });
}

async function listPopularCharacters(input: {
  baseWhere: Prisma.CharacterWhereInput;
  cursorKeys: unknown[] | null;
  cursorId: string | null;
  limit: number;
  select: Prisma.CharacterSelect;
}) {
  const { baseWhere, cursorKeys, cursorId, limit, select } = input;
  if (cursorKeys?.[0] === null) {
    return prisma.character.findMany({
      where: {
        ...baseWhere,
        stats: { is: null },
        id: { lt: cursorId ?? "" },
      },
      orderBy: { id: "desc" },
      take: limit + 1,
      select,
    });
  }
  const chatsCount = cursorKeys
    ? cursorNumber(cursorKeys, 0, "content_characters")
    : null;
  const ranked = await prisma.character.findMany({
    where: {
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
    },
    orderBy: [{ stats: { chatsCount: "desc" } }, { id: "desc" }],
    take: limit + 1,
    select,
  });
  if (ranked.length > limit) return ranked;
  const unranked = await prisma.character.findMany({
    where: { ...baseWhere, stats: { is: null } },
    orderBy: { id: "desc" },
    take: limit + 1 - ranked.length,
    select,
  });
  return [...ranked, ...unranked];
}

export async function getContentCharacter(request: Request, id: string) {
  await actorWithPermission(request, "content.read");
  const character = await prisma.character.findUnique({
    where: { id },
    include: {
      stats: true,
      creator: { select: { id: true, email: true, displayName: true } },
      tags: true,
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  const [reports, recentJobs] = await Promise.all([
    prisma.contentReport.findMany({
      where: { targetType: "character", targetId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.generationJob.findMany({
      where: { characterId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, mode: true, status: true, createdAt: true },
    }),
  ]);
  const chatImageToolEnabled =
    isRecord(character.advancedDetails) &&
    character.advancedDetails.imageToolEnabled === false
      ? false
      : true;
  return ok({ character, reports, recentJobs, chatImageToolEnabled });
}

export async function setCharacterVisibility(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentVisibilitySchema.parse(await jsonBody(request));
  if (body.confirmation !== `${id}:visibility:${body.visibility}`) {
    throw Errors.badRequest("Confirmation did not match visibility target");
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.visibility.write",
    targetType: "character",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.character.findUnique({ where: { id } });
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
        character: {
          id: after.id,
          visibility: after.visibility,
          status: after.status,
        },
      };
    },
  });
  return ok(result);
}

export async function setCharacterStatus(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentStatusSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${id}:status:${body.status}`) {
    throw Errors.badRequest("Confirmation did not match status target");
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.status.write",
    targetType: "character",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.character.findUnique({ where: { id } });
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
        character: {
          id: after.id,
          visibility: after.visibility,
          status: after.status,
        },
      };
    },
  });
  return ok(result);
}

export async function getFeaturedCharacters(request: Request) {
  await actorWithPermission(request, "content.read");
  const setting = await prisma.appSetting.findUnique({
    where: { key: FEATURED_SETTING_KEY },
  });
  const ids = featuredIdsFromSetting(setting?.value);
  const characters = ids.length
    ? await prisma.character.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, visibility: true, status: true },
      })
    : [];
  const byId = new Map(
    characters.map((character) => [character.id, character]),
  );
  return ok({
    characterIds: ids,
    items: ids.map((id) => byId.get(id)).filter((value) => value !== undefined),
  });
}

export async function putFeaturedCharacters(request: Request) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = featuredPutSchema.parse(await jsonBody(request));
  const unique = [
    ...new Set(body.characterIds.map((id) => id.trim()).filter(Boolean)),
  ];
  const expected = unique.length ? unique.join(",") : "CLEAR";
  if (body.confirmation !== expected) {
    throw Errors.badRequest("Confirmation did not match featured target");
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.featured.write",
    targetType: "app_setting",
    targetId: FEATURED_SETTING_KEY,
    payload: body,
    execute: async (tx, requestId) => {
      const valid = unique.length
        ? await tx.character.findMany({
            where: {
              id: { in: unique },
              visibility: "public",
              status: "approved",
              deletedAt: null,
            },
            select: { id: true },
          })
        : [];
      const validSet = new Set(valid.map((character) => character.id));
      const validIds = unique.filter((id) => validSet.has(id));
      const before = await tx.appSetting.findUnique({
        where: { key: FEATURED_SETTING_KEY },
      });
      await tx.appSetting.upsert({
        where: { key: FEATURED_SETTING_KEY },
        update: { value: toInputJson({ characterIds: validIds }) },
        create: {
          key: FEATURED_SETTING_KEY,
          value: toInputJson({ characterIds: validIds }),
        },
      });
      await writeCommandSideEffects(tx, request, actor, requestId, {
        action: "content.featured.write",
        targetType: "app_setting",
        targetId: FEATURED_SETTING_KEY,
        reason: body.reason,
        before: { characterIds: featuredIdsFromSetting(before?.value) },
        after: { characterIds: validIds },
        eventType: "admin.content.featured_updated.v2",
      });
      return {
        characterIds: validIds,
        skipped: unique.filter((id) => !validSet.has(id)),
      };
    },
  });
  return ok(result);
}

async function writeCommandSideEffects(
  tx: Prisma.TransactionClient,
  request: Request,
  actor: Awaited<ReturnType<typeof actorWithPermission>>,
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
      ...adminAuditData(request, actor, {
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

function featuredIdsFromSetting(value: Prisma.JsonValue | undefined): string[] {
  return isRecord(value) ? jsonStringArray(value.characterIds) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function cursorKeysFor(url: URL, scope: string, query: unknown) {
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return null;
  return decodeAdminListCursor(cursor, scope, query);
}

function cursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string")
    throw Errors.badRequest(`Invalid ${scope} cursor`);
  return value;
}

function cursorNumber(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "number")
    throw Errors.badRequest(`Invalid ${scope} cursor`);
  return value;
}

function cursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = cursorString(keys, index, scope);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw Errors.badRequest(`Invalid ${scope} cursor`);
  return date;
}

function pageInfo<T>(
  scope: string,
  query: unknown,
  page: T[],
  hasNextPage: boolean,
  keys: (row: T) => Array<string | number | boolean | null>,
) {
  const last = page.at(-1);
  return {
    hasNextPage,
    endCursor:
      hasNextPage && last
        ? encodeAdminListCursor(scope, query, keys(last))
        : null,
  };
}
