import { runCharacterPerformanceBackfill } from "@/server/modules/admin-v2/characters/performance-facts";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(() => runCharacterPerformanceBackfill(request));
}
