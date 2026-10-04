import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuthCtx, SESSION_COOKIE } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { publicPackAudienceWhere } from "@/server/modules/ourdream/pack-authority";
import {
  activeCustomerUserWhere,
  directCharacterAudienceWhere,
  publicCharacterAudienceWhere,
} from "@/server/modules/ourdream/public-content-audience";

// SPEC: 动态 id 页面对「匿名请求 + 公开面上不存在的对象」返回真 404，不再是 200 软 404。
// INTENT: 只在无会话时判定 —— 私有对象（自己的角色、草稿 Comic）仍要让本人打开，
//   有会话时保持原来的客户端判定。查询条件与对应 v1 读接口的匿名分支一致；
//   DB 读失败时不下 404，留给客户端页面自己报错。
async function notFoundUnlessPublic(exists: () => Promise<unknown>) {
  if ((await cookies()).has(SESSION_COOKIE)) return;
  let found: unknown;
  try {
    found = await exists();
  } catch {
    return;
  }
  if (!found) notFound();
}

export function requirePublicCharacterForAnonymous(id: string) {
  return notFoundUnlessPublic(() =>
    prisma.character.findFirst({
      where: { id, deletedAt: null, ...directCharacterAudienceWhere },
      select: { id: true },
    }),
  );
}

export function requirePublicCreatorForAnonymous(id: string) {
  return notFoundUnlessPublic(() =>
    prisma.user.findFirst({
      where: {
        id,
        ...activeCustomerUserWhere,
        OR: [
          { charactersCreated: { some: publicCharacterAudienceWhere } },
          { comics: { some: { status: "published", visibility: { in: ["public", "unlisted"] } } } },
          { packs: { some: publicPackAudienceWhere() } },
        ],
      },
      select: { id: true },
    }),
  );
}

export function requirePublicComicForAnonymous(id: string) {
  return notFoundUnlessPublic(() =>
    prisma.comic.findFirst({
      where: {
        id,
        status: "published",
        visibility: { in: ["public", "unlisted"] },
        creator: activeCustomerUserWhere,
      },
      select: { id: true },
    }),
  );
}

export function requirePublicPackForAnonymous(id: string, releaseId?: string) {
  return notFoundUnlessPublic(() => prisma.pack.findFirst({ where: {
    id, ...publicPackAudienceWhere(),
    ...(releaseId ? { currentReleaseId: releaseId } : {}),
  }, select: { id: true } }));
}

// SPEC: 编辑器页（/creator-studio/comics/:id、/packs/:id/edit）只对存在、且属于当前登录者
//   的对象渲染；不存在或属于别人一律真 404，而不是 200 + 空白编辑器。
// INTENT: 未登录时对象存在就照常渲染，让客户端页面引导登录 —— 登录前分不出是不是本人的。
//   DB 读失败时不下 404，留给客户端页面自己报错。
async function notFoundUnlessEditable(read: () => Promise<{ creatorId: string | null } | null>) {
  let owner: { creatorId: string | null } | null;
  let viewerId: string | undefined;
  try {
    owner = await read();
    viewerId = owner
      ? (await getAuthCtx(new Request("http://idream.internal/", { headers: await headers() }))).userId
      : undefined;
  } catch {
    return;
  }
  if (!owner || (viewerId && owner.creatorId !== viewerId)) notFound();
}

export function requireEditableComic(id: string) {
  return notFoundUnlessEditable(() => prisma.comic.findFirst({ where: { id }, select: { creatorId: true } }));
}

export function requireEditablePack(id: string) {
  return notFoundUnlessEditable(() => prisma.pack.findFirst({ where: { id }, select: { creatorId: true } }));
}
