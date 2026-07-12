// SPEC: 公告/banner 后台 CRUD（ADMIN_PHASE4_DESIGN §3）。操作 AppSetting 数组（零迁移）。
// INTENT: 读 growth.promo.read、写 growth.promo.write（admin only）；写 reason+typed + 审计。
// INVARIANTS: id 由服务端生成（randomUUID）；写后整组覆盖；公开读经 store.activeAnnouncements。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";
import {
  type Announcement,
  readAnnouncements,
  writeAnnouncements,
} from "@/server/announcements/store";
import { actorWithPermission, jsonBody, writeAudit } from "@/server/modules/admin/shared/legacy-primitives";

const PROMO_READ = "growth.promo.read" as const;
const PROMO_WRITE = "growth.promo.write" as const;

const levelEnum = z.enum(["info", "promo", "warning"]);
const safeExternalHrefRe = /^(https?:)?\/\//i;

const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2_000),
  level: levelEnum.default("info"),
  active: z.boolean().default(false),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  href: z.string().trim().max(512).nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(2_000).optional(),
  level: levelEnum.optional(),
  active: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  href: z.string().trim().max(512).nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});
const deleteSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000).optional(),
    confirmation: z.string().trim().min(1).max(160),
  })
  .optional();

export async function listAdminAnnouncements(request: Request): Promise<Response> {
  await actorWithPermission(request, PROMO_READ);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().toLocaleLowerCase() || undefined;
  const level = url.searchParams.get("level")?.trim() || undefined;
  const activeParam = url.searchParams.get("active");
  const active = activeParam === "true" ? true : activeParam === "false" ? false : undefined;
  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") ?? "25", 10) || 25));
  const queryIdentity = { search, level, active, sort: "created_desc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "announcements", queryIdentity)
    : undefined;
  const cursorCreatedAt = cursorKeys ? announcementCursorDate(cursorKeys[0]) : null;
  const cursorId = cursorKeys ? announcementCursorId(cursorKeys[1]) : null;
  const matches = (await readAnnouncements())
    .filter((item) => !search || [item.id, item.title, item.body, item.href ?? ""].some((value) => value.toLocaleLowerCase().includes(search)))
    .filter((item) => !level || item.level === level)
    .filter((item) => active === undefined || item.active === active)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .filter((item) => !cursorCreatedAt || item.createdAt < cursorCreatedAt || (item.createdAt === cursorCreatedAt && item.id < cursorId!));
  const page = matches.slice(0, limit);
  const hasNextPage = matches.length > limit;
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("announcements", queryIdentity, [last.createdAt, last.id])
        : null,
    },
  });
}

function announcementCursorDate(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw Errors.badRequest("announcements cursor timestamp is invalid");
  }
  return value;
}

function announcementCursorId(value: unknown) {
  if (typeof value !== "string" || !value) throw Errors.badRequest("announcements cursor id is invalid");
  return value;
}

export async function createAnnouncement(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = createSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.title) {
    throw Errors.badRequest("Confirmation did not match announcement title");
  }
  const href = normalizeAnnouncementHref(body.href);
  const items = await readAnnouncements();
  const announcement: Announcement = {
    id: randomUUID(),
    title: body.title,
    body: body.body,
    level: body.level,
    active: body.active,
    startsAt: body.startsAt ?? null,
    endsAt: body.endsAt ?? null,
    href,
    createdAt: new Date().toISOString(),
  };
  await writeAnnouncements([announcement, ...items]);
  await writeAudit(request, actor, {
    action: "growth.announcement.create",
    targetType: "announcement",
    targetId: announcement.id,
    reason: body.reason,
    after: { title: announcement.title, level: announcement.level, active: announcement.active },
  });
  return ok({ announcement });
}

export async function patchAnnouncement(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = patchSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match target");
  }
  const items = await readAnnouncements();
  const index = items.findIndex((a) => a.id === id);
  if (index < 0) throw Errors.notFound("Announcement not found");
  const before = items[index];
  const updated: Announcement = {
    ...before,
    title: body.title ?? before.title,
    body: body.body ?? before.body,
    level: body.level ?? before.level,
    active: body.active ?? before.active,
    startsAt: body.startsAt === undefined ? before.startsAt : body.startsAt,
    endsAt: body.endsAt === undefined ? before.endsAt : body.endsAt,
    href: body.href === undefined ? before.href : normalizeAnnouncementHref(body.href),
  };
  const next = [...items];
  next[index] = updated;
  await writeAnnouncements(next);
  await writeAudit(request, actor, {
    action: "growth.announcement.update",
    targetType: "announcement",
    targetId: id,
    reason: body.reason,
    before: { active: before.active, level: before.level },
    after: { active: updated.active, level: updated.level },
  });
  return ok({ announcement: updated });
}

export async function deleteAnnouncement(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = await readDeleteBody(request);
  if (!body?.confirmation || body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match target");
  }
  const items = await readAnnouncements();
  if (!items.some((a) => a.id === id)) throw Errors.notFound("Announcement not found");
  await writeAnnouncements(items.filter((a) => a.id !== id));
  await writeAudit(request, actor, {
    action: "growth.announcement.delete",
    targetType: "announcement",
    targetId: id,
    reason: body?.reason,
  });
  return ok({ deleted: true });
}

async function readDeleteBody(request: Request): Promise<z.infer<typeof deleteSchema>> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  return deleteSchema.parse(JSON.parse(text));
}

function normalizeAnnouncementHref(value: string | null | undefined) {
  if (value == null) return null;
  const href = value.trim();
  if (!href) return null;
  if (href.startsWith("/") || safeExternalHrefRe.test(href)) return href;
  throw Errors.badRequest("Announcement link must be an internal path or http(s) URL");
}
