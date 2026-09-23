import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { SESSION_COOKIE } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
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
