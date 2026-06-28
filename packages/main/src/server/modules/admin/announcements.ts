// SPEC: 公告/banner 后台 CRUD（ADMIN_PHASE4_DESIGN §3）。操作 AppSetting 数组（零迁移）。
// INTENT: 读 growth.promo.read、写 growth.promo.write（admin only）；写 reason+typed + 审计。
// INVARIANTS: id 由服务端生成（randomUUID）；写后整组覆盖；公开读经 store.activeAnnouncements。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  type Announcement,
  readAnnouncements,
  writeAnnouncements,
} from "@/server/announcements/store";
import { actorWithPermission, jsonBody, writeAudit } from "@/server/modules/admin/service";

const PROMO_READ = "growth.promo.read" as const;
const PROMO_WRITE = "growth.promo.write" as const;

const levelEnum = z.enum(["info", "promo", "warning"]);

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

export async function listAdminAnnouncements(request: Request): Promise<Response> {
  await actorWithPermission(request, PROMO_READ);
  const items = await readAnnouncements();
  return ok({ items });
}

export async function createAnnouncement(request: Request): Promise<Response> {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const body = createSchema.parse(await jsonBody(request));
  if (body.confirmation !== "ANNOUNCE") throw Errors.badRequest("Confirmation did not match");
  const items = await readAnnouncements();
  const announcement: Announcement = {
    id: randomUUID(),
    title: body.title,
    body: body.body,
    level: body.level,
    active: body.active,
    startsAt: body.startsAt ?? null,
    endsAt: body.endsAt ?? null,
    href: body.href ?? null,
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
  if (body.confirmation !== id && body.confirmation !== "ANNOUNCE") {
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
    href: body.href === undefined ? before.href : body.href,
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

// 删除走 DELETE（jsonBody 对 DELETE 返回 {}，故不收 body）：权限门控 + 审计即可（低危、可重建）。
export async function deleteAnnouncement(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, PROMO_WRITE);
  const items = await readAnnouncements();
  if (!items.some((a) => a.id === id)) throw Errors.notFound("Announcement not found");
  await writeAnnouncements(items.filter((a) => a.id !== id));
  await writeAudit(request, actor, {
    action: "growth.announcement.delete",
    targetType: "announcement",
    targetId: id,
  });
  return ok({ deleted: true });
}
