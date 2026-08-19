import {
  createRedeemCode,
  listRedeemCodes,
} from "@/server/modules/admin-v2/promo/service";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listRedeemCodes(request));
}

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "growth.promo.write");
    const body = await jsonBody(
      request,
      "adminRedeemCodeCreateRequestSchema+idempotency-key",
    );
    return createRedeemCode(request, actor, body, requireIdempotencyKey(request));
  });
}
