import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { getTodayProjection } from "@/server/modules/admin-v2/today/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return adminV2Route(request, () => getTodayProjection(request));
}
