import { changeCoinOfferState } from "@/server/modules/billing/coin-offers";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => changeCoinOfferState(request,
    await actorWithPermission(request, "config.pricing.write"), (await context.params).id,
    await jsonBody(request, "adminCoinOfferStateRequestSchema+idempotency-key"), requireIdempotencyKey(request)));
}
