import { creativePlacementVerificationRequestSchema } from "@idream/shared/admin";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { verifyCreativePlacement } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; placementId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, placementId } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.placement.publish");
    const body = creativePlacementVerificationRequestSchema.parse(await request.json());
    return verifyCreativePlacement({
      runId: id,
      placementId,
      actor,
      expectedVersion: body.entityVersion,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
