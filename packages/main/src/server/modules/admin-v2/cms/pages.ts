// SPEC: CMS/SEO 页面权威。admin 凭 content.cms.write 管理 RoutePage（正文 + SEO
//       metadata + 发布状态）；公开读经 server/cms 的同一份版本化契约。
// INTENT: 传输契约（字段在不在）由 manifest 声明；「哪些 pathname 归 CMS 所有」「什么
//         算可发布」仍由 server/cms/route-page-contract 说了算 —— 那份规则同时服务公开
//         读路径，复制进 shared 就会变成第二份权威。
// INVARIANTS:
//   - template 行是编辑队列，永远不能原样发布。
//   - create/patch 只产出 draft；draft→published 是唯一的发布通路。
//   - 已发布内容一定过了公开读用的同一份版本化契约。
//   - 写操作用 updatedAt CAS，并把审计行提交在同一个事务里。
import { z } from "zod";
import { revalidatePath, revalidateTag } from "next/cache";
import type { RoutePage } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  CMS_CONTENT_SCHEMA_VERSION,
  cmsCacheTag,
  cmsCanonicalSchema,
  cmsContractIssues,
  cmsPathSchema,
  inspectCmsPublication,
  validateCmsPublication,
  type CmsPublicationCandidate,
} from "@/server/cms/route-page-contract";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

const CMS_WRITE = "content.cms.write" as const;
const CONTENT_READ = "content.read" as const;

function summaryDto(row: RoutePage) {
  return {
    path: row.path,
    template: row.template,
    title: row.title,
    description: row.description,
    canonical: row.canonical,
    contentStatus: row.contentStatus,
    contentSchemaVersion: row.contentSchemaVersion,
    indexingStatus: row.indexingStatus,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    ...publicationReadiness(row),
  };
}

function detailDto(row: RoutePage) {
  return { ...summaryDto(row), body: row.body };
}

function auditRow(
  request: Request,
  actor: AdminActor,
  input: {
    action: string;
    targetId: string;
    reason: string;
    before?: unknown;
    after?: unknown;
  },
) {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    action: input.action,
    targetType: "route_page",
    targetId: input.targetId,
    reason: input.reason,
    ...(input.before === undefined ? {} : { before: toInputJson(input.before) }),
    ...(input.after === undefined ? {} : { after: toInputJson(input.after) }),
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
  };
}

function assertPathConfirmation(value: string, path: string) {
  if (value !== path) throw Errors.badRequest("Confirmation did not match");
}

/** The wire contract only bounds the string; CMS path ownership lives in the domain contract. */
function ownedCmsPath(value: string) {
  return cmsPathSchema.parse(value);
}

function ownedCmsCanonical(value: string | null | undefined) {
  return value === undefined ? undefined : cmsCanonicalSchema.parse(value);
}

function revalidateCmsPage(path: string) {
  try {
    revalidateTag("cms-pages", { expire: 0 });
    revalidateTag(cmsCacheTag(path), { expire: 0 });
    revalidatePath(path);
    revalidatePath("/sitemap.xml");
    return true;
  } catch (error) {
    // Direct service tests do not run inside a Next route revalidation context.
    logger.warn(
      { errorKind: error instanceof Error ? error.name : typeof error, path },
      "CMS cache revalidation did not complete",
    );
    return false;
  }
}

