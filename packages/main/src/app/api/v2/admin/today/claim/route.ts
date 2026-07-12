import { claimTodayWorkItem } from "@/server/modules/admin-v2/today/claim";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return adminV2Route(() => claimTodayWorkItem(request));
}
