import { patchPricingRule } from "@/server/modules/admin-v2/pricing/service";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "config.pricing.write");
    const body = await jsonBody(
      request,
      "adminPricingRulePatchRequestSchema+idempotency-key",
    );
    return patchPricingRule(request, actor, id, body, requireIdempotencyKey(request));
  });
}
