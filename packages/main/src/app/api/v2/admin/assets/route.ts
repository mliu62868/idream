import { listContentAssetsV2 } from "@/server/modules/admin/content/assets";
import {
  actorWithPermission,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "creative.asset.read");
    const query = queryParams(request, "GET /api/v2/admin/assets");
    return listContentAssetsV2(query);
  });
}
