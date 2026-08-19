import { preflightContentAssetArchive } from "@/server/modules/admin-v2/content/assets";
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
    return preflightContentAssetArchive(body);
  });
}
