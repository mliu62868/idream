import { preflightContentAssetArchiveV2 } from "@/server/modules/admin/content/assets";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.asset.review");
    const body = await jsonBody(
      request,
      "contentAssetBulkPreflightRequestSchema",
    );
    return preflightContentAssetArchiveV2(body);
  });
}
