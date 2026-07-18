// SPEC: CMS/SEO 内容管理服务层（ADMIN_PHASE3_DESIGN §3）。admin 凭 content.cms.write
//       管理 RoutePage（页面正文 + SEO metadata + 发布状态），公开读路径混合 override。
// INTENT: 复用既有 RoutePage 表（零迁移）；读用 content.read，写用 content.cms.write，
//         reason+typed 确认 + AdminAuditLog，与既有控制面一致。
// INVARIANTS:
//   - template rows are an editing queue, never publishable as-is.
//   - create/patch only produce drafts; draft→published is the sole publish path.
//   - published content has passed the same versioned contract used by public reads.
//   - writes use updatedAt CAS and commit the audit record in the same transaction.
import { z } from "zod";
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
import {
  CMS_CONTENT_SCHEMA_VERSION,
  cmsCacheTag,
  cmsCanonicalSchema,
  cmsContractIssues,
  cmsIndexingStatusSchema,
  cmsPathSchema,
  cmsTemplateSchema,
  inspectCmsPublication,
  validateCmsPublication,
  type CmsPublicationCandidate,
} from "@/server/cms/route-page-contract";
import {
  adminAuditData,
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";

const CMS_WRITE = "content.cms.write" as const;
const CONTENT_READ = "content.read" as const;

const bodySchema = z.record(z.string(), z.unknown()).superRefine((body, ctx) => {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 128 * 1_024) {
    ctx.addIssue({
      code: "custom",
      message: "CMS body must not exceed 128 KiB",
    });
  }
});
const expectedUpdatedAtSchema = z.string().datetime({ offset: true });

const createSchema = z
  .object({
    path: cmsPathSchema,
    template: cmsTemplateSchema.default("article"),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(320).default(""),
    canonical: cmsCanonicalSchema.optional().default(null),
    indexingStatus: cmsIndexingStatusSchema.default("noindex"),
    body: bodySchema.default({}),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(512),
  })
  .strict();

const patchSchema = z
  .object({
    path: cmsPathSchema,
    template: cmsTemplateSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(320).optional(),
    canonical: cmsCanonicalSchema.optional(),
    indexingStatus: cmsIndexingStatusSchema.optional(),
    body: bodySchema.optional(),
    expectedUpdatedAt: expectedUpdatedAtSchema,
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(512),
  })
  .strict();

const publishSchema = z
  .object({
    path: cmsPathSchema,
    contentStatus: z.enum(["draft", "published"]),
    expectedUpdatedAt: expectedUpdatedAtSchema,
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(512),
  })
  .strict();

function assertPathConfirmation(value: string, path: string) {
  if (value !== path) throw Errors.badRequest("Confirmation did not match");
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
      {
        errorKind: error instanceof Error ? error.name : typeof error,
        path,
      },
      "CMS cache revalidation did not complete",
    );
    return false;
  }
}

export async function listCmsPages(request: Request): Promise<Response> {
  await actorWithPermission(request, CONTENT_READ);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = url.searchParams.get("q")?.trim();
  const rows = await prisma.routePage.findMany({
    where: {
      contentStatus: status,
      ...(q ? { OR: [{ path: { contains: q } }, { title: { contains: q } }] } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 100),
    select: {
      path: true,
      template: true,
      title: true,
      description: true,
      canonical: true,
      contentStatus: true,
      contentSchemaVersion: true,
      indexingStatus: true,
      body: true,
      publishedAt: true,
      updatedAt: true,
    },
  });
  const items = rows.map((row) => ({
    path: row.path,
    template: row.template,
    title: row.title,
    description: row.description,
    canonical: row.canonical,
    contentStatus: row.contentStatus,
    contentSchemaVersion: row.contentSchemaVersion,
    indexingStatus: row.indexingStatus,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    ...publicationReadiness(row),
  }));
  return ok({ items });
}

export async function getCmsPage(request: Request): Promise<Response> {
  await actorWithPermission(request, CONTENT_READ);
  const url = new URL(request.url);
  const path = url.searchParams.get("path")?.trim();
  if (!path) throw Errors.badRequest("path query param is required");
  const page = await prisma.routePage.findUnique({ where: { path } });
  if (!page) throw Errors.notFound("Route page not found");
  return ok({ page: { ...page, ...publicationReadiness(page) } });
}

export async function createCmsPage(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = createSchema.parse(await jsonBody(request));
  assertPathConfirmation(body.confirmation, body.path);
  const existing = await prisma.routePage.findUnique({ where: { path: body.path } });
  if (existing) throw Errors.conflict("A page with this path already exists");
  const page = await prisma.$transaction(async (tx) => {
    const created = await tx.routePage.create({
      data: {
        path: body.path,
        template: body.template,
        title: body.title,
        description: body.description,
        canonical: body.canonical,
        contentStatus: "draft",
        contentSchemaVersion: null,
        indexingStatus: body.indexingStatus,
        body: toInputJson(body.body),
        publishedAt: null,
      },
    });
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "cms.page.create",
        targetType: "route_page",
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
  const cacheRevalidated = revalidateCmsPage(page.path);
  return ok({ page: { ...page, ...publicationReadiness(page) }, cacheRevalidated });
}

export async function patchCmsPage(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = patchSchema.parse(await jsonBody(request));
  assertPathConfirmation(body.confirmation, body.path);
  const before = await prisma.routePage.findUnique({ where: { path: body.path } });
  if (!before) throw Errors.notFound("Route page not found");
  if (before.contentStatus === "published") {
    throw Errors.conflict("Unpublish the page before editing it");
  }
  assertExpectedUpdatedAt(before.updatedAt, body.expectedUpdatedAt);
  const page = await prisma.$transaction(async (tx) => {
    const changed = await tx.routePage.updateMany({
      where: {
        path: body.path,
        updatedAt: before.updatedAt,
        contentStatus: { not: "published" },
      },
      data: {
        template: body.template,
        title: body.title,
        description: body.description,
        canonical: body.canonical === undefined ? undefined : body.canonical,
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
    const updated = await tx.routePage.findUniqueOrThrow({
      where: { path: body.path },
    });
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "cms.page.update",
        targetType: "route_page",
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
  const cacheRevalidated = revalidateCmsPage(page.path);
  return ok({ page: { ...page, ...publicationReadiness(page) }, cacheRevalidated });
}

export async function publishCmsPage(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = publishSchema.parse(await jsonBody(request));
  assertPathConfirmation(body.confirmation, body.path);
  const before = await prisma.routePage.findUnique({ where: { path: body.path } });
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
      where: {
        path: body.path,
        updatedAt: before.updatedAt,
        contentStatus: before.contentStatus,
      },
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
    const updated = await tx.routePage.findUniqueOrThrow({
      where: { path: body.path },
    });
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "cms.page.publish",
        targetType: "route_page",
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
  const cacheRevalidated = revalidateCmsPage(page.path);
  return ok({ page: { ...page, ...publicationReadiness(page) }, cacheRevalidated });
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
