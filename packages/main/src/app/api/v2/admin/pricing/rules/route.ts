import {
  createPricingRule,
  listPricingRules,
} from "@/server/modules/admin-v2/pricing/service";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listPricingRules(request));
}

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "config.pricing.write");
    const body = await jsonBody(
      request,
      "adminPricingRuleCreateRequestSchema+idempotency-key",
    );
    return createPricingRule(request, actor, body, requireIdempotencyKey(request));
  });
}
