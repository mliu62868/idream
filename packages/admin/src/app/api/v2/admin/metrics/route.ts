import { proxyToMain } from "../../../../../server/main-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return proxyToMain(request, "/api/v2/admin/metrics");
}
