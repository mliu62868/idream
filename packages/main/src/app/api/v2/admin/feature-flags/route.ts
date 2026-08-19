import { listFeatureFlags } from "@/server/modules/admin-v2/config/feature-flags";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listFeatureFlags(request));
}