export async function listCmsPages(request: Request) {
  await actorWithPermission(request, CONTENT_READ);
  const query = queryParams(request, "GET /api/v2/admin/cms/pages");
  const rows = await prisma.routePage.findMany({
    where: {
      contentStatus: query.status,
      ...(query.q
        ? { OR: [{ path: { contains: query.q } }, { title: { contains: query.q } }] }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit,
  });
  return { items: rows.map(summaryDto) };
}

export async function getCmsPage(request: Request) {
  await actorWithPermission(request, CONTENT_READ);
  const query = queryParams(request, "GET /api/v2/admin/cms/page");
  const page = await prisma.routePage.findUnique({ where: { path: query.path.trim() } });
  if (!page) throw Errors.notFound("Route page not found");
  return { page: detailDto(page) };
}

export async function createCmsPage(request: Request) {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = await jsonBody(request, "cmsPageCreateRequestSchema");
  const path = ownedCmsPath(body.path);
  assertPathConfirmation(body.confirmation, path);
  const canonical = ownedCmsCanonical(body.canonical) ?? null;
  const existing = await prisma.routePage.findUnique({ where: { path } });
  if (existing) throw Errors.conflict("A page with this path already exists");
  const page = await prisma.$transaction(async (tx) => {
    const created = await tx.routePage.create({
      data: {
        path,
        template: body.template,
        title: body.title,
        description: body.description,
        canonical,
        contentStatus: "draft",
        contentSchemaVersion: null,
        indexingStatus: body.indexingStatus,
        body: toInputJson(body.body),
        publishedAt: null,
      },
    });
    await tx.adminAuditLog.create({
      data: auditRow(request, actor, {
        action: "cms.page.create",
        targetId: created.path,
        reason: body.reason,
        after: {
          title: created.title,
          contentStatus: created.contentStatus,
          template: created.template,
          indexingStatus: created.indexingStatus,
        },
      }),
    });
    return created;
  });
  return { page: detailDto(page), cacheRevalidated: revalidateCmsPage(page.path) };
}

export async function patchCmsPage(request: Request) {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = await jsonBody(request, "cmsPagePatchRequestSchema");
  const path = ownedCmsPath(body.path);
  assertPathConfirmation(body.confirmation, path);
  const canonical = ownedCmsCanonical(body.canonical);
  const before = await prisma.routePage.findUnique({ where: { path } });
  if (!before) throw Errors.notFound("Route page not found");
  if (before.contentStatus === "published") {
    throw Errors.conflict("Unpublish the page before editing it");
  }
  assertExpectedUpdatedAt(before.updatedAt, body.expectedUpdatedAt);
  const page = await prisma.$transaction(async (tx) => {
    const changed = await tx.routePage.updateMany({
      where: {
        path,
        updatedAt: before.updatedAt,
        contentStatus: { not: "published" },
      },
      data: {
        template: body.template,
        title: body.title,
        description: body.description,
        canonical,
        indexingStatus: body.indexingStatus,
        contentStatus: "draft",
        contentSchemaVersion: null,
        body: body.body === undefined ? undefined : toInputJson(body.body),
        publishedAt: null,
      },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("CMS page changed before the draft was saved");
    }
    const updated = await tx.routePage.findUniqueOrThrow({ where: { path } });
    await tx.adminAuditLog.create({
      data: auditRow(request, actor, {
        action: "cms.page.update",
        targetId: updated.path,
        reason: body.reason,
        before: {
          title: before.title,
          contentStatus: before.contentStatus,
          updatedAt: before.updatedAt,
        },
        after: {
          title: updated.title,
          contentStatus: updated.contentStatus,
          indexingStatus: updated.indexingStatus,
          updatedAt: updated.updatedAt,
        },
      }),
    });
    return updated;
  });
  return { page: detailDto(page), cacheRevalidated: revalidateCmsPage(page.path) };
}

export async function publishCmsPage(request: Request) {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = await jsonBody(request, "cmsPagePublicationRequestSchema");
  const path = ownedCmsPath(body.path);
  assertPathConfirmation(body.confirmation, path);
  const before = await prisma.routePage.findUnique({ where: { path } });
  if (!before) throw Errors.notFound("Route page not found");
  assertExpectedUpdatedAt(before.updatedAt, body.expectedUpdatedAt);

  if (body.contentStatus === "published") {
    if (before.contentStatus !== "draft") {
      throw Errors.conflict("Only a saved draft can be published");
    }
    try {
      validateCmsPublication(publicationCandidate(before));
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw Errors.conflict("CMS page is not ready to publish", {
          issues: cmsContractIssues(error),
        });
      }
      throw error;
    }
  } else if (before.contentStatus !== "published") {
    throw Errors.conflict("Only a published page can be unpublished");
  }

  const page = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const changed = await tx.routePage.updateMany({
      where: { path, updatedAt: before.updatedAt, contentStatus: before.contentStatus },
      data:
        body.contentStatus === "published"
          ? {
              contentStatus: "published",
              contentSchemaVersion: CMS_CONTENT_SCHEMA_VERSION,
              publishedAt: now,
            }
          : {
              contentStatus: "draft",
              contentSchemaVersion: null,
              indexingStatus: "noindex",
              publishedAt: null,
            },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("CMS page changed before the status update was applied");
    }
    const updated = await tx.routePage.findUniqueOrThrow({ where: { path } });
    await tx.adminAuditLog.create({
      data: auditRow(request, actor, {
        action: "cms.page.publish",
        targetId: updated.path,
        reason: body.reason,
        before: {
          contentStatus: before.contentStatus,
          indexingStatus: before.indexingStatus,
          updatedAt: before.updatedAt,
        },
        after: {
          contentStatus: updated.contentStatus,
          contentSchemaVersion: updated.contentSchemaVersion,
          indexingStatus: updated.indexingStatus,
          publishedAt: updated.publishedAt,
          updatedAt: updated.updatedAt,
        },
      }),
    });
    return updated;
  });
  return { page: detailDto(page), cacheRevalidated: revalidateCmsPage(page.path) };
}

function publicationCandidate(page: CmsPublicationCandidate): CmsPublicationCandidate {
  return {
    body: page.body,
    canonical: page.canonical,
    description: page.description,
    indexingStatus: page.indexingStatus,
    path: page.path,
    template: page.template,
    title: page.title,
  };
}

function publicationReadiness(page: CmsPublicationCandidate & { contentStatus: string }) {
  const pathResult = cmsPathSchema.safeParse(page.path);
  if (!pathResult.success) {
    return {
      editable: false,
      publishability: "blocked" as const,
      issues: cmsContractIssues(pathResult.error).map((issue) => ({
        ...issue,
        code: "path_not_cms_owned",
        path: issue.path || "path",
      })),
    };
  }
  if (page.contentStatus === "template") {
    return {
      editable: true,
      publishability: "blocked" as const,
      issues: [
        {
          code: "template_requires_edit",
          message: "Edit and save this template as a draft before publishing",
          path: "contentStatus",
        },
      ],
    };
  }
  return {
    editable: page.contentStatus === "draft",
    ...inspectCmsPublication(publicationCandidate(page)),
  };
}

function assertExpectedUpdatedAt(actual: Date, expected: string) {
  if (actual.toISOString() !== new Date(expected).toISOString()) {
    throw Errors.conflict("CMS page changed since it was loaded", {
      actualUpdatedAt: actual.toISOString(),
      expectedUpdatedAt: expected,
    });
  }
}
