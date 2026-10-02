// SPEC: 站内公告/banner 权威。读 growth.promo.read、写 growth.promo.write；
//       写操作要 reason + typed confirmation，并留审计行。
// INTENT: 存储仍是 AppSetting 里的一个 JSON 数组（零迁移），公开读经
//         `server/announcements/store` 的 activeAnnouncements。
// INVARIANT: 整组 JSON 的读改写与审计共用事务锁；单条版本阻止覆盖陈旧编辑。
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  activeAnnouncements,
  ANNOUNCEMENTS_KEY,
  type Announcement,
  readAnnouncements,
  writeAnnouncements,
} from "@/server/announcements/store";
import {
  actorWithPermission,
  queryParams,
  type AdminActor,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

const PROMO_READ = "growth.promo.read" as const;

const safeExternalHrefRe = /^(https?:)?\/\//i;

function writeAudit(
  tx: Prisma.TransactionClient,
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
  return tx.adminAuditLog.create({
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

async function lockedAnnouncements(tx: Prisma.TransactionClient) {
  // The setting may not exist yet; a row lock alone cannot serialize its first two writers.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"announcements-write"}))`;
  return readAnnouncements(tx);
}

function assertAnnouncementVersion(item: Announcement, expectedVersion: number) {
  if (item.version !== expectedVersion) throw Errors.conflict("Announcement changed. Refresh and reopen it before trying again.", {
    code: "announcement_version_conflict", expectedVersion, actualVersion: item.version,
  });
}

function assertAnnouncementWindow(item: Pick<Announcement, "startsAt" | "endsAt">) {
  if (item.startsAt && item.endsAt && Date.parse(item.startsAt) >= Date.parse(item.endsAt)) {
    throw Errors.badRequest("Announcement end time must be after its start time");
  }
}

// SPEC: 写操作的响应也必须带 serving —— 契约是 .strict()，而且「我刚激活的这条，现在真的在
//       展示吗」正是运营点完按钮最想知道的一件事。
function withServingState(announcement: Announcement) {
  return {
    ...announcement,
    serving: activeAnnouncements([announcement], Date.now()).length === 1,
  };
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
  // INVARIANT: `serving` 走 activeAnnouncements —— 公开端点用的就是这一个函数。
  //            两边共用同一份判据，后台说「在展示」就等于站上真的在展示。
  const servingIds = new Set(activeAnnouncements(page, Date.now()).map((item) => item.id));
  return {
    items: page.map((item) => ({ ...item, serving: servingIds.has(item.id) })),
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
  return executeAdminMutation<AdminV2RequestBody<"announcementCreateRequestSchema+idempotency-key">>(
    "POST /api/v2/admin/announcements", request, {
      params: {},
      target: () => ({ type: "app_setting", id: ANNOUNCEMENTS_KEY }),
      mutate: async (tx, { actor, body }) => {
        if (body.confirmation !== body.title) throw Errors.badRequest("Confirmation did not match announcement title");
        const items = await lockedAnnouncements(tx);
        const announcement: Announcement = {
          id: randomUUID(), version: 1,
          title: body.title, body: body.body, level: body.level, active: body.active,
          startsAt: body.startsAt ?? null, endsAt: body.endsAt ?? null,
          href: normalizeAnnouncementHref(body.href), createdAt: new Date().toISOString(),
        };
        assertAnnouncementWindow(announcement);
        await writeAnnouncements([announcement, ...items], tx);
        await writeAudit(tx, request, actor, {
          action: "growth.announcement.create", targetId: announcement.id, reason: body.reason,
          after: { title: announcement.title, level: announcement.level, active: announcement.active },
        });
        return { announcement: withServingState(announcement) };
      },
    },
  );
}

export async function patchAnnouncement(request: Request, id: string) {
  return executeAdminMutation<AdminV2RequestBody<"announcementPatchRequestSchema+idempotency-key">>(
    "PATCH /api/v2/admin/announcements/:id", request, {
      params: { id }, target: () => ({ type: "announcement", id }), expectedVersion: body => body.entityVersion,
      mutate: async (tx, { actor, body }) => {
        if (body.confirmation !== id) throw Errors.badRequest("Confirmation did not match target");
        const items = await lockedAnnouncements(tx);
        const index = items.findIndex(item => item.id === id);
        if (index < 0) throw Errors.notFound("Announcement not found");
        const before = items[index]!;
        assertAnnouncementVersion(before, body.entityVersion);
        const updated: Announcement = {
          ...before, version: before.version + 1,
          title: body.title ?? before.title, body: body.body ?? before.body,
          level: body.level ?? before.level, active: body.active ?? before.active,
          startsAt: body.startsAt === undefined ? before.startsAt : body.startsAt,
          endsAt: body.endsAt === undefined ? before.endsAt : body.endsAt,
          href: body.href === undefined ? before.href : normalizeAnnouncementHref(body.href),
        };
        assertAnnouncementWindow(updated);
        const next = [...items];
        next[index] = updated;
        await writeAnnouncements(next, tx);
        // Audit every changed field, not only active/level; copy and schedule changes need the same history.
        const changed = (["title", "body", "level", "active", "startsAt", "endsAt", "href"] as const)
          .filter(key => before[key] !== updated[key]);
        await writeAudit(tx, request, actor, {
          action: "growth.announcement.update", targetId: id, reason: body.reason,
          before: Object.fromEntries(changed.map(key => [key, before[key]])),
          after: Object.fromEntries(changed.map(key => [key, updated[key]])),
        });
        return { announcement: withServingState(updated) };
      },
    },
  );
}

export async function deleteAnnouncement(request: Request, id: string) {
  return executeAdminMutation<AdminV2RequestBody<"announcementDeleteRequestSchema+idempotency-key">>(
    "DELETE /api/v2/admin/announcements/:id", request, {
      params: { id }, target: () => ({ type: "announcement", id }), expectedVersion: body => body.entityVersion,
      mutate: async (tx, { actor, body }) => {
        if (body.confirmation !== id) throw Errors.badRequest("Confirmation did not match target");
        const items = await lockedAnnouncements(tx);
        const item = items.find(item => item.id === id);
        if (!item) throw Errors.notFound("Announcement not found");
        assertAnnouncementVersion(item, body.entityVersion);
        await writeAnnouncements(items.filter(item => item.id !== id), tx);
        await writeAudit(tx, request, actor, { action: "growth.announcement.delete", targetId: id, reason: body.reason });
        return { deleted: true as const };
      },
    },
  );
}

function normalizeAnnouncementHref(value: string | null | undefined) {
  if (value == null) return null;
  const href = value.trim();
  if (!href) return null;
  if (href.startsWith("/") || safeExternalHrefRe.test(href)) return href;
  throw Errors.badRequest("Announcement link must be an internal path or http(s) URL");
}
