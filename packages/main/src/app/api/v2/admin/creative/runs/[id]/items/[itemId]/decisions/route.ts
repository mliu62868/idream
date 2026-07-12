import {
  creativeReviewDecisionRequestSchema,
  creativeReviewDecisionResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { recordCreativeReviewDecision } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; itemId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, itemId } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.run.review");
    const body = creativeReviewDecisionRequestSchema.parse(await request.json());
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "creative.review.decision",
      target: { type: "creative_run_item", id: itemId },
      expectedVersion: body.entityVersion,
      payload: { runId: id, ...body },
      mutate: async (tx) => creativeReviewDecisionResultSchema.parse(
        await recordCreativeReviewDecision({
          runId: id,
          itemId,
          actor,
          expectedVersion: body.entityVersion,
          decision: body.decision,
          identityConsistency: body.identityConsistency,
          score: body.score,
          reason: body.reason,
          requestId,
        }, tx),
      ),
    });
  });
}
