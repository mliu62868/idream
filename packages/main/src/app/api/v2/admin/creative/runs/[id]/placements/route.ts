import {
  creativePlacementPublishResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { publishDistributionPlacement } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.placement.publish");
    const body = await jsonBody(request, "creativePlacementPublishRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "creative.placement.publish",
      target: { type: "creative_run", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => creativePlacementPublishResultSchema.parse(
        await publishDistributionPlacement({
          runId: id,
          itemId: body.itemId,
          assetId: body.assetId,
          actor,
          expectedVersion: body.entityVersion,
          slot: body.slot,
          targetType: body.targetType,
          targetId: body.targetId,
          eyebrow: body.eyebrow,
          title: body.title,
          ctaLabel: body.ctaLabel,
          href: body.href,
          reason: body.reason,
          requestId,
        }, tx),
      ),
    });
  });
}
