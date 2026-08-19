// SPEC: 站内公告/banner 权威。读 growth.promo.read、写 growth.promo.write；
//       写操作要 reason + typed confirmation，并留审计行。
// INTENT: 存储仍是 AppSetting 里的一个 JSON 数组（零迁移），公开读经
//         `server/announcements/store` 的 activeAnnouncements。
// INVARIANT: id 由服务端生成；写后整组覆盖。
import { randomUUID } from "node:crypto";
import { Errors } from "@/server/lib/errors";
import { prisma } from "@/server/lib/db";
import {
  type Announcement,
  readAnnouncements,
  writeAnnouncements,
} from "@/server/announcements/store";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

const PROMO_READ = "growth.promo.read" as const;
const PROMO_WRITE = "growth.promo.write" as const;

const safeExternalHrefRe = /^(https?:)?\/\//i;

function writeAudit(
  request: Request,
  actor: AdminActor,
  input: {
    action: string;
    targetId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  return prisma.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.action,
      targetType: "announcement",
      targetId: input.targetId,
      reason: input.reason,
      ...(input.before === undefined ? {} : { before: toInputJson(input.before) }),
      ...(input.after === undefined ? {} : { after: toInputJson(input.after) }),
      requestId: request.headers.get("x-request-id") ?? randomUUID(),
    },
  });
}

export async function listAdminAnnouncements(request: Request) {
  await actorWithPermission(request, PROMO_READ);
  const query = queryParams(request, "GET /api/v2/admin/announcements");
  const search = query.search?.toLocaleLowerCase();
  const active = query.active === undefined ? undefined : query.active === "true";
  const queryIdentity = { search, level: query.level, active, sort: "created_desc" };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "announcements", queryIdentity)
    : undefined;
  const cursorCreatedAt = cursorKeys ? announcementCursorDate(cursorKeys[0]) : null;
  const cursorId = cursorKeys ? announcementCursorId(cursorKeys[1]) : null;
  const matches = (await readAnnouncements())
    .filter((item) =>
      !search ||
      [item.id, item.title, item.body, item.href ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(search),
      ))
    .filter((item) => !query.level || item.level === query.level)
    .filter((item) => active === undefined || item.active === active)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .filter((item) =>
      !cursorCreatedAt ||
      item.createdAt < cursorCreatedAt ||
      (item.createdAt === cursorCreatedAt && item.id < cursorId!));
  const page = matches.slice(0, query.limit);
  const hasNextPage = matches.length > query.limit;
  const last = page.at(-1);
  return {
    items: page,
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("announcements", queryIdentity, [last.createdAt, last.id])
        : null,
    },
  };
}

function announcementCursorDate(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw Errors.badRequest("announcements cursor timestamp is invalid");
  }
  return value;
}

function announcementCursorId(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("announcements cursor id is invalid");
  }
  return value;
}

export async function createAnnouncement(request: Request) {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = await jsonBody(request, "announcementCreateRequestSchema");
  if (body.confirmation !== body.title) {
    throw Errors.badRequest("Confirmation did not match announcement title");
  }
  const items = await readAnnouncements();
  const announcement: Announcement = {
    id: randomUUID(),
    title: body.title,
    body: body.body,
    level: body.level,
    active: body.active,
    startsAt: body.startsAt ?? null,
    endsAt: body.endsAt ?? null,
    href: normalizeAnnouncementHref(body.href),
    createdAt: new Date().toISOString(),
  };
  await writeAnnouncements([announcement, ...items]);
  await writeAudit(request, actor, {
    action: "growth.announcement.create",
    targetId: announcement.id,
    reason: body.reason,
    after: {
      title: announcement.title,
      level: announcement.level,
      active: announcement.active,
    },
  });
  return { announcement };
}

export async function patchAnnouncement(request: Request, id: string) {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = await jsonBody(request, "announcementPatchRequestSchema");
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match target");
  }
  const items = await readAnnouncements();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw Errors.notFound("Announcement not found");
  const before = items[index]!;
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
    targetId: id,
    reason: body.reason,
    before: { active: before.active, level: before.level },
    after: { active: updated.active, level: updated.level },
  });
  return { announcement: updated };
}

export async function deleteAnnouncement(request: Request, id: string) {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = await jsonBody(request, "announcementDeleteRequestSchema");
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match target");
  }
  const items = await readAnnouncements();
  if (!items.some((item) => item.id === id)) {
    throw Errors.notFound("Announcement not found");
  }
  await writeAnnouncements(items.filter((item) => item.id !== id));
  await writeAudit(request, actor, {
    action: "growth.announcement.delete",
    targetId: id,
    reason: body.reason,
  });
  return { deleted: true as const };
}

function normalizeAnnouncementHref(value: string | null | undefined) {
  if (value == null) return null;
  const href = value.trim();
  if (!href) return null;
  if (href.startsWith("/") || safeExternalHrefRe.test(href)) return href;
  throw Errors.badRequest("Announcement link must be an internal path or http(s) URL");
}
