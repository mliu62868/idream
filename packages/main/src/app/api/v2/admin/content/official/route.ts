import {
  createOfficialCharacter,
  listOfficialCharacters,
} from "@/server/modules/admin-v2/content/official";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.official.write");
    return listOfficialCharacters(queryParams(request, "GET /api/v2/admin/content/official"));
  });
}

// INTENT: 不走 executeAdminMutation —— `createCharacterProject` 自带幂等（按 actor +
// Idempotency-Key 解析既有命令并原样重放），再套一层原子命令只会出现两个互不知情的
// 幂等域。这里只负责把 header 交给它。
export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.official.write");
    const body = await jsonBody(
      request,
      "contentOfficialCreateRequestSchema+idempotency-key",
    );
    return createOfficialCharacter({
      request,
      actor,
      idempotencyKey: requireIdempotencyKey(request),
      body,
    });
  });
}
