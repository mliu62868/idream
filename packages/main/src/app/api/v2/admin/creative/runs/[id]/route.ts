import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { getCreativeRunDetail } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.run.read");
    return getCreativeRunDetail({ runId: id, actor });
  });
}
