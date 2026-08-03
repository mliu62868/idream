import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { getTodayAllWork } from "@/server/modules/admin-v2/today/query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return adminV2Route(request, () => getTodayAllWork(request));
}
