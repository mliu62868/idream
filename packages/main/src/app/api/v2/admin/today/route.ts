import { getTodayProjection } from "@/server/modules/admin-v2/today/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return getTodayProjection(request);
}
