import { createCoinOffer, listAdminCoinOffers } from "@/server/modules/billing/coin-offers";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request) { return adminV2Route(request, () => listAdminCoinOffers(request)); }
export function POST(request: Request) {
  return adminV2Route(request, async () => createCoinOffer(request,
    await actorWithPermission(request, "config.pricing.write"),
    await jsonBody(request, "adminCoinOfferCreateRequestSchema+idempotency-key"), requireIdempotencyKey(request)));
}
