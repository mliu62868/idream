import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { getMetricQualityReport } from "@/server/modules/admin-v2/metrics/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return adminV2Route(request, () => getMetricQualityReport(request));
}
