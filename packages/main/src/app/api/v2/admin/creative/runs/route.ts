import { actorWithPermission } from "@/server/modules/admin/service";
import { listCreativeRuns } from "@/server/modules/admin-v2/creative/workflow";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.run.read");
    return listCreativeRuns({ requestUrl: request.url, actor });
  });
}
