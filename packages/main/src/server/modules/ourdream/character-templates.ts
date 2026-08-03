import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";

// SPEC: GET /v1/character-templates —— 前台创建页拉取可用角色模板。仅 isActive，按 sortOrder。
// INTENT: 这是**前台**公开只读投影，不要求 admin 权限，所以它住在 ourdream 而不是
//         modules/admin/**。此前它和 admin 的模板 CRUD 同住一个文件，导致一条前台路由
//         反向 import admin 模块 —— 依赖方向是错的，且让"公开只读"这个事实取决于
//         阅读者是否注意到那一行注释。
// INVARIANT: select 是白名单，不是黑名单。isActive / createdById / 审计字段一律不出站；
//            要加字段就显式加到 select 里，别改成整行返回。
export async function listActiveTemplates(): Promise<Response> {
  const items = await prisma.characterTemplate.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      summary: true,
      gender: true,
      style: true,
      appearance: true,
      advancedDetails: true,
      tags: true,
      coverAssetId: true,
    },
  });
  return ok({ items });
}
