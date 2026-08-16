import { billingAdjustment } from "@/server/modules/admin-v2/billing/adjustment";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "billing.ledger.adjust");
    const body = await jsonBody(
      request,
      "adminBillingLedgerAdjustmentRequestSchema+idempotency-key",
    );
    return billingAdjustment(request, actor, body, requireIdempotencyKey(request));
  });
}
