// SPEC: CMS/SEO 内容管理服务层（ADMIN_PHASE3_DESIGN §3）。admin 凭 content.cms.write
//       管理 RoutePage（页面正文 + SEO metadata + 发布状态），公开读路径混合 override。
// INTENT: 复用既有 RoutePage 表（零迁移）；读用 content.read，写用 content.cms.write，
//         reason+typed 确认 + AdminAuditLog，与既有控制面一致。
// INVARIANTS:
//   - path 唯一（RoutePage 主键）；写操作必带 reason(≥3)+typed 确认。
//   - body 仅接 string→unknown 记录（CmsRenderer 读 heading/sections/cta）。
//   - 审计不含敏感明文（CMS 内容是公开页，无明文风险，但仍走统一脱敏）。
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
} from "@/server/modules/admin/service";

const CMS_WRITE = "content.cms.write" as const;
const CONTENT_READ = "content.read" as const;

const contentStatusEnum = z.enum(["template", "draft", "published"]);
const bodySchema = z.record(z.string(), z.unknown());

const createSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^\//, "path must start with /"),
  template: z.string().trim().min(1).max(80).default("article"),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).default(""),
  canonical: z.string().trim().max(512).nullable().optional(),
  body: bodySchema.default({}),
  contentStatus: contentStatusEnum.default("draft"),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const patchSchema = z.object({
  path: z.string().trim().min(1).max(512),
  template: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(500).optional(),
  canonical: z.string().trim().max(512).nullable().optional(),
  body: bodySchema.optional(),
  contentStatus: contentStatusEnum.optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const publishSchema = z.object({
  path: z.string().trim().min(1).max(512),
  contentStatus: contentStatusEnum,
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

function assertConfirmation(value: string, ...accepted: string[]) {
  if (!accepted.includes(value)) throw Errors.badRequest("Confirmation did not match");
}

export async function listCmsPages(request: Request): Promise<Response> {
  await actorWithPermission(request, CONTENT_READ);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const q = url.searchParams.get("q")?.trim();
  const items = await prisma.routePage.findMany({
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
      updatedAt: true,
    },
  });
  return ok({ items });
}

export async function getCmsPage(request: Request): Promise<Response> {
  await actorWithPermission(request, CONTENT_READ);
  const url = new URL(request.url);
  const path = url.searchParams.get("path")?.trim();
  if (!path) throw Errors.badRequest("path query param is required");
  const page = await prisma.routePage.findUnique({ where: { path } });
  if (!page) throw Errors.notFound("Route page not found");
  return ok({ page });
}

export async function createCmsPage(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = createSchema.parse(await jsonBody(request));
  assertConfirmation(body.confirmation, "CMS", body.path);
  const existing = await prisma.routePage.findUnique({ where: { path: body.path } });
  if (existing) throw Errors.badRequest("A page with this path already exists");
  const page = await prisma.routePage.create({
    data: {
      path: body.path,
      template: body.template,
      title: body.title,
      description: body.description,
      canonical: body.canonical ?? null,
      contentStatus: body.contentStatus,
      body: toInputJson(body.body),
    },
  });
  await writeAudit(request, actor, {
    action: "cms.page.create",
    targetType: "route_page",
    targetId: page.path,
    reason: body.reason,
    after: { title: page.title, contentStatus: page.contentStatus, template: page.template },
  });
  return ok({ page });
}

export async function patchCmsPage(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = patchSchema.parse(await jsonBody(request));
  assertConfirmation(body.confirmation, "CMS", body.path);
  const before = await prisma.routePage.findUnique({ where: { path: body.path } });
  if (!before) throw Errors.notFound("Route page not found");
  const page = await prisma.routePage.update({
    where: { path: body.path },
    data: {
      template: body.template,
      title: body.title,
      description: body.description,
      canonical: body.canonical === undefined ? undefined : body.canonical,
      contentStatus: body.contentStatus,
      body: body.body ? toInputJson(body.body) : undefined,
    },
  });
  await writeAudit(request, actor, {
    action: "cms.page.update",
    targetType: "route_page",
    targetId: page.path,
    reason: body.reason,
    before: { title: before.title, contentStatus: before.contentStatus },
    after: { title: page.title, contentStatus: page.contentStatus },
  });
  return ok({ page });
}

export async function publishCmsPage(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, CMS_WRITE);
  const body = publishSchema.parse(await jsonBody(request));
  assertConfirmation(body.confirmation, "PUBLISH", body.path);
  const before = await prisma.routePage.findUnique({ where: { path: body.path } });
  if (!before) throw Errors.notFound("Route page not found");
  const page = await prisma.routePage.update({
    where: { path: body.path },
    data: { contentStatus: body.contentStatus },
  });
  await writeAudit(request, actor, {
    action: "cms.page.publish",
    targetType: "route_page",
    targetId: page.path,
    reason: body.reason,
    before: { contentStatus: before.contentStatus },
    after: { contentStatus: page.contentStatus },
  });
  return ok({ page });
}
