import {
  creativePlacementVerificationResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { verifyCreativePlacement } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; placementId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, placementId } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "creative.placement.publish");
    const body = await jsonBody(request, "creativePlacementVerificationRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "creative.placement.verify",
      target: { type: "media_asset_placement", id: placementId },
      expectedVersion: body.entityVersion,
      payload: { runId: id, ...body },
      mutate: async (tx) => creativePlacementVerificationResultSchema.parse(
        await verifyCreativePlacement({
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
