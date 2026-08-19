import { listReferrals } from "@/server/modules/admin-v2/promo/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listReferrals(request));
}
