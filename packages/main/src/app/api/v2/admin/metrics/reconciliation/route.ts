import { getMetricReconciliationReport } from "@/server/modules/admin-v2/metrics/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return getMetricReconciliationReport(request);
}
