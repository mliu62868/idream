import type { CharacterTemplate } from "@prisma/client";
import type {
  ContentTemplateActiveRequest,
  ContentTemplateCreateRequest,
  ContentTemplateQuery,
  ContentTemplateUpdateRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { moderateText } from "@/server/moderation/text-authority";
import type { AdminActor } from "../shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "../shared/list-cursor";
import { toInputJson } from "../shared/prisma-json";
import { writeContentAudit } from "./audit";

// SPEC: 角色创建模板库（Starters）。模板是"创建脚手架"——前台选完即与已建角色脱钩，
//       不做继承/版本逻辑。
// INVARIANT: 落库前文本字段必须过 moderateText("...","input")，blocked → 403。

const TARGET_TYPE = "character_template";

function templateDTO(template: CharacterTemplate) {
  return {
    id: template.id,
    scope: template.scope,
    name: template.name,
    summary: template.summary,
    gender: template.gender,
    style: template.style,
    appearance: template.appearance,
    advancedDetails: template.advancedDetails,
    tags: template.tags,
    coverAssetId: template.coverAssetId,
    isActive: template.isActive,
    sortOrder: template.sortOrder,
    createdById: template.createdById,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

// SPEC: 文本签名 = name + summary + advancedDetails + tags，喂给 moderation 的 input 层。
async function moderateTemplate(
  targetId: string,
  input: { name: string; summary?: string | null; advancedDetails: unknown; tags: string[] },
) {
  const signature =
    `${input.name} ${input.summary ?? ""} ${JSON.stringify(input.advancedDetails)} ${input.tags.join(" ")}`;
  const result = await moderateText(TARGET_TYPE, targetId, signature, "input");
  if (result.status === "blocked") {
    throw Errors.forbidden("Template failed safety checks", result);
  }
}

export async function listTemplates(query: ContentTemplateQuery) {
  const isActive = query.status === "active"
    ? true
    : query.status === "disabled" ? false : undefined;
  const queryIdentity = {
    search: query.search,
    scope: query.scope,
    status: query.status,
    sort: "name_asc",
  };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "character_starters", queryIdentity)
    : null;
  const [cursorName, cursorId] = cursorKeys
    ? [cursorText(cursorKeys[0]), cursorText(cursorKeys[1])]
    : [null, null];
  const items = await prisma.characterTemplate.findMany({
    where: {
      scope: query.scope,
      isActive,
      ...(query.search ? { OR: [
        { id: { contains: query.search, mode: "insensitive" as const } },
        { name: { contains: query.search, mode: "insensitive" as const } },
        { summary: { contains: query.search, mode: "insensitive" as const } },
      ] } : {}),
      ...(cursorName && cursorId ? { AND: [{ OR: [
        { name: { gt: cursorName } },
        { name: cursorName, id: { gt: cursorId } },
      ] }] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: query.limit + 1,
  });
  const hasNextPage = items.length > query.limit;
  const page = items.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(templateDTO),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("character_starters", queryIdentity, [last.name, last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

export async function getTemplate(id: string) {
  const template = await prisma.characterTemplate.findUnique({ where: { id } });
  if (!template) throw Errors.notFound("Character starter not found");
  return { template: templateDTO(template) };
}

export async function createTemplate(input: {
  request: Request;
  actor: AdminActor;
  body: ContentTemplateCreateRequest;
}) {
  const { request, actor, body } = input;
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
      isActive: false,
      createdById: actor.id,
    },
  });

  await writeContentAudit(request, actor, {
    action: "content.template.create",
    targetType: TARGET_TYPE,
    targetId: template.id,
    reason: body.reason,
    after: { scope: template.scope, name: template.name, isActive: template.isActive },
  });

  return { template: templateDTO(template) };
}

export async function updateTemplate(input: {
  request: Request;
  actor: AdminActor;
  id: string;
  body: ContentTemplateUpdateRequest;
}) {
  const { request, actor, id, body } = input;
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

  await writeContentAudit(request, actor, {
    action: "content.template.update",
    targetType: TARGET_TYPE,
    targetId: id,
    reason: body.reason,
    before: { name: existing.name, scope: existing.scope, sortOrder: existing.sortOrder },
    after: { name: template.name, scope: template.scope, sortOrder: template.sortOrder },
  });

  return { template: templateDTO(template) };
}

export async function setTemplateActive(input: {
  request: Request;
  actor: AdminActor;
  id: string;
  body: ContentTemplateActiveRequest;
}) {
  const { request, actor, id, body } = input;
  const existing = await prisma.characterTemplate.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound("Template not found");
  if (body.confirmation !== id) throw Errors.badRequest("Confirmation did not match target");

  const template = await prisma.characterTemplate.update({
    where: { id },
    data: { isActive: body.active },
  });

  await writeContentAudit(request, actor, {
    action: "content.template.active",
    targetType: TARGET_TYPE,
    targetId: id,
    reason: body.reason,
    before: { isActive: existing.isActive },
    after: { isActive: template.isActive },
  });

  return { template: templateDTO(template) };
}

function cursorText(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("Invalid character_starters cursor");
  }
  return value;
}
