import {
  creativePlacementWithdrawalResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { withdrawCreativePlacement } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; placementId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, placementId } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "creative.placement.publish");
    const body = await jsonBody(request, "creativePlacementWithdrawalRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "creative.placement.withdraw",
      target: { type: "media_asset_placement", id: placementId },
      expectedVersion: body.entityVersion,
      payload: { runId: id, ...body },
      mutate: async (tx) => creativePlacementWithdrawalResultSchema.parse(
        await withdrawCreativePlacement({
          runId: id,
          placementId,
          actor,
          expectedVersion: body.entityVersion,
          reason: body.reason,
          requestId,
        }, tx),
      ),
    });
  });
}
