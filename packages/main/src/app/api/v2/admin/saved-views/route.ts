import { createSavedViewV2, listSavedViewsV2 } from "@/server/modules/admin-v2/collaboration/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(async () => {
    await actorWithPermission(request, "dashboard.read");
    return listSavedViewsV2(request);
  });
}

export function POST(request: Request) {
  return adminV2Route(async () => {
    await actorWithPermission(request, "dashboard.read");
    return createSavedViewV2(request);
  });
}
