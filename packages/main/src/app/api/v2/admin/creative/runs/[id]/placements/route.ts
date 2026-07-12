import { creativePlacementPublishRequestSchema } from "@idream/shared/admin";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { publishDistributionPlacement } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.placement.publish");
    const body = creativePlacementPublishRequestSchema.parse(await request.json());
    return publishDistributionPlacement({
      runId: id,
      itemId: body.itemId,
      assetId: body.assetId,
      actor,
      expectedVersion: body.entityVersion,
      slot: body.slot,
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
