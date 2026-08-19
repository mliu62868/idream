import { estimateProductionBatch } from "@/server/modules/admin-v2/content/production";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.asset.read");
    const body = await jsonBody(request, "contentProductionEstimateRequestSchema");
    return estimateProductionBatch(body);
  });
}
