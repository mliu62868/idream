// SPEC: 站内公告存储（ADMIN_PHASE4_DESIGN §3）。零迁移：存 AppSetting key=announcements 的数组。
// INTENT: 共享层——admin CRUD 与公开读都经此，避免 admin↔ourdream 循环依赖。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";

export type AnnouncementLevel = "info" | "promo" | "warning";

export type Announcement = {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  href: string | null;
  createdAt: string;
};

export const ANNOUNCEMENTS_KEY = "announcements";

function isAnnouncement(value: unknown): value is Announcement {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

export async function readAnnouncements(): Promise<Announcement[]> {
  const setting = await prisma.appSetting.findUnique({ where: { key: ANNOUNCEMENTS_KEY } });
  const value = setting?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items.filter(isAnnouncement) : [];
}

export async function writeAnnouncements(items: Announcement[]): Promise<void> {
  const value = { items } as unknown as Prisma.InputJsonValue;
  await prisma.appSetting.upsert({
    where: { key: ANNOUNCEMENTS_KEY },
    update: { value },
    create: { key: ANNOUNCEMENTS_KEY, value },
  });
}

// 纯函数：active 且在 [startsAt, endsAt] 窗口内（缺省即恒显）。
export function activeAnnouncements(items: Announcement[], nowMs: number): Announcement[] {
  return items.filter((a) => {
    if (!a.active) return false;
    if (a.startsAt && Date.parse(a.startsAt) > nowMs) return false;
    if (a.endsAt && Date.parse(a.endsAt) < nowMs) return false;
    return true;
  });
}
