import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { getCreativeRunDetail } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { creativeRunDetailSchema } from "@idream/shared/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "creative.run.read");
    return creativeRunDetailSchema.parse(await getCreativeRunDetail({ runId: id, actor }));
  });
}
