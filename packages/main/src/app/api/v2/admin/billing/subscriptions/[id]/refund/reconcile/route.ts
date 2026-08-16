import { reconcileSubscriptionRefund } from "@/server/modules/admin-v2/billing/refund";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "billing.subscription.refund");
    const body = await jsonBody(
      request,
      "adminSubscriptionRefundRequestSchema+idempotency-key",
    );
    return reconcileSubscriptionRefund(
      request,
      actor,
      id,
      body,
      requireIdempotencyKey(request),
    );
  });
}
