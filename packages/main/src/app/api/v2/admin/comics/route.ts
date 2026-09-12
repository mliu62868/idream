import { listAdminComics } from "@/server/modules/ourdream/comics";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.asset.read");
    queryParams(request, "GET /api/v2/admin/comics");
    return listAdminComics(request);
  });
}
